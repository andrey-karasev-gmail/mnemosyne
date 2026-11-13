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
import { __t as sharedTape, Tape, TapeNode } from "./runtime";

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
 *
 * Both runs receive a tape: source code may call `__t.*` directly (the documented consumer
 * API — e.g. `__t.ai()` around a provider call), and those calls must execute in the plain
 * run too, against a throwaway Tape whose nodes are never read. Without it, such a program
 * crashes in the plain run with `__t is not defined` while the instrumented run works — and
 * because the failure happens inside the program's async entrypoint, it surfaces only as an
 * unhandled rejection after the output comparison has already passed.
 */
async function runInSandbox(
  code: string,
  tape: typeof sharedTape | undefined,
  entryFile: string,
  withPlugin: boolean,
): Promise<unknown[][]> {
  const logs: unknown[][] = [];
  const sandbox: Record<string, unknown> = {
    process,
    console: { log: (...args: unknown[]) => logs.push(args) },
  };
  if (tape) sandbox.__t = tape;
  // Default microtask mode on purpose: the context must share this process's microtask
  // queue. With `microtaskMode: "afterEvaluate"` the context gets a private queue that is
  // only drained at script-evaluation checkpoints, so an async function's continuation
  // after `await`ing a host-realm promise (e.g. the one `Tape.ai()` returns) would be
  // stranded in that queue and never run — silently truncating the trace at the first
  // such `await`.
  const context = vm.createContext(sandbox);
  const moduleSystem = createModuleSystem(tape, context, withPlugin);
  sandbox.require = (specifier: string) => moduleSystem.requireModule(entryFile, specifier);
  new vm.Script(code, { filename: entryFile }).runInContext(context);
  // Host-realm promises (e.g. the one `Tape.ai()` returns) settle on this process's
  // microtask queue, which only drains once the synchronous stack empties — so an async
  // entrypoint would otherwise still be mid-flight when the caller reads the tape and the
  // logs, silently truncating both at the first `await`. Yield whole event-loop turns
  // until the run stops producing tape nodes and log lines. The turn cap keeps a program
  // waiting on real timers or I/O from hanging the trace; such a tail stays unrecorded.
  if (tape) {
    let lastSize = -1;
    for (let turn = 0; turn < 50; turn++) {
      const size = tape.nodes.length + logs.length;
      if (size === lastSize) break;
      lastSize = size;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return logs;
}

/**
 * Run `entryFile` (examples/example.ts by default) once, plain and instrumented, and return
 * the tape. `envOverrides` are applied to `process.env` before either run (and restored
 * after), so a caller (e.g. the MCP `run_trace` tool) can re-run with different env-var
 * inputs. Relative `import`/`require` targets reachable from `entryFile` are traced too (see
 * module-loader.ts) — one continuous DAG across every local file involved, not just the entry.
 */
export async function runTraceOnce(envOverrides?: Record<string, string>, entryFile: string = EXAMPLE_PATH): Promise<TraceResult> {
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
    const plainLogs = await runInSandbox(compile(source, false, entryFile), new Tape(), entryFile, false);

    sharedTape.reset();
    const instrumentedLogs = await runInSandbox(compile(source, true, entryFile), sharedTape, entryFile, true);

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
