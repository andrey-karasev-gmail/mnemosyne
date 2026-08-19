/**
 * Resolve a relative import/require specifier to an absolute file path — the single source
 * of truth used both at compile time (src/transform.ts, to stamp a stable `modulePath` into
 * `__t.importBinding` calls) and at run time (src/module-loader.ts, to load/cache the file).
 * Both sides must agree on the resulting path for cross-file provenance edges to line up.
 */
import * as fs from "fs";
import * as path from "path";

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx", "/index.js"];

export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

export function resolveLocalModule(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`mnemosyne: cannot resolve local module "${specifier}" from "${fromFile}"`);
}
