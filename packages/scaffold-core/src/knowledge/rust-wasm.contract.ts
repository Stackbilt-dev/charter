// rust-wasm.contract.ts — bounded context: Rust/WASM governance knowledge
// Entities: RustWasmDecision, RustWasmThreat
// Authority rules: severity enum, decision/threat shape
// Note: plain TypeScript interfaces — scaffold-core carries zero runtime dependencies

export type ThreatSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface RustWasmDecision {
  id: string;
  title: string;
  context: string;
  recommendation: string;
  signals: string[];
}

export interface RustWasmThreat {
  id: string;
  title: string;
  severity: ThreatSeverity;
  description: string;
  mitigation: string;
}
