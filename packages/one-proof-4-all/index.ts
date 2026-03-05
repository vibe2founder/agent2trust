/**
 * @purecore/one-proof-4-all
 * Biblioteca minimalista para BDD (Behavior Driven Development)
 * seguindo princípios de Antifragilidade e Evidência.
 */

import { describe, test, expect } from 'bun:test';

/**
 * Tipagem Semântica Nominal Local
 */
type Brand<T, Name extends string> = T & { readonly __brand: Name };
type FeatureName = Brand<string, 'FeatureName'>;
type ScenarioName = Brand<string, 'ScenarioName'>;

/**
 * Estrutura de Evidência
 */
interface Evidence {
  timestamp: string;
  step: string;
  status: 'passed' | 'failed';
  details?: any;
}

const evidenceLog: Evidence[] = [];

function recordEvidence(step: string, status: 'passed' | 'failed', details?: any) {
  evidenceLog.push({
    timestamp: new Date().toISOString(),
    step,
    status,
    details,
  });
}

/**
 * BDD Core
 */

export function Feature(name: string, definition: () => void) {
  describe(`Feature: ${name}`, () => {
    definition();
  });
}

export function Scenario(name: string, definition: () => void) {
  test(`Scenario: ${name}`, async () => {
    try {
      await definition();
      recordEvidence(`Scenario: ${name}`, 'passed');
    } catch (error) {
      recordEvidence(`Scenario: ${name}`, 'failed', error);
      throw error;
    }
  });
}

export const Given = async (description: string, action: () => Promise<void> | void) => {
  try {
    await action();
    console.log(`  [GIVEN] ${description} ✅`);
  } catch (error) {
    console.log(`  [GIVEN] ${description} ❌`);
    throw error;
  }
};

export const When = async (description: string, action: () => Promise<void> | void) => {
  try {
    await action();
    console.log(`  [WHEN] ${description} ✅`);
  } catch (error) {
    console.log(`  [WHEN] ${description} ❌`);
    throw error;
  }
};

export const Then = async (description: string, action: () => Promise<void> | void) => {
  try {
    await action();
    console.log(`  [THEN] ${description} ✅`);
  } catch (error) {
    console.log(`  [THEN] ${description} ❌`);
    throw error;
  }
};

/**
 * Exportar logger de evidências para auditoria
 */
export const getEvidence = () => [...evidenceLog];
export const clearEvidence = () => { evidenceLog.length = 0; };
