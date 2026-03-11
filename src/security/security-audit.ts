import {
  generateX25519KeyPair,
  computeDH,
  encrypt,
  decrypt,
  X3DHKeyBundle,
  performX3DHAsInitiator,
  DoubleRatchet,
  createBloomFilterForCRL,
  isRevoked,
} from '../crypto';
import {
  generateKeyPair,
  SignJWT,
  jwtVerify,
  generateDPoPKeyPair,
  createDPoPProof,
  verifyDPoPProof,
  createNonceManager,
  issueNonce,
  validateNonce,
  TokenManager,
  CircuitBreaker,
  DPoPServer,
  createDPoPAuthHeader,
} from '../auth';
import { createEventEnvelope, isEventEnvelope } from '../utils/EventEnvelope';
import { createEventSourcingProxy, InMemoryEventStore } from '../utils/EventSourcingProxy';
import { createValidator, SignalE2EEAgent, TokenAuthority } from '../index';

export interface SecurityCheckResult {
  name: string;
  passed: boolean;
  details: string;
}

export interface SecurityAuditReport {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  checks: SecurityCheckResult[];
}

function ok(name: string, details: string): SecurityCheckResult {
  return { name, passed: true, details };
}

function fail(name: string, details: string): SecurityCheckResult {
  return { name, passed: false, details };
}

async function runCheck(name: string, fn: () => Promise<string> | string): Promise<SecurityCheckResult> {
  try {
    const details = await fn();
    return ok(name, details);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro desconhecido';
    return fail(name, message);
  }
}

export async function runFullSecurityAudit(): Promise<SecurityAuditReport> {
  const checks: SecurityCheckResult[] = [];

  checks.push(await runCheck('Crypto: DH simétrico', () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();
    const sa = computeDH(a.privateKey, b.publicKey);
    const sb = computeDH(b.privateKey, a.publicKey);
    if (Buffer.compare(Buffer.from(sa), Buffer.from(sb)) !== 0) {
      throw new Error('Shared secret inconsistente');
    }
    return 'Shared secret consistente entre pares';
  }));

  checks.push(await runCheck('Crypto: cifragem autenticada rejeita adulteração', () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const encrypted = encrypt('payload-secreto', key);
    encrypted.ciphertext[0] ^= 0xff;
    let tamperingDetected = false;
    try {
      decrypt(encrypted.ciphertext, key, encrypted.nonce);
    } catch {
      tamperingDetected = true;
    }
    if (!tamperingDetected) throw new Error('Ciphertext adulterado foi aceito');
    return 'Adulteração detectada corretamente';
  }));

  checks.push(await runCheck('X3DH + Double Ratchet: handshake e transporte', () => {
    const aliceIdentity = generateX25519KeyPair();
    const aliceEphemeral = generateX25519KeyPair();
    const bobBundle = new X3DHKeyBundle();

    const ssAlice = performX3DHAsInitiator(aliceIdentity, aliceEphemeral, bobBundle.getPublicBundle());
    const ssBob = bobBundle.performX3DHAsReceiver(aliceEphemeral.publicKey, aliceIdentity.publicKey, true);

    if (Buffer.compare(Buffer.from(ssAlice), Buffer.from(ssBob)) !== 0) {
      throw new Error('Handshake X3DH resultou em segredos diferentes');
    }

    const aliceRatchet = new DoubleRatchet();
    const bobRatchet = new DoubleRatchet();
    const shared = crypto.getRandomValues(new Uint8Array(32));
    const bobPublic = bobRatchet.getPublicKey();
    aliceRatchet.initializeAsAlice(shared, bobPublic);
    bobRatchet.initializeAsBob(shared);

    const msg = aliceRatchet.ratchetEncrypt('mensagem ultra sensível');
    const plain = bobRatchet.ratchetDecrypt(msg.header, msg.ciphertext, msg.nonce);
    if (plain !== 'mensagem ultra sensível') {
      throw new Error('Falha na troca E2EE via ratchet');
    }

    bobBundle.destroy();
    aliceRatchet.destroy();
    bobRatchet.destroy();

    return 'Handshake X3DH consistente e transmissão ratchet protegida';
  }));

  checks.push(await runCheck('JWT: assinatura e claims de controle', async () => {
    const { publicKey, privateKey } = generateKeyPair('EdDSA');
    const jwt = await new SignJWT({ scope: 'agent:execute' })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setIssuer('urn:test')
      .setAudience('urn:agents')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

    const verified = await jwtVerify(jwt, publicKey, { issuer: 'urn:test', audience: 'urn:agents' });
    if (verified.payload.scope !== 'agent:execute') {
      throw new Error('Claim de autorização divergente');
    }

    return 'JWT assinado e validado com issuer/audience';
  }));

  checks.push(await runCheck('DPoP: valida binding de método/URL', async () => {
    const pair = generateDPoPKeyPair('EdDSA');
    const proof = await createDPoPProof(pair, { method: 'POST', url: 'https://api.local/resource' });

    const valid = await verifyDPoPProof(proof.jwt, {
      requiredMethod: 'POST',
      requiredUrl: 'https://api.local/resource',
    });
    if (!valid.valid) throw new Error(valid.error || 'Proof válida rejeitada');

    const invalid = await verifyDPoPProof(proof.jwt, {
      requiredMethod: 'GET',
      requiredUrl: 'https://api.local/resource',
    });
    if (invalid.valid) throw new Error('Proof reaproveitada com método incorreto');

    return 'Binding contextual de requisição aplicado';
  }));

  checks.push(await runCheck('Nonce one-time: bloqueia replay', () => {
    const manager = createNonceManager(30);
    const nonce = issueNonce(manager, 'client-a');

    const first = validateNonce(manager, 'client-a', nonce);
    const second = validateNonce(manager, 'client-a', nonce);

    if (!first || second) {
      throw new Error('Regra one-time nonce não respeitada');
    }
    return 'Nonce validado uma única vez';
  }));

  checks.push(await runCheck('TokenManager latching: refresh único em concorrência', async () => {
    const manager = new TokenManager({ refreshThresholdSeconds: 999999, maxRetries: 1, baseDelayMs: 1 });
    let refreshCalls = 0;
    manager.setRefreshFn(async () => {
      refreshCalls += 1;
      await Bun.sleep(25);
      return { token: `t-${refreshCalls}`, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    });

    const [t1, t2, t3] = await Promise.all([manager.getToken(), manager.getToken(), manager.getToken()]);
    if (refreshCalls !== 1 || t1 !== t2 || t2 !== t3) {
      throw new Error('Latching não consolidou chamadas concorrentes');
    }

    return 'Concorrência consolidada em 1 refresh';
  }));

  checks.push(await runCheck('CircuitBreaker: abre após falhas e recupera', async () => {
    const breaker = new CircuitBreaker({ threshold: 2, resetTimeout: 50, monitoringPeriod: 1000 });
    const explode = () => { throw new Error('boom'); };

    try { await breaker.execute(explode); } catch {}
    try { await breaker.execute(explode); } catch {}

    let openBlocked = false;
    try {
      await breaker.execute(async () => 'ok');
    } catch {
      openBlocked = true;
    }

    if (!openBlocked) {
      throw new Error('Circuit não abriu após threshold');
    }

    await Bun.sleep(60);
    await breaker.execute(async () => 'ok');
    await breaker.execute(async () => 'ok');
    const recovered = await breaker.execute(async () => 'ok');
    if (recovered !== 'ok' || breaker.getState() !== 'CLOSED') throw new Error('Circuit não recuperou no half-open');

    return 'Circuit breaker protegeu e retornou ao normal';
  }));

  checks.push(await runCheck('DPoPServer: detecta replay de JTI', async () => {
    const server = new DPoPServer({ requireAth: false });
    const pair = generateDPoPKeyPair('EdDSA');
    const proof = await createDPoPProof(pair, { method: 'GET', url: 'https://svc/a' });
    const header = createDPoPAuthHeader('opaque', proof.jwt);

    const first = await server.verifyDPoPAuthHeader(header, { requiredMethod: 'GET', requiredUrl: 'https://svc/a' });
    const second = await server.verifyDPoPAuthHeader(header, { requiredMethod: 'GET', requiredUrl: 'https://svc/a' });

    if (!first.valid || second.valid) {
      throw new Error('Replay de JTI não foi bloqueado');
    }

    return 'Requisição duplicada bloqueada por replay protection';
  }));

  checks.push(await runCheck('Agent API: sessão E2EE ponta-a-ponta', async () => {
    const authority = new TokenAuthority();
    const alice = new SignalE2EEAgent('alice' as any, authority);
    const bob = new SignalE2EEAgent('bob' as any, authority);

    await alice.initialize();
    await bob.initialize();
    alice.registerPeerBundle('bob', bob.getPublicKeyBundle());

    const eph = await alice.establishSession('bob');
    await bob.acceptSession('alice', alice.getIdentityPublicKey(), eph);

    const wire = await alice.sendMessage('bob', 'teste integrado');
    const text = await bob.receiveMessage(wire);

    alice.destroy();
    bob.destroy();

    if (text !== 'teste integrado') {
      throw new Error('Fluxo de agente não preservou mensagem');
    }

    return 'Agentes autenticaram e trocaram mensagem E2EE';
  }));

  checks.push(await runCheck('Schema validator: safeParse e parse', () => {
    const validator = createValidator<{ id: string; critical: boolean }>(
      {
        id: (v) => typeof v === 'string' && v.length > 0,
        critical: (v) => typeof v === 'boolean',
      },
      'SecurityPayload'
    );

    const parsed = validator.parse({ id: 'x-1', critical: true });
    if (parsed.id !== 'x-1' || parsed.critical !== true) {
      throw new Error('parse não retornou payload esperado');
    }

    const invalid = validator.safeParse({ id: '', critical: true });
    if (invalid.success) throw new Error('safeParse aceitou payload inválido');

    return 'Validação estrita aplicada em cenários válidos e inválidos';
  }));

  checks.push(await runCheck('BloomFilter CRL: revogado positivo e não-revogado negativo', async () => {
    const filter = createBloomFilterForCRL(['did:agent:red-team'], 0.01);
    const revoked = await isRevoked('did:agent:red-team', filter);
    const allowed = await isRevoked('did:agent:blue-team', filter);

    if (!revoked || allowed) {
      throw new Error('Política de revogação inconsistentes');
    }

    return 'CRL probabilística funcionou como esperado';
  }));

  checks.push(await runCheck('EventEnvelope + EventSourcingProxy: evidência persistida', async () => {
    const envelope = createEventEnvelope({
      eventType: 'security.audit.executed',
      aggregateId: 'audit-1',
      aggregateType: 'SecurityAudit',
      agentId: 'auditor-1' as any,
      payload: { ok: true },
    });

    if (!isEventEnvelope(envelope)) {
      throw new Error('Envelope criado não respeita estrutura esperada');
    }

    const eventStore = new InMemoryEventStore();
    const target = {
      async run(action: string) {
        return `done:${action}`;
      },
    };

    const proxy = createEventSourcingProxy(target, {
      agentId: 'auditor-1' as any,
      aggregateType: 'AuditRunner',
      eventStore,
      logEvents: false,
      enableEvidence: true,
    }, ['run']);

    const result = await proxy.run('scan');
    const events = await eventStore.getEvents('AuditRunner-auditor-1');

    if (result !== 'done:scan' || events.length === 0) {
      throw new Error('Evento não persistido pelo proxy');
    }

    return 'Envelope e proxy garantiram trilha de auditoria';
  }));

  const passedChecks = checks.filter((check) => check.passed).length;

  return {
    totalChecks: checks.length,
    passedChecks,
    failedChecks: checks.length - passedChecks,
    checks,
  };
}
