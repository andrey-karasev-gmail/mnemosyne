# Mnemosyne — TypeScript Dataflow Tracing Transpiler (PoC)

Mnemosyne (Greek goddess of memory) is a **source-to-source transpiler** that instruments
regular TypeScript code so that, at runtime, it records a **linear tape** of every operation
performed — building a value-provenance DAG that lets you reconstruct the full calculation
path across one or more "black box" functions, including internal local/global variable names.

This is a **debug / reverse-engineering tool only**. Performance is explicitly not a goal.

## Why this exists

JS/TS has no runtime operator overloading, and runtime wrapping cannot see internal variable
names (they are erased after compilation). Rewriting the **source AST at compile time** solves
both: native operators become traced calls, and variable names are read directly from the AST.

## Core design decision: SIDE-CHANNEL tracing (NOT value-wrapping)

- The **real value flows through unchanged**. The program produces identical results.
- Each operation records a node into a **global tape** (`__t`) as a side effect, tagging the
  value with a lightweight id.
- We trace a **single, linear, concrete execution path** — the operations that actually ran,
  in order. NO speculative branches, NO "possible" deviations, NO symbolic abstraction.
- This keeps tracing decoupled from data flow and guarantees behavior preservation.

## Tooling

- **Babel** (`@babel/core`, `@babel/parser`, `@babel/traverse`, `@babel/generator`,
  `@babel/preset-typescript`). Chosen because `path.scope` gives binding classification
  (local / global / param / temp) and variable names for free. No type checker needed.
- TypeScript for the runtime library and exporter.
- Node.js, run with `ts-node` or compiled.

## Architecture — three decoupled components

1. **`src/transform.ts`** — Babel plugin. Pure AST-in / AST-out. Visitors rewrite nodes to
   `__t.*` calls, injecting `{ name, scope, loc }` metadata from `path.scope` and `node.loc`.
2. **`src/runtime.ts`** — the `__t` tape. Functions `op()`, `call()`, `bind()`, `ret()`.
   Assigns unique ids, records `{ id, kind, label, op, inputs[], value, loc }` into an
   in-memory DAG. Values pass through untouched (side-channel).
3. **`src/export-mermaid.ts`** — serialize the DAG to JSON and emit a Mermaid diagram
   (and optionally Graphviz DOT).
4. **`src/mcp-server.ts`** — an **MCP server** (first-class component) that runs the
   instrumented code ONCE, then exposes the resulting DAG to an AI agent as queryable tools
   plus a rendered diagram. This is the primary AI-helper payoff: the agent reads a compact
   provenance diagram instead of tokenizing and mentally simulating thousands of lines of
   source.
5. **`src/resolve-module.ts`**, **`src/compile.ts`**, **`src/module-loader.ts`** — support
   local (same-repo) multi-file tracing: resolve relative import specifiers to absolute
   paths, share one compile step between the entry file and its local imports, and run every
   traced file in one `vm` context sharing a single tape, so cross-file provenance edges are
   real DAG edges rather than opaque boundaries.
6. **`src/index.ts`** — the public package entry point for consumers who want to use the
   Babel plugin/runtime in their own project (as opposed to this repo's internal CLI/MCP
   tooling).

## MCP server — reuse proven tool vocabulary (do NOT reinvent)

Borrow the tool shapes proven by Chronos (github.com/Rubentxu/chronos). Do not invent new
names where a proven one fits. PoC MCP tools:

| Tool | Purpose |
|------|---------|
| `run_trace` | Run the instrumented program once; produce & cache the DAG. |
| `find_variable_origin` | Given a variable name (or output attribute), return where it was set and its full ancestry (inputs, ops, source lines). |
| `query_causality` | Trace a value backward/forward through the DAG. |
| `get_diagram` | Return the Mermaid diagram (whole DAG or a sub-graph for one value). |
| `get_execution_summary` | High-level overview: inputs, outputs, black boxes touched, node count. |

Each node/answer must carry: internal variable name, scope (local/global/param/temp),
**env-var / constant values** captured on this run, the real runtime value, and exact
source file + line/col. Keep the MCP layer decoupled — it consumes the tape/DAG produced by
the runtime, it does not know how nodes were produced.

Use the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`), stdio transport.

## PoC scope — IN

- Binary arithmetic: `+ - * /`
- Comparisons: `< > <= >= === !==`
- Short-circuit `&& || ??` (implemented via a thunk for the right-hand side so it's only
  evaluated/traced when not short-circuited)
- Method calls: generic `obj.method(args)` (covers `trim`, `split`, `concat`, and
  complex-type analogs `add` / `extract` / `multiply` / `divide`)
- Function calls: `f(x, y)` with argument-name capture
- Bindings: `const` / `let` declarations and simple assignments — capture variable name +
  scope kind (local / global / param)
- Returns: capture output, tie to enclosing function
- Environment variables / constants: when a value originates from `process.env.*` or a
  module-level `const`, capture its name AND its actual value on this run as a leaf node
- Local (same-repo) `import`/`export` across multiple files: relative-specifier imports and
  named/default exports are rewritten to CommonJS + tagged so the DAG resolves an
  `import { x } from "./other"` binding back to the real node in the exporting module,
  sharing one tape across every file via `src/module-loader.ts`
- ONE concrete linear execution path
- MCP server exposing the tools listed above (run-once → query the DAG)

## PoC scope — DEFERRED (do NOT implement yet)

- Compound assignment `+= ++`, unary ops, template literals, destructuring, spread
- `async` / `await`, generators
- Loops / per-iteration node aggregation
- Optional chaining `?.`
- Tracing into `node_modules` / external packages (imports are only resolved when the
  specifier is relative and points at a file inside this repo; bare specifiers fall through
  as opaque values)

## Rewrite mapping (reference)

| Source              | Rewritten to                                            |
|---------------------|---------------------------------------------------------|
| `a + b`             | `__t.op('+', a, b, {loc, lhs:'a', rhs:'b'})`            |
| `a < b`             | `__t.op('<', a, b, {...})`                              |
| `s.trim()`          | `__t.call(s, 'trim', [], {...})`                        |
| `const total = x`   | `const total = __t.bind('total', x, {scope, loc})`      |
| `f(x, y)`           | `__t.call(null, f, [x, y], {fn:'f', argNames:['x','y']})`|
| `return r`          | `return __t.ret('f', r)`                                |

## Deliverables

1. `src/transform.ts` — Babel plugin
2. `src/runtime.ts` — the `__t` side-channel tape
3. `src/export-mermaid.ts` — DAG → JSON + Mermaid
4. `src/mcp-server.ts` — MCP server (run-once → queryable DAG tools; Chronos-style vocabulary)
5. `examples/example.ts` — demo with TWO black boxes (one numeric, one string/date), using at
   least one `process.env.*` / module-level `const` to exercise env/constant capture
6. `README.md` — how to run the pipeline AND how to register the MCP server
7. `package.json`, `tsconfig.json`, `.babelrc`/babel config

## Success criteria

- Instrumented `example.ts` produces IDENTICAL results to the original.
- The trace correctly names inputs, internal local variables, output attributes, and
  env-var / constant values (name + actual value).
- The Mermaid diagram shows the full linear path across both black boxes, each op labeled
  with operation + source line.
- The MCP server answers `find_variable_origin` for an output attribute with the full
  ancestry (inputs, ops, source lines, env/constant values) and returns a diagram via
  `get_diagram` — demonstrating the run-once, low-token AI-helper workflow.

## Conventions

- Keep the three components decoupled: transpiler must not know how the tape stores nodes;
  renderer must not know how nodes were produced.
- Preserve left-to-right evaluation order; never double-evaluate a side-effecting expression.
- Node identity for the PoC: value-tagging via side-channel (each produced value gets an id;
  a fresh op result gets a fresh id).
- This is the `Andrey-Karasev_cvsh` GitHub account's repo.
