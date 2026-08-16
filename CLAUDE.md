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

## PoC scope — IN

- Binary arithmetic: `+ - * /`
- Comparisons: `< > <= >= === !==`
- Method calls: generic `obj.method(args)` (covers `trim`, `split`, `concat`, and
  complex-type analogs `add` / `extract` / `multiply` / `divide`)
- Function calls: `f(x, y)` with argument-name capture
- Bindings: `const` / `let` declarations and simple assignments — capture variable name +
  scope kind (local / global / param)
- Returns: capture output, tie to enclosing function
- ONE concrete linear execution path

## PoC scope — DEFERRED (do NOT implement yet)

- Short-circuit `&& || ?? ?:` (hard: needs careful lowering — leave out)
- Compound assignment `+= ++`, unary ops, template literals, destructuring, spread
- `async` / `await`, generators
- Loops / per-iteration node aggregation
- Optional chaining `?.`

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
4. `examples/example.ts` — demo with TWO black boxes (one numeric, one string/date)
5. `README.md` — how to run the pipeline
6. `package.json`, `tsconfig.json`, `.babelrc`/babel config

## Success criteria

- Instrumented `example.ts` produces IDENTICAL results to the original.
- The trace correctly names inputs, internal local variables, and output attributes.
- The Mermaid diagram shows the full linear path across both black boxes, each op labeled
  with operation + source line.

## Conventions

- Keep the three components decoupled: transpiler must not know how the tape stores nodes;
  renderer must not know how nodes were produced.
- Preserve left-to-right evaluation order; never double-evaluate a side-effecting expression.
- Node identity for the PoC: value-tagging via side-channel (each produced value gets an id;
  a fresh op result gets a fresh id).
- This is the `Andrey-Karasev_cvsh` GitHub account's repo.
