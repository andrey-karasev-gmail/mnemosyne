/**
 * CLI entrypoint: parse -> transform -> generate -> run -> export.
 *
 * Runs examples/example.ts through the pipeline (plain vs. instrumented,
 * diffed for identical output) and writes the resulting tape to
 * output/trace.json and output/trace.mmd.
 */
import * as fs from "fs";
import * as path from "path";
import { runTraceOnce } from "./pipeline";
import { toJSON, toMermaid } from "./export-mermaid";

const OUTPUT_DIR = path.join(__dirname, "..", "output");

function main(): void {
  const result = runTraceOnce();

  console.log(`Identical output (plain vs. instrumented): ${result.identicalOutput}`);
  if (!result.identicalOutput) {
    console.log("  plain:       ", JSON.stringify(result.plainLogs));
    console.log("  instrumented:", JSON.stringify(result.instrumentedLogs));
    process.exitCode = 1;
  }

  console.log(`Tape recorded ${result.nodes.length} nodes.`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, "trace.json"), toJSON(result.nodes));
  fs.writeFileSync(path.join(OUTPUT_DIR, "trace.mmd"), toMermaid(result.nodes));
  console.log(`Wrote ${path.join("output", "trace.json")} and ${path.join("output", "trace.mmd")}`);
}

main();
