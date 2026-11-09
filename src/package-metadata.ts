import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";

/** Return the installed version visible from a source file. Resolution is best
 * effort so instrumentation also works for virtual files and browser builds. */
export function resolvePackageVersion(packageName: string, fromFile: string): string {
  try {
    const localRequire = createRequire(path.resolve(fromFile));
    const manifest = localRequire.resolve(`${packageName}/package.json`);
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}
