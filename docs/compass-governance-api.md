---
title: "Compass Governance"
description: "Compass internal governance service — RPC methods, service binding integration, and governance modes."
section: "platform"
order: 8
color: "#22d3ee"
tag: "08"
---

# Compass Governance

Compass is an internal governance service accessed via Cloudflare Service Binding from the Stackbilder flow pipeline. It is **not a public API** — there are no HTTP endpoints, no MCP server, and no admin surface.

## Architecture

Compass is a lightweight RPC service (`compass` worker) bound to EdgeStack via `CSA_SERVICE` service binding. It provides governance guidance, quality assessment, and decision persistence for the 6-mode flow pipeline.

```
EdgeStack (FlowDO)
  │
  ├── fetchGuidance(mode, tier) → constraints + quality thresholds
  │
  ├── mode execution (LLM)
  │
  ├── assessQuality(artifact) → score + pass/fail
  │
  └── persistDecisions(decisions) → ledger write (SPRINT mode only)
```

## RPC Methods

All calls go through `POST /rpc` with JSON-RPC payload. Requires `scope` object with `projectId`, `flowId`, `mode`, `tier`, `effectiveGovernanceMode`.

### compass.fetchGuidance

Returns governance context and quality thresholds for a flow mode. Called before each mode execution.

```json
{
  "method": "compass.fetchGuidance",
  "params": {
    "scope": {
      "projectId": "...",
      "flowId": "...",
      "mode": "ARCHITECT",
      "tier": "pro",
      "effectiveGovernanceMode": "ADVISORY"
    }
  }
}
```

### compass.assessQuality

Scores a generated artifact against quality thresholds. Called after artifact generation.

```json
{
  "method": "compass.assessQuality",
  "params": {
    "scope": { "..." },
    "artifact": "...",
    "mode": "ARCHITECT"
  }
}
```

### compass.persistDecisions

Stores ADRs and architectural decisions in the governance ledger. Called at end of SPRINT mode only.

```json
{
  "method": "compass.persistDecisions",
  "params": {
    "scope": { "..." },
    "decisions": [{ "..." }]
  }
}
```

## Governance Modes by Plan

| Plan | Max Mode | Behavior |
|------|----------|----------|
| Free | `PASSIVE` | Log only — never blocks |
| Pro | `ADVISORY` | Warn on issues, flow continues |
| Enterprise | `ENFORCED` | Block on FAIL, require remediation |

## Integration

EdgeStack creates a `CompassExchangeClient` per flow (cached, 5-min TTL). The client calls Compass via service binding with a 10-second timeout.

```toml
# edgestack-v2/wrangler.toml
[[services]]
binding = "CSA_SERVICE"
service = "compass"
```

## Future Direction

Compass governance logic is being consolidated into the Stackbilder Engine (`stackbilt-engine`), which already handles blessed pattern enforcement, compatibility scoring, and tier gating deterministically. See [edgestack#32](https://github.com/Stackbilt-dev/edgestack_v2/issues/32) for the migration plan.

## Related Docs

- [Ecosystem](/ecosystem)
- [Platform](/platform) (Stackbilder flow pipeline)
