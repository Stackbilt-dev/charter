---
title: "RFC-001: Untrusted-Context Evidence and Policy Gating"
paper-id: RFC-001
version: "0.1"
date: 2026-08-24
status: draft
disposition: parked
charter-version: "1.9.2"
related:
  - CSA-003
---

# RFC-001: Untrusted-Context Evidence and Policy Gating

> **Disposition: parked exploration.** This document preserves a security-product idea without committing Charter to implementation. No command, package, schema, or delivery milestone described here is part of Charter's current public contract.

## 1. Decision Summary

Prompt injection in uploaded documents, retrieved webpages, email, repository content, and tool responses is a legitimate risk for agents that combine untrusted context with private data or consequential tools.

Charter is a plausible policy boundary for this risk, but an arbitrary-document prompt-injection scanner would expand Charter from a context compiler for coding agents into a general AI-input security product. That expansion is not currently justified.

The parked direction is therefore:

1. Charter may eventually accept versioned security evidence and evaluate it against repository policy.
2. Prompt-injection detection should remain an external inspector unless a real consumer demonstrates that Stackbilt needs to own the detector.
3. No separate package, repository, or CLI command should be created before the activation criteria in this RFC are satisfied.
4. A clean inspection must never be represented as proof that content is safe.

## 2. Problem Statement

Modern coding agents consume more than direct user prompts. Their context can include:

- repository files and generated instructions;
- issue bodies, pull-request comments, and commit messages;
- retrieved documentation and webpages;
- MCP resources, tool descriptions, and tool results;
- uploaded text, office documents, PDFs, and images;
- persisted memory and RAG chunks.

An attacker who controls one of those resources may embed instructions intended to redirect the agent, obtain private information, invoke tools, bypass approval, or persist malicious state. NIST classifies attacks delivered through attacker-controlled resources as indirect prompt injection. OWASP recommends defense in depth because input filtering alone is not a complete prevention mechanism.

The impact is contextual. Suspicious instructions in a document presented to a read-only summarizer are not equivalent to the same instructions presented to an agent with private-data access, shell execution, and outbound network access.

## 3. Product Boundary

Charter's current product identity is narrow:

- one modular `.ai/` source of truth;
- deterministic task-based context routing;
- compilation to supported coding-agent configuration files;
- measurable context budgets and governance checks.

Inspecting arbitrary binary and multimodal documents requires extraction engines, adversarial detection research, continuous evasion response, and runtime enforcement integrations. Those responsibilities do not naturally belong in the current CLI core.

The component boundary under consideration is:

```text
Artifact or context segment
  -> format-aware extraction
  -> external inspection
  -> versioned evidence envelope
  -> Charter policy evaluation
  -> consumer enforcement
```

Charter's potential role begins at the evidence envelope. It does not automatically own extraction, detection, sanitization, quarantine storage, or downstream tool authorization.

## 4. Security Principles

### 4.1 Findings are not safety verdicts

An inspector can report detected indicators and declared coverage. It cannot establish the absence of an injection. The correct clean result is:

> No configured indicator was detected within the inspection's declared coverage.

It is not:

> This document is safe.

### 4.2 Evidence and policy remain separate

An inspector reports evidence. A policy combines that evidence with source trust, data sensitivity, agent capabilities, and intended use. A consumer enforces the resulting decision.

### 4.3 Risk depends on capability

A policy profile should consider at least:

- whether the source is trusted, authenticated, or attacker-controlled;
- whether the agent can access private or regulated data;
- whether tools can write, execute code, or communicate externally;
- whether actions are reversible;
- whether a human approves consequential operations;
- whether multiple context sources are composed.

### 4.4 Provenance claims require qualification

A content hash establishes identity and supports reproducibility. It does not establish authorship, authenticity, or trust. An unsigned `origin` field is a claim supplied by the caller.

### 4.5 Enforcement must be deterministic

A model may contribute a detection signal, but it must not be the component that grants itself authority. Blocking, approval, tool authorization, and data-access decisions belong in deterministic code and downstream access controls.

### 4.6 Residual risk remains explicit

Unsupported media, failed extraction, encrypted content, images without OCR, truncated input, and uninspected embedded objects must produce coverage gaps or abstentions rather than clean results.

## 5. Candidate Evidence Contract

The following is illustrative and is not a published schema:

```json
{
  "schemaVersion": "0.1-experimental",
  "artifact": {
    "sha256": "<digest>",
    "mediaType": "text/markdown",
    "origin": "user-upload",
    "originVerified": false,
    "trust": "untrusted"
  },
  "inspection": {
    "inspector": "<name-and-version>",
    "status": "completed",
    "coverage": {
      "text": "inspected",
      "hiddenContent": "not-applicable",
      "embeddedObjects": "not-inspected",
      "multimodal": "not-inspected"
    }
  },
  "findings": [
    {
      "controlId": "PI-003",
      "category": "unauthorized-tool-directive",
      "confidence": "high",
      "potentialImpact": "high",
      "location": { "line": 42 },
      "evidenceHash": "<digest>",
      "message": "Untrusted content directs the agent to invoke an external tool."
    }
  ]
}
```

Evidence snippets should be redacted or represented by hashes when they may contain secrets, personal data, or active payloads.

## 6. Candidate Policy Result

Inspection outcome and policy decision are different fields:

```json
{
  "inspectionOutcome": "findings-detected",
  "decision": "human-review",
  "policy": "untrusted-context/agent-with-tools",
  "reasons": ["PI-003"],
  "residualRisk": "present",
  "enforced": false
}
```

Candidate decisions are:

- `continue-under-policy`: no configured policy rule blocks use; this is not a safety claim;
- `human-review`: the consumer must obtain explicit approval;
- `quarantine`: the content must not enter ordinary context assembly;
- `block`: the configured use is prohibited;
- `indeterminate`: inspection or required coverage failed.

If exposed through Charter, normal exit semantics would apply: `0` means no policy violation, `1` means policy violation, and `2` means runtime, extraction, or usage failure. The exit code would not certify content safety.

## 7. Candidate Indicator Vocabulary

Identifiers must not become normative until they are backed by fixtures and versioning rules. A seed vocabulary could include:

| ID | Category |
|---|---|
| PI-001 | Authority or role impersonation |
| PI-002 | Instruction-priority override |
| PI-003 | Unauthorized tool or action directive |
| PI-004 | Secret or governing-prompt extraction |
| PI-005 | Data exfiltration or URL smuggling |
| PI-006 | Memory or persistence poisoning |
| PI-007 | Hidden, encoded, Unicode, or low-visibility content |
| PI-008 | Task or goal redirection |
| PI-009 | Approval or safety-control bypass |
| PI-010 | Cross-source or composition-dependent behavior |

Any future vocabulary should map to external taxonomies such as OWASP LLM01 and NIST adversarial-ML impact categories instead of becoming an isolated security standard.

## 8. Non-Goals

This exploration does not propose:

- claiming that prompt injection can be completely detected or prevented;
- describing content as safe because no indicator matched;
- building PDF, DOCX, email, archive, or OCR engines inside Charter;
- rewriting or sanitizing source artifacts by default;
- granting an LLM authority to approve its own inputs or tool calls;
- replacing sandboxing, authorization, network controls, output validation, or human approval;
- treating regex matches as proof of malicious intent;
- adding a new Charter command before a real enforcement consumer exists;
- marketing Charter as a prompt-injection firewall.

## 9. Activation Criteria

Implementation should not begin until all of the following are true:

1. A named consumer has an active untrusted-context ingestion path.
2. The consumer's agent has private-data access or consequential tools that create material impact.
3. There is a deterministic enforcement point capable of changing behavior based on the result.
4. Source trust, tool capability, and intended-use profiles can be supplied to policy evaluation.
5. A legally usable corpus can include attacks, benign documents, security research, multilingual content, and obfuscation cases.
6. Precision, recall, false-positive, abstention, coverage, and runtime metrics are chosen before evaluation.
7. Someone owns ongoing bypass intake, fixture maintenance, and security communication.
8. The experiment has a bounded scope and does not displace higher-priority Charter work without an explicit roadmap decision.

## 10. Kill or Extract Criteria

The experiment should be stopped, delegated, or extracted from Charter if:

- there is no consumer that actually enforces its output;
- findings are informational only and do not alter authorization or context assembly;
- benign security, governance, or instructional documents produce noise that causes routine bypasses;
- common encoding, paraphrase, multilingual, or split-content variants bypass the baseline without detectable coverage gaps;
- format extraction becomes the dominant engineering problem;
- a maintained external inspector provides equivalent evidence with better evaluation;
- the capability requires marketing Charter as a general AI-security suite;
- ongoing adversarial maintenance cannot be staffed.

## 11. First Experiment, If Activated

The smallest defensible experiment would:

- accept already-extracted UTF-8 text and Markdown only;
- perform no mutation or sanitization;
- emit findings and coverage metadata only;
- evaluate a deterministic baseline against a frozen corpus;
- include difficult benign examples containing quoted attack language;
- keep evaluation inputs separate from tuning inputs;
- report per-control precision and recall, aggregate false-positive and abstention rates, runtime, and known bypasses;
- run at one real ingestion boundary with an explicit human-review or block path;
- avoid a public package or protection claim until results justify extraction.

A model-assisted classifier could later provide an additional signal, but should be evaluated independently and should never be the sole authorization gate.

## 12. Potential Charter Integration

If the experiment succeeds, the most reusable Charter capability may be a generic evidence-policy interface rather than `inspect-context`:

```bash
external-inspector artifact.txt --format json > findings.json
charter evidence check --input findings.json --policy untrusted-context --format json
```

The exact command is intentionally undecided. Before introducing one, Charter should determine whether existing evidence and validation primitives can be extended without confusing repository governance evidence with runtime content-security evidence.

## 13. Reopening Triggers

Revisit this RFC when one of the following occurs:

- a Stackbilt system connects untrusted documents or retrieval results to an agent with material privileges;
- a Charter consumer requests a standard security-evidence ingestion contract;
- an external detector needs a portable repository policy and CI gate;
- a bounded implementation partner or contributor can own the adversarial evaluation;
- new standards provide a stable interoperable finding format suitable for adoption.

Until then, this RFC remains a design record, not scheduled work.

## 14. References

- [NIST: Adversarial Machine Learning — A Taxonomy and Terminology of Attacks and Mitigations](https://doi.org/10.6028/NIST.AI.100-2e2023)
- [OWASP GenAI Security Project: LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [OWASP GenAI Security Project: LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)
- [Model Context Protocol specification: Security and Trust & Safety](https://modelcontextprotocol.io/specification/2025-03-26/index#security-and-trust--safety)
- [OpenAI: Understanding prompt injections](https://openai.com/safety/prompt-injections/)
- [Microsoft: Defend against indirect prompt injection attacks](https://learn.microsoft.com/en-us/security/zero-trust/sfi/defend-indirect-prompt-injection)

