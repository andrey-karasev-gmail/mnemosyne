/**
 * Single place that turns TS source into runnable CommonJS-shaped code, used by both
 * pipeline.ts (entry file) and module-loader.ts (files it locally imports) so plain and
 * instrumented runs treat `import`/`export` consistently.
 *
 * - Instrumented (`withPlugin: true`): src/transform.ts does the whole job — type stripping,
 *   import/export -> require()/exports.* rewriting, AND instrumentation, all in one pass.
 * - Plain (`withPlugin: false`): src/transform.ts is intentionally not applied (that's the
 *   whole point of the plain/instrumented diff), so import/export syntax is instead lowered
 *   by the official `@babel/plugin-transform-modules-commonjs` — otherwise a plain run of a
 *   file that uses `import`/`export` would fail under `vm.Script` ("Cannot use import
 *   statement outside a module") while the instrumented run succeeds, breaking the
 *   behavior-preservation comparison for reasons unrelated to instrumentation itself.
 */
import { transformSync } from "@babel/core";
import mnemosynePlugin from "./transform";

export function compile(source: string, withPlugin: boolean, filename: string): string {
  const result = transformSync(source, {
    filename,
    presets: [["@babel/preset-typescript", {}]],
    plugins: withPlugin ? [mnemosynePlugin] : ["@babel/plugin-transform-modules-commonjs"],
    babelrc: false,
    configFile: false,
  });
  if (!result?.code) throw new Error(`Babel produced no output for ${filename}`);
  return result.code;
}
