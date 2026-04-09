export {
  validateCitations,
  extractCitations,
  enrichCitations,
  type CitationViolation,
  type CitationValidationResult,
  type ValidationStrictness,
  type CitationBundle,
} from './citations';

export {
  classifyMessage,
  type Classification,
  type MessageIntent,
  type DudePhase,
} from './message-classifier';

export {
  parseOntologyRegistry,
  parseInlineFlowSequence,
  extractIdentifiersFromLine,
  checkOntologyDiff,
  normalizeToken,
  type OntologySensitivityTier,
  type OntologyConcept,
  type OntologyRegistry,
  type OntologyChangedLine,
  type OntologyViolation,
  type OntologyReference,
  type OntologyCheckResult,
} from './ontology';
