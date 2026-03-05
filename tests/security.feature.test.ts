/**
 * Especificação BDD - Comunicação Segura entre Agentes (@purecore/agent2trust)
 */

import { Feature, Scenario, Given, When, Then } from '../packages/one-proof-4-all';
import { expect } from 'bun:test';
import {
  SignalE2EEAgent,
  TokenAuthority,
  verifyDPoPProof,
  createBloomFilterForCRL,
  isRevoked,
} from '../src/index';
import { AgentIdStamp } from '../src/types/index';

Feature('Comunicação E2EE (End-to-End Encryption) entre Agentes', () => {
  
  Scenario('Alice e Bob estabelecem uma sessão segura e trocam mensagens', async () => {
    let authority: TokenAuthority = null!;
    let alice: SignalE2EEAgent = null!;
    let bob: SignalE2EEAgent = null!;
    let encryptedMessage: any = null!;
    let decryptedText: string = null!;

    await Given('que Alice e Bob são agentes registrados na autoridade de tokens', async () => {
      authority = new TokenAuthority();
      alice = new SignalE2EEAgent('alice' as any, authority);
      bob = new SignalE2EEAgent('bob' as any, authority);
      
      await alice.initialize();
      await bob.initialize();

      expect(alice.agentId).toBe(AgentIdStamp.of('alice'));
      expect(bob.agentId).toBe(AgentIdStamp.of('bob'));
    });

    await When('Alice obtém o bundle de Bob e estabelece uma sessão segura', async () => {
      const bobBundle = bob.getPublicKeyBundle();
      alice.registerPeerBundle('bob', bobBundle);
      
      const aliceEphemeralKey = await alice.establishSession('bob');
      
      // Bob aceita a sessão
      await bob.acceptSession(
        'alice',
        alice.getIdentityPublicKey(),
        aliceEphemeralKey
      );
    });

    await When('Alice envia a mensagem "Segredo de Estado" para Bob', async () => {
      encryptedMessage = await alice.sendMessage('bob', 'Segredo de Estado');
      expect(encryptedMessage).toBeDefined();
    });

    await Then('Bob deve ser capaz de decriptar a mensagem e ver "Segredo de Estado"', async () => {
      decryptedText = await bob.receiveMessage(encryptedMessage);
      expect(decryptedText).toBe('Segredo de Estado');
    });

    // Cleanup
    alice.destroy();
    bob.destroy();
  });

  Scenario('Segurança de Identidade com Thumbprints', async () => {
    let alice: SignalE2EEAgent = null!;
    let thumbprint: string = null!;

    await Given('que Alice inicializou suas chaves de identidade', async () => {
      const authority = new TokenAuthority();
      alice = new SignalE2EEAgent('alice' as any, authority);
      await alice.initialize();
    });

    await When('Alice gera seu thumbprint de identidade', () => {
      thumbprint = alice.getIdentityThumbprint();
    });

    await Then('o thumbprint deve ser uma string Base64URL de 43 caracteres', () => {
      expect(thumbprint).toBeDefined();
      expect(thumbprint).toHaveLength(43);
      // Regex para base64url
      expect(thumbprint).toMatch(/^[a-zA-Z0-9_-]+$/);
    });

    alice.destroy();
  });
});

Feature('Autorização Determinística com DPoP (RFC 9449)', () => {
  Scenario('Agente Alice gera prova DPoP para uma requisição de API', async () => {
    let alice: SignalE2EEAgent = null!;
    let proof: any = null!;
    const authority = new TokenAuthority();

    await Given('que Alice é um agente autenticado com um par de chaves DPoP', async () => {
      alice = new SignalE2EEAgent('alice' as any, authority);
      await alice.initialize();
      const keyPair = alice.getDPoPPublicKey();
      expect(keyPair).toBeDefined();
    });

    await When('Alice solicita acesso a um recurso protegido via POST', async () => {
      proof = await alice.createDPoPProof('POST', 'https://api.agent.network/v1/action');
    });

    await Then('a prova DPoP deve ser um JWT válido contendo as claims htm e htu', async () => {
      expect(proof.jwt).toBeDefined();
      const verification = await verifyDPoPProof(proof.jwt, {
        requiredMethod: 'POST',
        requiredUrl: 'https://api.agent.network/v1/action'
      });
      expect(verification.valid).toBe(true);
    });

    alice.destroy();
  });
});

Feature('Defesa mTLS e Revogação com Bloom Filter', () => {
  Scenario('Sistema verifica revogação de agentes em tempo real sem latência de DB', async () => {
    let revokedDIDs: string[] = null!;
    let bloomFilter: any = null!;
    let isRevokedResult: boolean = null!;

    await Given('uma lista de agentes revogados [did:agent:evil]', async () => {
      revokedDIDs = ['did:agent:evil'];
    });

    await When('o sistema gera um filtro de Bloom para a lista de revogação (CRL)', () => {
      bloomFilter = createBloomFilterForCRL(revokedDIDs, 0.01);
      expect(bloomFilter).toBeDefined();
    });

    await Then('a verificação do agente "did:agent:evil" deve retornar positivo para revogação', async () => {
      isRevokedResult = await isRevoked('did:agent:evil', bloomFilter);
      expect(isRevokedResult).toBe(true);
    });

    await Then('a verificação do agente "did:agent:hero" deve retornar negativo', async () => {
      isRevokedResult = await isRevoked('did:agent:hero', bloomFilter);
      expect(isRevokedResult).toBe(false);
    });
  });
});
