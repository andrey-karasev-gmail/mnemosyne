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
 *
 * The preset and the plugin are passed as imported objects, never as name strings:
 * Babel resolves string names relative to the *consumer's* project root, so a package
 * consumer that does not happen to have these packages at its own root fails with
 * "Cannot find module" even though they are installed inside this package.
 */
/// <reference path="./babel-modules.d.ts" />
import { transformSync } from "@babel/core";
import presetTypescript from "@babel/preset-typescript";
import pluginTransformModulesCommonjs from "@babel/plugin-transform-modules-commonjs";
import mnemosynePlugin from "./transform";

export function compile(source: string, withPlugin: boolean, filename: string): string {
  const result = transformSync(source, {
    filename,
    presets: [[presetTypescript, {}]],
    plugins: withPlugin ? [mnemosynePlugin] : [pluginTransformModulesCommonjs],
    babelrc: false,
    configFile: false,
  });
  if (!result?.code) throw new Error(`Babel produced no output for ${filename}`);
  return result.code;
}
