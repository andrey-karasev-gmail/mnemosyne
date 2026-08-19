/**
 * Runtime CommonJS-style loader for local (same-repo) imports, run inside the same `vm`
 * context as the entry file so every traced module shares one tape/DAG.
 *
 * Each module is compiled through the same plugin toggle as the entry file (`withPlugin`),
 * wrapped in a `(exports, require, module, __filename, __dirname, __t) => {...}` function
 * (the classic Node module-wrapper shape) so `require("./x")` resolves relative to *that*
 * file, not whichever file happened to trigger the load. Modules are cached by resolved
 * absolute path so re-imports return the same instance instead of re-running (which would
 * double-record tape nodes) — mirroring Node's own module cache.
 *
 * Decoupled from the transpiler: this file only calls `transformSync` with the plugin exactly
 * like pipeline.ts does; it has no idea how `transform.ts` rewrites anything.
 */
import * as fs from "fs";
import * as vm from "vm";
import { compile } from "./compile";
import { isRelativeSpecifier, resolveLocalModule } from "./resolve-module";
import type { Tape } from "./runtime";

export interface ModuleSystem {
  /** Resolve and load `specifier` as seen from `fromFile`. Bare specifiers fall through to
   * Node's own `require` (opaque, untraced) — only relative specifiers get the module wrapper. */
  requireModule(fromFile: string, specifier: string): unknown;
}

export function createModuleSystem(tape: Tape | undefined, context: vm.Context, withPlugin: boolean): ModuleSystem {
  const cache = new Map<string, unknown>();

  function requireModule(fromFile: string, specifier: string): unknown {
    if (!isRelativeSpecifier(specifier)) {
      return require(specifier);
    }

    const absPath = resolveLocalModule(fromFile, specifier);
    if (cache.has(absPath)) return cache.get(absPath);

    const source = fs.readFileSync(absPath, "utf8");
    const code = compile(source, withPlugin, absPath);
    const wrapped = `(function(exports, require, module, __filename, __dirname, __t) {\n${code}\n})`;
    const moduleFn = new vm.Script(wrapped, { filename: absPath }).runInContext(context) as (
      exports: Record<string, unknown>,
      require: (specifier: string) => unknown,
      module: { exports: Record<string, unknown> },
      filename: string,
      dirname: string,
      t: Tape | undefined,
    ) => void;

    const moduleObj = { exports: {} as Record<string, unknown> };
    cache.set(absPath, moduleObj.exports);

    if (tape) tape.enterFrame(`<module:${absPath}>`);
    try {
      moduleFn(
        moduleObj.exports,
        (childSpecifier: string) => requireModule(absPath, childSpecifier),
        moduleObj,
        absPath,
        absPath.slice(0, absPath.lastIndexOf("/")),
        tape,
      );
    } finally {
      if (tape) {
        tape.registerModule(absPath);
        tape.exitFrame();
      }
    }

    cache.set(absPath, moduleObj.exports);
    return moduleObj.exports;
  }

  return { requireModule };
}
