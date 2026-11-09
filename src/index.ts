/**
 * Public package entry point for consumers who just want the Babel plugin (and its runtime
 * tape) in their own project, as opposed to this repo's internal CLI/MCP tooling
 * (pipeline.ts, run-example.ts, mcp-server.ts), which stay internal.
 *
 * Typical consumer usage (their own babel.config.js):
 *
 *   const { mnemosynePlugin } = require("mnemosyne");
 *   module.exports = {
 *     presets: [["@babel/preset-typescript", {}]],
 *     plugins: [mnemosynePlugin],
 *   };
 *
 * ...then, before running the instrumented code, make `__t` available as a global (or inject
 * it into whatever sandbox/context runs the code) using the exported `__t` singleton (or a
 * fresh `new Tape()` per run, for isolation).
 */
export { default as mnemosynePlugin } from "./transform";
export { Tape, __t } from "./runtime";
export type { TapeNode, Loc, NodeKind, ScopeKind, OperandKind, OperandMeta, PackageCallMetadata, PackageImportMetadata, AICallMetadata } from "./runtime";
export { toJSON, toMermaid, toDot, subgraphFrom, descendantsOf, safeStringify } from "./export-mermaid";

import { Tape, __t } from "./runtime";

/**
 * Instrumented code refers to `__t` as a free/global identifier (see transform.ts) rather
 * than importing it, so it can be shared across every traced file without each one needing
 * its own import wiring. Call this once, before any instrumented module runs, to put a tape
 * there for it to find.
 */
export function installGlobalTape(tape: Tape = __t): void {
  (globalThis as unknown as { __t: Tape }).__t = tape;
}

