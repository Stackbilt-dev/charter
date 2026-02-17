/**
 * Message Classifier
 *
 * Lightweight, heuristic-first message classification.
 * No LLM call — runs in <5ms. Classifies user messages by intent and determines
 * which DUDE phases (Dissolve/Unify/Differentiate/Evaluate) to apply.
 *
 * Extracted from Charter Cloud (Cognitive Console).
 */

import type { AppMode } from '@stackbilt/types';

// ============================================================================
// Types
// ============================================================================

export type MessageIntent = 'ideation' | 'decision' | 'doubt' | 'synthesis' | 'question' | 'review';
export type DudePhase = 'D' | 'U' | 'Di' | 'E';

export interface Classification {
  intent: MessageIntent;
  confidence: number;
  dudePhases: DudePhase[];
  suggestedMode: AppMode;
  complexity: 'low' | 'medium' | 'high';
  signals: string[];
  domain: string | null;
}

// ============================================================================
// Intent Signal Patterns
// ============================================================================

const INTENT_PATTERNS: Record<MessageIntent, { patterns: RegExp[]; weight: number }> = {
  ideation: {
    patterns: [
      /^i('m| am) (thinking|considering|wondering|exploring|toying)/i,
      /what if we/i,
      /could we (try|explore|consider)/i,
      /^(brainstorm|ideate|spitball)/i,
      /how (might|could) we/i,
      /^what (about|would happen)/i,
      /playing with the idea/i,
      /^imagine/i,
      /just thinking out loud/i,
      /throwing this out there/i,
    ],
    weight: 1.0
  },
  decision: {
    patterns: [
      /should (we|i|the team) (use|pick|choose|go with|adopt|switch)/i,
      /^(which|what) (is better|should we|do you recommend)/i,
      /versus|vs\.?\s/i,
      /or should we/i,
      /^decide|^choose|^pick between/i,
      /trade-?offs? (between|of)/i,
      /pros and cons/i,
      /make a (decision|call|choice)/i,
      /\bA or B\b/i,
      /recommend (against|for|between)/i,
    ],
    weight: 1.0
  },
  doubt: {
    patterns: [
      /(something|this) (feels|seems) (off|wrong|weird|risky)/i,
      /i('m| am) (not sure|uncertain|worried|concerned|uneasy)/i,
      /doesn't (feel|seem|sit) right/i,
      /^(is this|are we) (okay|right|correct|safe)/i,
      /nagging (feeling|sense)/i,
      /red flag/i,
      /am i (overthinking|wrong|missing)/i,
      /^(can you|could you) (validate|sanity.check|gut.check)/i,
      /second.guess/i,
      /smell(s)? (off|wrong|bad)/i,
    ],
    weight: 1.0
  },
  synthesis: {
    patterns: [
      /^(let me|i('ll| will)) (pull together|summarize|consolidate|synthesize)/i,
      /^(summarize|recap|consolidate|wrap up)/i,
      /putting (it|this) all together/i,
      /^(so|okay),? (to (summarize|recap)|in summary)/i,
      /^here('s| is) (what|where) (we|things) (stand|are)/i,
      /^(draft|write|formalize|document) (an?|the) (adr|policy|sop|decision)/i,
      /formalize this/i,
      /make this official/i,
    ],
    weight: 1.0
  },
  question: {
    patterns: [
      /^what('s| is) (our|the) (pattern|policy|approach|standard|blessed)/i,
      /^(do|does) (we|the team) have (a|an)/i,
      /^(how|where) (do|does|did|can|should)/i,
      /^(what|which|who|when|where|why|how)\b/i,
      /^is (there|it|this)/i,
      /^can (you|i|we) (check|look up|find|tell me)/i,
      /^quick question/i,
      /^reminder:/i,
    ],
    weight: 0.7
  },
  review: {
    patterns: [
      /^review (this|my|our|the)/i,
      /^(red.team|critique|tear apart|challenge|attack)/i,
      /^(check|audit|inspect|evaluate|assess) (this|my|our|the)/i,
      /security (review|audit|check)/i,
      /architecture review/i,
      /what('s| is) wrong with/i,
      /^(find|spot) (the )?(flaws|issues|problems|vulnerabilities)/i,
      /poke holes/i,
      /stress.test/i,
    ],
    weight: 1.0
  }
};

// ============================================================================
// DUDE Phase Mapping
// ============================================================================

const INTENT_TO_PHASES: Record<MessageIntent, DudePhase[]> = {
  ideation:  ['D', 'Di'],
  decision:  ['D', 'U', 'Di', 'E'],
  doubt:     ['D', 'U'],
  synthesis: ['U', 'E'],
  question:  ['U'],
  review:    ['Di', 'E'],
};

const INTENT_TO_MODE: Record<MessageIntent, AppMode> = {
  ideation:  'STRATEGY',
  decision:  'GOVERNANCE',
  doubt:     'STRATEGY',
  synthesis: 'DRAFTER',
  question:  'GOVERNANCE',
  review:    'RED_TEAM',
};

// ============================================================================
// Domain Detection (standalone — no DB dependency)
// ============================================================================

const DOMAIN_PATTERNS: Record<string, RegExp[]> = {
  ARCHITECTURE: [/architect/i, /infrastructure/i, /system design/i, /topology/i, /microservice/i, /monolith/i],
  DATA: [/database/i, /schema/i, /migration/i, /data model/i, /query/i, /storage/i, /d1/i, /sqlite/i],
  SECURITY: [/security/i, /auth/i, /permission/i, /vulnerability/i, /encryption/i, /jwt/i, /oauth/i],
  STANDARDS: [/standard/i, /convention/i, /pattern/i, /blessed/i, /anti-pattern/i, /best practice/i],
  STRATEGY: [/strategy/i, /roadmap/i, /long-?term/i, /vision/i, /trade-?off/i],
};

function detectDomain(text: string): string | null {
  let bestDomain: string | null = null;
  let bestScore = 0;

  for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
    const score = patterns.filter(p => p.test(text)).length;
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }

  return bestDomain;
}

// ============================================================================
// Classification Logic
// ============================================================================

/**
 * Classify a user message by intent, DUDE phases, complexity, and suggested mode.
 * Pure heuristics — no LLM call, runs in <5ms.
 */
export function classifyMessage(
  message: string,
  conversationContext?: { recentMessages: string[]; threadTopic?: string }
): Classification {
  const signals: string[] = [];
  const scores = new Map<MessageIntent, number>();

  for (const intent of Object.keys(INTENT_PATTERNS) as MessageIntent[]) {
    scores.set(intent, 0);
  }

  for (const [intent, config] of Object.entries(INTENT_PATTERNS) as [MessageIntent, typeof INTENT_PATTERNS[MessageIntent]][]) {
    for (const pattern of config.patterns) {
      if (pattern.test(message)) {
        const current = scores.get(intent) || 0;
        scores.set(intent, current + config.weight);
        signals.push(`${intent}:${pattern.source.substring(0, 30)}`);
      }
    }
  }

  if (conversationContext) {
    const msgCount = conversationContext.recentMessages.length;

    if (msgCount === 0) {
      const current = scores.get('ideation') || 0;
      scores.set('ideation', current + 0.3);
      signals.push('position:first-message');
    } else if (msgCount > 6) {
      const synthCurrent = scores.get('synthesis') || 0;
      scores.set('synthesis', synthCurrent + 0.2);
      const decCurrent = scores.get('decision') || 0;
      scores.set('decision', decCurrent + 0.2);
      signals.push('position:deep-conversation');
    }
  }

  let bestIntent: MessageIntent = 'question';
  let bestScore = 0;

  for (const [intent, score] of scores.entries()) {
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }

  const maxPossible = INTENT_PATTERNS[bestIntent].patterns.length * INTENT_PATTERNS[bestIntent].weight;
  const confidence = maxPossible > 0
    ? Math.min(1.0, bestScore / Math.max(maxPossible * 0.3, 1))
    : 0.5;

  const complexity = estimateComplexity(message);
  const domain = detectDomain(message);

  return {
    intent: bestIntent,
    confidence: Math.round(confidence * 100) / 100,
    dudePhases: INTENT_TO_PHASES[bestIntent],
    suggestedMode: INTENT_TO_MODE[bestIntent],
    complexity,
    signals: signals.slice(0, 5),
    domain,
  };
}

// ============================================================================
// Complexity Estimation
// ============================================================================

function estimateComplexity(message: string): 'low' | 'medium' | 'high' {
  let score = 0;

  const wordCount = message.split(/\s+/).length;
  if (wordCount > 100) score += 2;
  else if (wordCount > 40) score += 1;

  const techTerms = message.match(
    /\b(api|database|schema|migration|auth|deploy|infrastructure|microservice|monolith|cache|queue|worker|webhook|oauth|jwt|graphql|rest|grpc|websocket|kubernetes|docker|terraform|cdn|dns|ssl|tls|encryption|sharding|replication|load.?balanc|circuit.?break|saga|cqrs|event.?sourc)\b/gi
  );
  if (techTerms && techTerms.length > 3) score += 2;
  else if (techTerms && techTerms.length > 1) score += 1;

  const references = message.match(/(https?:\/\/|`[^`]+`|\/[\w/.-]+\.\w+)/g);
  if (references && references.length > 2) score += 1;

  const questionMarks = (message.match(/\?/g) || []).length;
  if (questionMarks > 2) score += 1;

  const listItems = (message.match(/^\s*[-*\d]+[.)]\s/gm) || []).length;
  if (listItems > 2) score += 1;

  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}
