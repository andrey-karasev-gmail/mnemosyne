# Mnemosyne

A TypeScript **source-to-source transpiler** that instruments regular TS code to record a
**linear tape** of every operation at runtime, reconstructing the full value-provenance path
across one or more "black box" functions — including internal local/global variable names.

Named after Mnemosyne, the Greek goddess of memory.

> **Debug / reverse-engineering tool only.** Performance is not a goal.

## How it works

JS/TS has no runtime operator overloading, and runtime wrapping cannot see internal variable
names (erased after compilation). Mnemosyne rewrites the **source AST at compile time** so:

- native operators (`+ - * / < >` ...) become traced calls, and
- variable names are read directly from the AST.

Tracing is **side-channel**: the real value flows through unchanged (identical program
results), while each operation records a node into a global tape. We capture a single,
linear, concrete execution path — no speculative branches.

## Architecture

- `src/transform.ts` — Babel plugin (AST-in / AST-out)
- `src/runtime.ts` — the `__t` side-channel tape (builds the DAG)
- `src/export-mermaid.ts` — DAG → JSON + Mermaid diagram / Graphviz DOT
- `src/pipeline.ts` — shared compile+run plumbing (used by both the CLI and the MCP server)
- `src/mcp-server.ts` — MCP server exposing the DAG to an AI agent
- `examples/example.ts` — demo with two black boxes (`priceBox`, `labelBox`), chained,
  using `process.env.TAX_RATE` and a module-level `const` to exercise env/constant capture

```mermaid
flowchart TD
  subgraph "Compile time"
    SRC["examples/example.ts"] -->|"Babel + transform.ts\n(AST-in / AST-out)"| GEN["Instrumented code"]
  end
  subgraph "Runtime"
    GEN -->|"runs in an isolated vm context"| TAPE["runtime.ts\nthe __t side-channel tape"]
  end
  subgraph "Export"
    TAPE --> MMD["export-mermaid.ts"]
    MMD --> OUT["JSON / Mermaid / DOT"]
  end
  subgraph "AI-helper"
    TAPE --> MCP["mcp-server.ts"]
    MCP -->|"run_trace, find_variable_origin,\nquery_causality, get_diagram,\nget_execution_summary"| AGENT["AI agent"]
  end
```

Each stage only knows the shape of what it consumes, not how the upstream one produced it —
the transpiler doesn't know how the tape stores nodes, and the renderer/MCP layer doesn't
know how nodes were produced.

## Running the pipeline

```bash
npm install
npm run trace       # transform + run examples/example.ts, write output/trace.{json,mmd}
```

This runs `examples/example.ts` twice — once plain (types stripped only), once
instrumented — and diffs their `console.log` output to prove the instrumentation is
behavior-preserving, before writing the tape to `output/trace.json` (raw DAG) and
`output/trace.mmd` (Mermaid diagram; paste into <https://mermaid.live>).

Other scripts:

```bash
npm run typecheck   # tsc --noEmit (see note below on memory)
npm run build       # tsc -p tsconfig.json -> dist/
```

> **Note:** `@modelcontextprotocol/sdk`'s tool-registration types combined with zod produce
> very deep generic instantiations that can exceed Node's default heap during type-checking.
> `typecheck`/`build` pass `--max-old-space-size=8192` for this reason. Runtime scripts
> (`trace`, `mcp`) use `ts-node --transpile-only` and are unaffected — they never hit this at
> startup.

## Running the MCP server

```bash
npm run mcp
```

This starts the Mnemosyne MCP server on **stdio**. To register it with an MCP-aware client
(e.g. Claude Code), add it to your MCP config, pointing `command`/`args` at this repo:

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["ts-node", "--transpile-only", "src/mcp-server.ts"],
      "cwd": "/absolute/path/to/mnemosyne"
    }
  }
}
```

Or with the Claude Code CLI:

```bash
claude mcp add mnemosyne -- npx ts-node --transpile-only src/mcp-server.ts
```

### Tools (vocabulary borrowed from [Chronos](https://github.com/Rubentxu/chronos))

| Tool | Purpose |
|------|---------|
| `run_trace` | Run the instrumented example once (optionally overriding env vars, e.g. `{ "TAX_RATE": "0.20" }`); caches the DAG. Call this first. |
| `find_variable_origin` | Given a variable/param name or output attribute (`"total"` or `"priceBox.total"`), return where it was set and its full ancestry. |
| `query_causality` | Trace a value backward (ancestry) or forward (descendants) through the DAG. |
| `get_diagram` | Mermaid diagram — the whole trace, or a sub-graph for one named value. |
| `get_execution_summary` | Inputs, output attributes, black boxes touched, node count. |

Every node carries: internal variable name, scope (`local`/`global`/`param`/`temp`/`const`/
`env`/...), the real runtime value on this run, and the exact source file + line/column.

This is the run-once, low-token AI-helper workflow: an agent calls `run_trace` once, then
answers debugging questions entirely from the cached DAG instead of re-reading and mentally
simulating the source on every question.

## Demo & slides

- `docs/DEMO.md` — a ~10 minute step-by-step walkthrough script (setup → prove behavior
  preservation → read the diagram → drive the MCP server live).
- `docs/presentation/Mnemosyne-Overview.pptx` — a slide deck covering the problem,
  architecture, live example, and roadmap (regenerate with
  `docs/presentation/build_deck.py`).
- `docs/FUTURE-EXTENSIONS.md` — the plan for tracing into external package source instead
  of stopping at the package boundary.

## Scope

See `CLAUDE.md` for the full spec. In scope: binary arithmetic and comparisons, generic
method calls, function calls, `const`/`let` bindings and simple assignment, `return`
(including per-attribute tracing of object-literal returns), and `process.env.*` / module
`const` capture. Deferred: short-circuit operators, compound assignment, template literals,
destructuring, spread, `async`/await, loops.

### Known limitation

Provenance across a call boundary is precise for named bindings and params, but coarse for
a bare property read off a black box's returned object (e.g. `priceBox(...).total` used
directly): since values are never wrapped, an object's per-property provenance isn't
attached to the object itself, so such a read resolves to "the object as a whole" rather
than the specific attribute. Binding the property to a local first (as `examples/example.ts`
does with `chainedTotal`) keeps ancestry precise from that point on.

## Status

Proof of concept. See `CLAUDE.md` for the full spec and scope.
