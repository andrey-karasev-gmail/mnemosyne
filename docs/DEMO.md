# Mnemosyne — Demo Script

A ~10 minute walkthrough proving the three claims that matter: (1) instrumentation doesn't
change program behavior, (2) the trace recovers real internal names, scopes, env-vars, and
per-attribute output provenance across two chained black boxes, and (3) an AI agent can
answer a debugging question from the cached DAG alone, without re-reading source.

Have two terminals open in the repo root, plus a browser tab on <https://mermaid.live>.

## 0. Setup (once)

```bash
npm install
```

## 1. Show the source (~1 min)

Open `examples/example.ts`. Point out, before running anything:

- `priceBox` and `labelBox` — the two "black boxes," chained (`labelBox` takes `priceBox`'s
  `total` as an input).
- `process.env.TAX_RATE` — an environment variable read.
- `GREETING` — a module-level constant.
- Nothing here is written any differently than normal TypeScript. That's the point: no
  manual instrumentation, no wrapper types.

## 2. Run the pipeline, prove behavior preservation (~2 min)

```bash
npm run trace
```

Expected output:

```
Identical output (plain vs. instrumented): true
Tape recorded 52 nodes.
Wrote output/trace.json and output/trace.mmd
```

Talking point: this line is the whole side-channel thesis in one sentence — the tool ran
`example.ts` **twice** (once with types stripped only, once fully instrumented) and diff'd
`console.log` output. `true` means instrumentation is provably behavior-preserving on this
run, not just "probably fine."

## 3. Walk the diagram (~2 min)

```bash
cat output/trace.mmd
```

Paste into <https://mermaid.live>. Walk the graph left to right and narrate:

- `process.env.TAX_RATE (env) = 0.08` → `.Number()` → `TAX_RATE (const)` — the env-var
  capture: real name, real value, exact line.
- `price (param)`, `qty (param)` → `*` → `subtotal (local)` → `*` → `tax (local)` → `+` →
  `total (local)` → `priceBox.total` — every intermediate local variable is a named node,
  not an anonymous computation.
- Separately, the `labelBox` half: `first (param)`.`trim()` and `last (param)`.`trim()` →
  string `+` chain → `labelBox.fullName` / `labelBox.summary`, with `GREETING` (module
  const) and the passed-through `total` feeding into `summary`.

Talking point: this is one Mermaid diagram spanning **both** black boxes and the env/const
inputs — the "reconstruct the whole calculation path" claim, visually.

## 4. Change an input, rerun (~1 min)

```bash
TAX_RATE=0.25 npm run trace
```

Node count stays the same (52) but open `output/trace.json` and grep for `"tax"` — the
values change (`tax` and `total` are now computed with the new rate). This proves the
diagram isn't a canned static picture; it's a real trace of this run's actual values.

## 5. Start the MCP server and query it live (~4 min)

```bash
npm run mcp
```

This blocks on stdio — it's meant to be driven by an MCP client, not typed into directly. If
you have Claude Code (or another MCP client) available, register it:

```bash
claude mcp add mnemosyne -- npx ts-node --transpile-only src/mcp-server.ts
```

Then, in a chat with that client, ask it to use the `mnemosyne` MCP server and:

1. **`run_trace`** — "Run the trace." (Call this first; everything else reads the cache.)
2. **`get_execution_summary`** — "Give me the execution summary." Shows inputs, output
   attributes, and which black boxes were touched — the one-shot orientation view.
3. **`find_variable_origin`** with `name: "priceBox.total"` — "Where did `priceBox.total`
   come from?" The agent gets back the full ancestry (env var → `TAX_RATE` → `price`/`qty` →
   `subtotal` → `tax` → `total` → output) in one call, with source lines — no need to open
   `example.ts` at all.
4. **`get_diagram`** with `name: "priceBox.total"` — a Mermaid sub-graph for just that
   attribute's ancestry (same idea as step 3, rendered).
5. **`run_trace`** again with `envOverrides: { "TAX_RATE": "0.5" }` — re-run with a different
   input and see the cached values update, without touching the filesystem or restarting the
   server.

Talking point: this is the run-once, low-token AI-helper workflow — an agent debugging "why
is `total` wrong" answers it from one cached DAG instead of tokenizing and mentally
simulating the source on every follow-up question.

## 6. Wrap-up talking points

- **Why AST rewriting, not runtime wrapping:** JS/TS has no operator overloading and erases
  variable names after compilation — both are recovered for free by transforming the source
  *before* it runs (same technique as Istanbul code coverage).
- **Side-channel, not value-wrapping:** the real value always flows through unchanged;
  tracing is a side effect on a separate tape. Program results are provably identical (step 2).
- **In scope today:** `+ - * / < > <= >= === !==`, generic method calls, function calls,
  `const`/`let`/simple-assignment bindings, `return` (including per-attribute tracing of
  object-literal returns), `process.env.*` / module-`const` capture.
- **Deferred:** short-circuit operators, compound assignment, template literals,
  destructuring, spread, `async`/await, loops — see `CLAUDE.md` for the full list and why.
- **Known limitation:** calling into an external package currently doesn't work at all (no
  `import`/`require` support in the sandbox yet), and even once it does, tracing stops at the
  package boundary — see `docs/FUTURE-EXTENSIONS.md` for the plan to extend into readable
  package source.
