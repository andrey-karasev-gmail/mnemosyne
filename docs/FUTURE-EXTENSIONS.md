# Future extension: tracing into external package source

> Status: **plan only** — nothing in this document is implemented. It exists to record the
> approach, the concrete risks, and a phased path so the next work on this doesn't start from
> zero.

## Where things stand today (verified, not assumed)

Two separate problems, confirmed by direct repro rather than inferred:

1. **The pipeline can't run code that imports anything, at all.** `src/transform.ts` has no
   `ImportDeclaration` visitor (ES `import` passes through untouched), and
   `src/pipeline.ts`'s `runInSandbox` runs the compiled code via a plain `vm.Script` — not as
   an ES module, and without `require` injected into the sandbox. Result: `import * as path
   from "path"` fails with `Cannot use import statement outside a module`; `require("path")`
   fails with `require is not defined`.
2. **Even after patching the sandbox to inject `require`, tracing stops at the package
   boundary.** With `require` added, `p.basename("/a/b/c.txt")` runs fine and shows up as a
   *single opaque node* — `call basename inputs=[2,3] value=c.txt` — with no operations, no
   internal variable names, nothing inside it. That's expected: instrumentation only ever
   applies to source that's actually passed through `mnemosynePlugin`, which today is
   hardcoded to exactly one file (`examples/example.ts`). Node's `path` module runs as plain,
   un-instrumented JS.

(2) is arguably correct behavior for *any* untraced call — it's the same "black box" concept
the whole tool models. The question this document answers is: what would it take to make that
box *not* opaque, for packages where the user wants that?

## The idea (from this session's discussion)

Most npm packages' registry metadata (`GET https://registry.npmjs.org/<pkg>`) includes a
`repository` field pointing at the package's GitHub (or similar) repo. That repo commonly has
the **original, readable source** — the thing Mnemosyne's whole differentiator depends on —
whereas what's actually installed in `node_modules` is frequently the **built/minified
output** (`dist/`, `lib/`), which has already had its variable names erased by whatever
bundler produced it. So: instead of tracing what's in `node_modules`, resolve the package to
its repo, fetch the matching source from there, and run it through the same Babel plugin —
extending one continuous DAG across the import boundary.

```
1. Resolve npm registry metadata → repository field
2. Fetch matching source from that repo (not the minified dist)
3. Run the SAME Babel plugin over it → one continuous DAG
```

## Why this is harder than the three steps above suggest

- **The repo's source doesn't reliably map to the installed import path.** A package's
  `package.json` `main`/`exports` almost always points into `dist/`/`lib/`/`build/` — output
  that's frequently *not even committed* to the repo (it's `.gitignore`d, produced by CI at
  publish time). So `require("lodash/map")` resolving to `node_modules/lodash/map.js` has no
  guaranteed counterpart path in the git tree; the repo might have `src/map.ts`, might have
  it under a completely different name, might generate it from a template. Mapping "the
  public import surface" back to "the source file that produces it" needs either reading the
  package's own build config (tsconfig paths, bundler entry points) or a per-package
  heuristic — there's no universal rule.
- **Version pinning is not just "clone the repo."** The installed version
  (`node_modules/<pkg>/package.json`'s `version`) needs to map to a specific git ref, not
  whatever's on the default branch right now — a floating `HEAD` would silently trace the
  wrong code. Convention is a tag like `v4.17.21` or `4.17.21`, but not every project tags
  every release, and tag format varies. Should pin to an immutable commit SHA once resolved,
  not a mutable tag/branch, so a re-run six months later doesn't trace something different.
- **Monorepos.** A huge share of real dependencies (Babel itself, many `@scope/*` packages)
  publish many independently-versioned packages from one repo, in subdirectories, sometimes
  with per-package tag prefixes (`@babel/core@7.29.7` vs. a bare `v7.29.7`). Resolving "this
  npm package version" to "this subdirectory at this commit" needs monorepo-aware logic, not
  a flat clone.
- **Missing/wrong/private repos.** Some packages have no `repository` field, a stale one
  (pointing at a fork, a rename, or a dead URL), or a private repo the trace process has no
  access to. Needs a graceful "stay opaque" fallback, not a hard failure.
- **Syntax breadth.** The current plugin's scope is deliberately narrow (see `CLAUDE.md`).
  Arbitrary third-party source will use everything currently deferred — destructuring,
  spread, template literals, async/await, classes, decorators, JSX, sometimes Flow types.
  Tracing "everything a real package uses" is a much bigger surface than tracing one
  example file; the plugin would need to at minimum *pass through untraced* anything it
  doesn't understand rather than erroring the whole compile (mostly already true — the
  transform's visitors bail out on unsupported shapes today, but this has only been
  exercised against the one deliberately-narrow example file, not real-world code).
- **Security.** Node's `vm` module is explicitly not a security boundary (its own docs say
  so), and `runInSandbox` currently hands traced code the real `process` object. That's a
  contained risk for a first-party example file; it stops being contained the moment the
  pipeline starts **fetching and executing code from the internet at trace time**. At minimum
  this needs: pin to an immutable commit SHA (not a branch), explicit per-package opt-in
  (never automatic for the whole dependency tree), and a real sandbox story before this is
  anything but a local, trusted-input tool.
- **Blast radius / scope explosion.** A single `import` can transitively pull in dozens of
  packages. "Trace everything imported" by default would make traces enormous and slow (even
  though raw performance is explicitly not a goal, *usability* of a 10,000-node diagram is a
  separate concern) and multiplies every risk above. An explicit allow-list — "expand these
  specific packages into full tracing; leave everything else as an opaque call, same as
  today" — is very likely the right default, not an opt-out.

## Proposed phased approach

1. **Phase 0 — make imports run at all, independent of package tracing.** Add
   `ImportDeclaration`/`require` support so traced code can at least *call into* a package as
   today's opaque black box: inject `require` into the sandbox (or switch the runner to
   Node's ESM loader hooks for `import`), and decide whether `import`/`require` call sites
   themselves need any transform-time handling (a plain `require("pkg")` call is already
   swept up generically by the existing `CallExpression` visitor as "a plain identifier
   callee" — it just needs a working `require` at runtime). This alone fixes the "doesn't
   even run" problem and is a much smaller, self-contained change worth shipping on its own.
2. **Phase 1 — manual override, no automatic resolution.** Let a config explicitly map one
   package name to a local path of its readable source (e.g. a checked-out clone), and trace
   *that* instead of `node_modules`. No registry lookups, no git fetching, no version
   matching — this phase exists purely to prove "one continuous DAG across an import
   boundary" works end to end, against one real, hand-picked dependency, before automating
   any discovery.
3. **Phase 2 — automate registry → repo resolution for the easy case.** Registry lookup +
   `repository` field + tag-matching + shallow fetch, scoped to single-package (non-monorepo)
   repos with a conventional tag scheme and an import path that maps cleanly to `src/`.
   Explicitly framed as best-effort and opt-in per package — expected to fail gracefully
   (fall back to opaque tracing) for anything that doesn't fit this shape, which will be a
   large fraction of real packages.
4. **Phase 3 — the hard remainder, lowest priority.** Monorepo-aware resolution, a local
   cache keyed by package+resolved-commit (so the "run once" MCP workflow doesn't refetch
   every time), commit-SHA pinning with provenance/checksum verification, and broadening the
   transform's syntax coverage to match real-world usage rather than the PoC's narrow scope.

## Open questions to resolve before Phase 2 (not answered here)

- Where does the fetched source live — a project-local cache directory, checked into nothing,
  gitignored? How is staleness/invalidation handled?
- Is there a existing, maintained library for "resolve npm package → git repo → matching
  ref" worth depending on, rather than hand-rolling registry/tag-matching heuristics?
- Should cross-boundary node identity (see the README's "Known limitation" and the call/param
  disconnect noted in review) be fixed at the same time, since it becomes far more visible
  once package internals are actually traced?
