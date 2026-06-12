/**
 * governance — public API
 *
 * buildGovernance(facts, knowledge) → GovernanceDocs
 */

export type { GovernanceDocs } from '../types';
export { buildThreatModel } from './threat-model';
export { buildAdr001, buildAdr002 } from './adr';
export { buildTestPlan } from './test-plan';

import type { ScaffoldFacts, PatternKnowledge, GovernanceDocs } from '../types';
import { buildThreatModel } from './threat-model';
import { buildAdr001, buildAdr002 } from './adr';
import { buildTestPlan } from './test-plan';

/**
 * Build all governance documents for a scaffold project.
 */
export function buildGovernance(facts: ScaffoldFacts, knowledge: PatternKnowledge): GovernanceDocs {
  return {
    threatModel: buildThreatModel(facts, knowledge),
    adr001: buildAdr001(facts, knowledge),
    adr002: buildAdr002(facts),
    testPlan: buildTestPlan(facts),
  };
}
