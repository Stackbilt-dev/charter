## Charter: Local Enforcement + ADF Context Compiler

Charter runs in your terminal and CI pipeline. It validates commit trailers, scores drift against your blessed stack, and blocks merges on violations. Zero SaaS dependency - all checks are deterministic and local.

Charter also ships **ADF (Attention-Directed Format)** - a modular, AST-backed context system that replaces monolithic `.cursorrules` and `claude.md` files with compiled, trigger-routed `.ai/` modules. ADF treats LLM context as a compiled language: emoji-decorated semantic keys, typed patch operations, manifest-driven progressive disclosure, and metric ceilings with CI evidence gating.

```bash
npm install --save-dev @stackbilt/cli
npx charter setup --preset fullstack --ci github --yes
npx charter adf init    # scaffold .ai/ context directory
```

**Governance commands:** `validate`, `drift`, `audit`, `classify`, `hook install`.
**ADF commands:** `adf init`, `adf fmt`, `adf patch`, `adf bundle`, `adf sync`, `adf evidence`.

For quantitative analysis of ADF's impact on autonomous system architecture, see the [Context-as-Code white paper](https://github.com/stackbilt-dev/charter/blob/main/papers/context-as-code-v1.1.md).
