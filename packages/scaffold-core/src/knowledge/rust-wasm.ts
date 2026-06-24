/**
 * knowledge/rust-wasm — Rust/WASM governance knowledge
 *
 * Architectural decisions and security threats for projects targeting
 * WebAssembly via Rust (wasm-bindgen / wasm-pack, wasm32-unknown-unknown).
 */

import type { RustWasmDecision, RustWasmThreat } from './rust-wasm.contract';

// ─── Decisions ────────────────────────────────────────────────────────────────

const RUST_WASM_DECISIONS: RustWasmDecision[] = [
  {
    id: 'RW-D1',
    title: 'WASM linear-memory ownership across the JS/Rust boundary',
    context:
      'WASM exposes a single flat linear memory. JS can read and write that buffer directly, and Rust owns allocations within it. Passing a pointer to JS and continuing to mutate it from Rust (or vice versa) creates a shared-mutable-state race with no borrow checker to catch it.',
    recommendation:
      'Treat the boundary as a copy boundary, not a sharing boundary. Pass owned values (return Vec<u8>/String, let wasm-bindgen copy), or hand JS an opaque handle and route all mutation back through Rust methods. Never hold a raw pointer on the JS side across a call that may reallocate Rust memory.',
    signals: ['wasm-bindgen', 'linear memory', 'Memory.buffer', 'raw pointer', 'getValue/setValue'],
  },
  {
    id: 'RW-D2',
    title: 'Build target: wasm32-unknown-unknown vs wasm32-wasi',
    context:
      'wasm32-unknown-unknown produces a bare module with no OS/syscall surface — the right target for browser and Worker glue via wasm-bindgen. wasm32-wasi adds a POSIX-like syscall layer for server/standalone runtimes (wasmtime, Wasmer) but is the wrong target for the browser.',
    recommendation:
      'Use wasm32-unknown-unknown for any module loaded by JS in the browser or a Cloudflare Worker; pair it with wasm-bindgen. Reserve wasm32-wasi for headless server runtimes where you genuinely need filesystem/clock/env access, and never ship a wasi module to the browser expecting syscalls to resolve.',
    signals: ['wasm32-unknown-unknown', 'wasm32-wasi', 'wasmtime', 'browser', 'cloudflare worker'],
  },
  {
    id: 'RW-D3',
    title: 'wasm-bindgen JS glue vs hand-written raw WASM',
    context:
      'Raw WASM can only exchange numbers (i32/i64/f32/f64). Strings, structs, closures, and Promises require glue code to marshal data in and out of linear memory. wasm-bindgen generates that glue automatically; writing it by hand is error-prone and a frequent source of memory-corruption bugs.',
    recommendation:
      'Use wasm-bindgen (and wasm-pack) for any module that exchanges richer-than-numeric data with JS. Only drop to raw WASM exports for a small, hot, purely-numeric kernel where the glue overhead is measurable — and keep the unsafe marshaling surface tiny and tested.',
    signals: ['wasm-bindgen', 'wasm-pack', '#[wasm_bindgen]', 'JS glue', 'cdylib'],
  },
  {
    id: 'RW-D4',
    title: 'Binary-size optimization for shipped WASM',
    context:
      'A debug or unoptimized release WASM binary is frequently several megabytes, which directly inflates load and compile time on the client. Dead code, panic-unwinding machinery, and formatting infrastructure dominate the size budget.',
    recommendation:
      'Build with --release, set opt-level = "z" (or "s") and lto = true, abort on panic to drop unwinding tables, and run wasm-opt -Oz as a post-step. Confirm dead-code elimination is actually removing unused paths and measure the gzipped size you ship, not the raw .wasm size.',
    signals: ['wasm-opt', 'opt-level = "z"', 'lto', 'twiggy', 'binary size', 'panic = "abort"'],
  },
];

// ─── Threats ──────────────────────────────────────────────────────────────────

const RUST_WASM_THREATS: RustWasmThreat[] = [
  {
    id: 'RW-T1',
    title: 'Integer overflow in unsafe Rust compiled to WASM',
    severity: 'MEDIUM',
    description:
      'Release builds wrap integer arithmetic silently (no overflow panic), and unsafe blocks can turn a wrapped index or length into an out-of-bounds linear-memory access. The same code that traps in a debug build can corrupt memory in the shipped release WASM.',
    mitigation:
      'Use checked_*/saturating_*/wrapping_* explicitly where overflow is possible; enable overflow-checks = true in the release profile for security-sensitive arithmetic, and keep unsafe blocks minimal with bounds asserted before pointer math.',
  },
  {
    id: 'RW-T2',
    title: 'Unchecked JS/Rust boundary deserialization',
    severity: 'HIGH',
    description:
      'Data arriving from JS (JsValue, serde-wasm-bindgen input, raw byte buffers) is untrusted. Deserializing it straight into Rust structs without validation lets a hostile or buggy caller drive Rust into invalid states, oversized allocations, or unsafe code paths on assumptions the JS side never enforced.',
    mitigation:
      'Validate every value crossing into Rust at the boundary: reject malformed input, bound collection/string lengths before allocating, and prefer fallible deserialization (Result, not unwrap). Never assume the JS caller has already validated.',
  },
  {
    id: 'RW-T3',
    title: 'Large WASM binary degrading load-time performance',
    severity: 'LOW',
    description:
      'An unoptimized WASM binary inflates download, compile, and instantiation time on the client. While not a memory-safety issue, it is an availability/UX risk on slow networks and a regression vector when the binary grows unnoticed across builds.',
    mitigation:
      'Optimize for size (opt-level "z", lto, wasm-opt -Oz), serve compressed (Brotli/gzip), use streaming instantiation, and add a CI size budget that fails the build when the gzipped binary exceeds a threshold.',
  },
  {
    id: 'RW-T4',
    title: 'Missing CORS headers for cross-origin WASM fetch',
    severity: 'MEDIUM',
    description:
      'When the .wasm file is served from a different origin than the page, fetch/instantiateStreaming requires correct CORS and a application/wasm content-type. Misconfiguration causes the module to fail to load (availability), and an over-permissive Access-Control-Allow-Origin: * on a privileged module can expose it to unintended embedders.',
    mitigation:
      'Serve .wasm with Content-Type: application/wasm and a CORS policy scoped to the trusted origins that should load it — not a blanket wildcard for privileged modules. Verify cross-origin instantiation in an integration test.',
  },
];

/**
 * Architectural decision guidance for Rust/WASM projects.
 */
export function rustWasmDecisions(): RustWasmDecision[] {
  return RUST_WASM_DECISIONS;
}

/**
 * Security threat catalog for Rust/WASM projects.
 */
export function rustWasmThreats(): RustWasmThreat[] {
  return RUST_WASM_THREATS;
}

export type { RustWasmDecision, RustWasmThreat };
