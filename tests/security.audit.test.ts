import { describe, expect, test } from 'bun:test';
import { runFullSecurityAudit } from '../src';

describe('Security Audit Library', () => {
  test('deve validar funcionalidades críticas de segurança ponta-a-ponta', async () => {
    const report = await runFullSecurityAudit();

    expect(report.totalChecks).toBeGreaterThan(10);
    expect(report.failedChecks).toBe(0);
    expect(report.passedChecks).toBe(report.totalChecks);
  });
});
