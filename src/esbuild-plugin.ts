/**
 * esbuild has no AST-visitor plugin hook (unlike Babel) — its plugin API only exposes
 * onResolve/onLoad, where you hand esbuild source text for a file. So this plugin doesn't
 * reimplement instrumentation for esbuild's own parser: it hooks `onLoad`, runs the file
 * through the existing Babel-based `compile()` (type-strip + import/export lowering +
 * instrumentation, all in `transform.ts`), and hands esbuild the already-instrumented JS to
 * bundle. esbuild is the loader/bundler; Babel still does the actual rewriting.
 *
 * Instrumented code expects a global `__t` (see runtime.ts); call `installGlobalTape()` from
 * `./index` once, before the bundle runs, or bundled code will throw `__t is not defined`.
 */
import * as fs from "fs";
import * as path from "path";
import type { Plugin } from "esbuild";
import { compile } from "./compile";

export interface MnemosyneEsbuildPluginOptions {
  /** Which files to instrument. Defaults to `.ts`/`.tsx`. */
  filter?: RegExp;
  /**
   * Instrument matching files under node_modules too. Off by default: this project's
   * tracing model treats external packages as opaque (see CLAUDE.md's PoC scope).
   */
  includeNodeModules?: boolean;
}

export function mnemosyneEsbuildPlugin(options: MnemosyneEsbuildPluginOptions = {}): Plugin {
  const filter = options.filter ?? /\.tsx?$/;
  const includeNodeModules = options.includeNodeModules ?? false;

  return {
    name: "mnemosyne",
    setup(build) {
      build.onLoad({ filter }, (args) => {
        if (!includeNodeModules && args.path.split(path.sep).includes("node_modules")) {
          return undefined; // fall through to esbuild's default handling, untouched
        }
        const source = fs.readFileSync(args.path, "utf8");
        const contents = compile(source, true, args.path);
        return { contents, loader: "js" };
      });
    },
  };
}
