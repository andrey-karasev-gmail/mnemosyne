/**
 * CLI entrypoint: parse -> transform -> generate -> run -> export.
 *
 * Runs examples/example.ts through the pipeline (plain vs. instrumented,
 * diffed for identical output) and writes the resulting tape to
 * output/trace.json and output/trace.mmd. Pass a relative path as the first
 * CLI arg (e.g. `examples/multi-file/main.ts`) to trace a different entry
 * file instead; output is then written to output/trace-<dir>.{json,mmd} so it
 * doesn't clobber the default trace.
 */
import * as fs from "fs";
import * as path from "path";
import { runTraceOnce, EXAMPLE_PATH } from "./pipeline";
import { toJSON, toMermaid } from "./export-mermaid";

const OUTPUT_DIR = path.join(__dirname, "..", "output");

async function main(): Promise<void> {
  const entryArg = process.argv[2];
  const entryFile = entryArg ? path.resolve(process.cwd(), entryArg) : EXAMPLE_PATH;
  const suffix = entryFile === EXAMPLE_PATH ? "" : `-${path.basename(path.dirname(entryFile))}`;

  const result = await runTraceOnce(undefined, entryFile);

  console.log(`Identical output (plain vs. instrumented): ${result.identicalOutput}`);
  if (!result.identicalOutput) {
    console.log("  plain:       ", JSON.stringify(result.plainLogs));
    console.log("  instrumented:", JSON.stringify(result.instrumentedLogs));
    process.exitCode = 1;
  }

  console.log(`Tape recorded ${result.nodes.length} nodes.`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const jsonPath = path.join(OUTPUT_DIR, `trace${suffix}.json`);
  const mmdPath = path.join(OUTPUT_DIR, `trace${suffix}.mmd`);
  fs.writeFileSync(jsonPath, toJSON(result.nodes));
  fs.writeFileSync(mmdPath, toMermaid(result.nodes));
  console.log(`Wrote ${path.relative(process.cwd(), jsonPath)} and ${path.relative(process.cwd(), mmdPath)}`);
}

void main();
