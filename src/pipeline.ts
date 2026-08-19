/**
 * Shared compile+run plumbing used by both the CLI (run-example.ts) and the
 * MCP server (mcp-server.ts). Not one of the three architectural components
 * itself — just wiring between them.
 */
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { compile } from "./compile";
import { createModuleSystem } from "./module-loader";
import { __t as sharedTape, TapeNode } from "./runtime";

export const EXAMPLE_PATH = path.join(__dirname, "..", "examples", "example.ts");

export interface TraceResult {
  nodes: TapeNode[];
  identicalOutput: boolean;
  plainLogs: unknown[][];
  instrumentedLogs: unknown[][];
}

/**
 * `withPlugin` must match how `code` itself was compiled: local (relative) `require()` calls
 * inside `code` load and compile their targets through the same module loader, so a plain run
 * and an instrumented run each stay consistent across every file they touch, not just the
 * entry file.
 */
function runInSandbox(
  code: string,
  tape: typeof sharedTape | undefined,
  entryFile: string,
  withPlugin: boolean,
): unknown[][] {
  const logs: unknown[][] = [];
  const sandbox: Record<string, unknown> = {
    process,
    console: { log: (...args: unknown[]) => logs.push(args) },
  };
  if (tape) sandbox.__t = tape;
  const context = vm.createContext(sandbox);
  const moduleSystem = createModuleSystem(tape, context, withPlugin);
  sandbox.require = (specifier: string) => moduleSystem.requireModule(entryFile, specifier);
  new vm.Script(code, { filename: entryFile }).runInContext(context);
  return logs;
}

/**
 * Run `entryFile` (examples/example.ts by default) once, plain and instrumented, and return
 * the tape. `envOverrides` are applied to `process.env` before either run (and restored
 * after), so a caller (e.g. the MCP `run_trace` tool) can re-run with different env-var
 * inputs. Relative `import`/`require` targets reachable from `entryFile` are traced too (see
 * module-loader.ts) — one continuous DAG across every local file involved, not just the entry.
 */
export function runTraceOnce(envOverrides?: Record<string, string>, entryFile: string = EXAMPLE_PATH): TraceResult {
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
    const source = fs.readFileSync(entryFile, "utf8");
    const plainLogs = runInSandbox(compile(source, false, entryFile), undefined, entryFile, false);

    sharedTape.reset();
    const instrumentedLogs = runInSandbox(compile(source, true, entryFile), sharedTape, entryFile, true);

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
