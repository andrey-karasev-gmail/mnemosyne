/**
 * Shared compile+run plumbing used by both the CLI (run-example.ts) and the
 * MCP server (mcp-server.ts). Not one of the three architectural components
 * itself — just wiring between them.
 */
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { transformSync } from "@babel/core";
import mnemosynePlugin from "./transform";
import { __t as sharedTape, TapeNode } from "./runtime";

export const EXAMPLE_PATH = path.join(__dirname, "..", "examples", "example.ts");

export interface TraceResult {
  nodes: TapeNode[];
  identicalOutput: boolean;
  plainLogs: unknown[][];
  instrumentedLogs: unknown[][];
}

function compile(source: string, withPlugin: boolean): string {
  const result = transformSync(source, {
    filename: EXAMPLE_PATH,
    presets: [["@babel/preset-typescript", {}]],
    plugins: withPlugin ? [mnemosynePlugin] : [],
    babelrc: false,
    configFile: false,
  });
  if (!result?.code) throw new Error("Babel produced no output for examples/example.ts");
  return result.code;
}

function runInSandbox(code: string, tape: typeof sharedTape | undefined): unknown[][] {
  const logs: unknown[][] = [];
  const sandbox: Record<string, unknown> = {
    process,
    console: { log: (...args: unknown[]) => logs.push(args) },
  };
  if (tape) sandbox.__t = tape;
  vm.createContext(sandbox);
  new vm.Script(code, { filename: EXAMPLE_PATH }).runInContext(sandbox);
  return logs;
}

/**
 * Run examples/example.ts once, plain and instrumented, and return the tape.
 * `envOverrides` are applied to `process.env` before either run (and restored
 * after), so a caller (e.g. the MCP `run_trace` tool) can re-run with
 * different env-var inputs.
 */
export function runTraceOnce(envOverrides?: Record<string, string>): TraceResult {
  const previousEnv: Record<string, string | undefined> = {};
  if (envOverrides) {
    for (const [key, value] of Object.entries(envOverrides)) {
      previousEnv[key] = process.env[key];
      process.env[key] = value;
    }
  }
  if (process.env.TAX_RATE === undefined) {
    process.env.TAX_RATE = "0.08";
  }

  try {
    const source = fs.readFileSync(EXAMPLE_PATH, "utf8");
    const plainLogs = runInSandbox(compile(source, false), undefined);

    sharedTape.reset();
    const instrumentedLogs = runInSandbox(compile(source, true), sharedTape);

    return {
      nodes: sharedTape.nodes,
      identicalOutput: JSON.stringify(plainLogs) === JSON.stringify(instrumentedLogs),
      plainLogs,
      instrumentedLogs,
    };
  } finally {
    if (envOverrides) {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}
