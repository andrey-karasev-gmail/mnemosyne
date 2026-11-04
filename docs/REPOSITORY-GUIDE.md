# Mnemosyne: Comprehensive Repository Guide

> **Repository:** [`andrey-karasev-gmail/mnemosyne`](https://github.com/andrey-karasev-gmail/mnemosyne)  
> **Documented branch:** `main`  
> **Snapshot documented:** `782f36406ff31446555cbbb3a9aa143e6261ff6f`  
> **Package:** `@web4w3/mnemosyne`  
> **License:** MIT  
> **Status:** Proof of concept; intended for debugging, reverse engineering, and execution-flow exploration—not production performance.

This guide explains the repository’s purpose, architecture, tracing model, implementation files, examples, developer commands, package interfaces, and known constraints. It is an orientation document derived from the repository snapshot above; code and behavior may evolve on later commits.

## Contents

1. [Project at a glance](#project-at-a-glance)
2. [The problem Mnemosyne addresses](#the-problem-mnemosyne-addresses)
3. [Core concepts](#core-concepts)
4. [Architecture and data flow](#architecture-and-data-flow)
5. [What gets recorded](#what-gets-recorded)
6. [Transformation behavior](#transformation-behavior)
7. [Runtime tape behavior](#runtime-tape-behavior)
8. [Multi-file tracing](#multi-file-tracing)
9. [Export formats and graph queries](#export-formats-and-graph-queries)
10. [MCP server and AI-agent workflow](#mcp-server-and-ai-agent-workflow)
11. [Repository map](#repository-map)
12. [Examples explained](#examples-explained)
13. [Installation and development commands](#installation-and-development-commands)
14. [Using Mnemosyne as a package](#using-mnemosyne-as-a-package)
15. [Build, types, and dependencies](#build-types-and-dependencies)
16. [Publishing workflow](#publishing-workflow)
17. [Scope and limitations](#scope-and-limitations)
18. [Security and operational considerations](#security-and-operational-considerations)
19. [Design rationale](#design-rationale)
20. [Roadmap and future extensions](#roadmap-and-future-extensions)
21. [Suggested exploration path](#suggested-exploration-path)
22. [Glossary](#glossary)
23. [References within this repository](#references-within-this-repository)

---

## Project at a glance

Mnemosyne is a TypeScript source-to-source instrumentation tool. It rewrites TypeScript syntax with Babel so that a program, when executed, records a concrete trace of the values and operations that actually occurred. The trace is represented as a directed acyclic graph (DAG), with operation and binding nodes connected to the nodes that supplied their inputs.

The repository description captures the product direction: **“Source-to-source TS transpiler that traces dataflow into a value-provenance DAG, served over MCP.”** The implementation combines several pieces:

- A Babel plugin that rewrites supported syntax and embeds names and source locations.
- A runtime `Tape` that evaluates real operations and records their provenance.
- Exporters for JSON, Mermaid, and Graphviz DOT.
- A local module loader and shared pipeline for tracing relative imports across files.
- A command-line example runner and an MCP server that exposes trace queries to compatible clients.
- A public package entry point for using the plugin and runtime in another project.

The goal is not to speed up execution. Instrumentation adds calls and graph writes, so this is a debugging and analysis lens rather than a production optimization. It records **one concrete run**, not every behavior a program could exhibit.

## The problem Mnemosyne addresses

Ordinary JavaScript and TypeScript do not provide runtime operator overloading for primitives such as numbers and strings. After compilation, source-level names such as `subtotal` and `tax` are also unavailable to a generic runtime observer unless the code is specially instrumented. A proxy or wrapper can observe some property and method activity, but wrapping primitive values can change behavior and does not reliably recover the original local variable names.

Mnemosyne moves the observation point to compile time, while the source AST still contains the original syntax. For example, the AST for:

```ts
const subtotal = price * qty;
```

contains the binding name, operator, operands, and source position. The plugin can generate a call that performs the multiplication and reports its inputs to the tape. A later question such as “where did `priceBox.total` come from?” can then be answered by walking graph edges backward instead of manually simulating each line.

The intended use cases include:

- Debugging a surprising calculated value.
- Understanding how intermediate values are composed inside a function.
- Exploring flows across chained functions and local modules.
- Capturing environment-variable values and module-level constants used in a trace.
- Giving an MCP-capable AI client a compact, execution-derived view of a computation.
- Producing a Mermaid or DOT diagram that can be inspected independently of the MCP server.

## Core concepts

### Source instrumentation

The Babel plugin visits selected AST nodes and replaces or augments them with calls to the tape API, represented in instrumented code by the free identifier `__t`. Metadata such as operand names, binding scopes, file paths, and line/column positions comes from the source AST.

### Side-channel values

The program continues to use ordinary runtime values. Mnemosyne records provenance as a side effect and returns the actual computed or passed-through value. This avoids replacing every number, string, or object with a wrapper. The repository’s pipeline also provides a practical behavior-preservation check: it runs the example once without instrumentation and once with instrumentation, then compares captured `console.log` output.

This comparison is evidence for the example run; it should not be read as a formal proof for every possible source program or every side effect.

### Linear concrete execution

The graph represents operations that occurred in one execution and in their observed order. It does not enumerate branches that were not taken, symbolically explore paths, or predict values for other inputs. Re-run with different inputs to obtain another concrete trace.

### Provenance DAG

Each node has a unique integer ID and an `inputs` list of node IDs. The input IDs point to the values consumed by that node. A chain of operations therefore becomes a DAG even though the recorded operations are appended to a linear tape.

### Frames and named values

The runtime keeps a stack of frames. Parameters, bindings, and module-level values are associated with nodes in frames, and identifier provenance is resolved by searching frames from the innermost outward. This provides a runtime lookup that mirrors lexical name lookup for the tracing model. Module frames also track exports so a local importer can connect its import binding to the originating module’s node.

## Architecture and data flow

At a high level, the repository’s tracing pipeline is:

```text
TypeScript source
       |
       v
Babel compile step (TypeScript syntax removal)
       |
       +---- plain compile: CommonJS module lowering, no Mnemosyne instrumentation
       |
       +---- instrumented compile: Mnemosyne Babel plugin
                           |
                           v
                executable CommonJS-shaped JavaScript
                           |
                           v
                isolated Node vm context
                           |
                           v
                __t runtime Tape records nodes
                           |
                 +---------+----------+
                 |                    |
                 v                    v
          JSON / Mermaid / DOT    MCP query tools
```

For local imports, the module loader compiles each relative target consistently with the entry run, executes it in the same VM context, and shares the same tape. External/bare module specifiers use Node’s `require` path and are not expanded into source-level tracing by the local module loader.

The layers are intentionally separated:

1. **Compile/transform:** understands source syntax and emits runtime calls plus metadata.
2. **Runtime tape:** evaluates operations, resolves provenance, and stores plain `TapeNode` records.
3. **Export/query layer:** reads node records and renders or traverses them without needing to know how the Babel transform produced them.
4. **Pipeline/entrypoints:** wire source loading, plain-vs-instrumented execution, output files, and MCP transport together.

## What gets recorded

The central runtime type is `TapeNode`. A node includes:

| Field | Meaning |
|---|---|
| `id` | Numeric ID assigned as nodes are appended to the tape. |
| `kind` | Category such as `input`, `op`, `call`, `bind`, `return`, `output`, or `literal`. |
| `op` | Operator or method/function name when applicable. |
| `label` | Human-readable identifier, operation, or output label. |
| `scope` | Category such as `local`, `global`, `param`, `const`, `env`, `literal`, `output`, `return`, or `import`. |
| `inputs` | IDs of parent nodes that supplied inputs to this node. |
| `value` | The runtime value observed in this execution. |
| `loc` | Optional source file, line, and column. |
| `fn` | Optional function name for function-associated return/output nodes. |

A parameter becomes an input node. A literal operand can become a literal leaf. An arithmetic operation points to its operand nodes. A binding node gives an intermediate expression its original variable name. A return-object attribute can be represented as a named output node such as `priceBox.total`.

The exporter’s `safeStringify` helper handles `BigInt` by converting it to a string representation and handles circular object references with a marker. This is useful because values can include objects and the same object identity may appear in multiple trace nodes.

## Transformation behavior

`src/transform.ts` is the Babel plugin. It produces calls to the tape API and avoids recursively transforming calls it generated itself by recognizing `__t.*` calls.

### Supported operation families in this snapshot

- Binary arithmetic: `+`, `-`, `*`, `/`.
- Comparisons: `<`, `>`, `<=`, `>=`, `===`, `!==`.
- Logical short-circuit operators: `&&`, `||`, `??`, with the right operand represented as a thunk so it is only evaluated when native short-circuit semantics require it.
- Generic non-computed member-method calls such as `value.trim()`.
- Calls through a simple identifier, such as `priceBox(price, qty)`.
- `const`/`let`/`var` declarations with simple identifier bindings and initializers, plus simple `=` assignment to an identifier.
- Named parameters on function declarations.
- Returns from named function declarations; object-literal return properties can be recorded individually as output nodes.
- Reads of direct `process.env.NAME` member expressions.
- Supported local `import`/`export` forms for same-repository module tracing.

The plugin’s visitors are syntax-directed. Unsupported AST shapes are either left alone or, for explicitly rejected module forms, raise a Babel code-frame error. This means the transformation should not be assumed to cover arbitrary TypeScript/JavaScript constructs merely because Babel can parse them.

### Illustrative rewrite patterns

These are conceptual examples of the generated calls; actual emitted metadata includes source positions and operand descriptions.

| Original source | Instrumentation concept |
|---|---|
| `a + b` | Call the runtime operation function with `+`, values, and operand metadata. |
| `price * qty` | Compute using native multiplication, record both parent nodes, return the product. |
| `item.trim()` | Invoke the actual method on the actual receiver and record the call and input provenance. |
| `const total = subtotal + tax` | Evaluate the expression, then record a binding labeled `total`. |
| `return { total }` | Record a named `functionName.total` output and a function return node. |
| `process.env.TAX_RATE` | Capture the current environment value as an input node, without changing its value. |

### Evaluation-order concerns

Instrumentation must not eagerly evaluate expressions that JavaScript would short-circuit, nor evaluate non-trivial method receivers twice. The transform wraps the right side of logical expressions in a thunk and, when needed, hoists a complex receiver into a temporary to avoid duplicate evaluation. These precautions are central to preserving observable program behavior.

## Runtime tape behavior

`src/runtime.ts` defines the graph model and `Tape` implementation.

### Node creation and IDs

`addNode` assigns the next node ID from the current `nodes.length`, stores the node, and updates the tape’s last-node ID. `reset()` clears nodes, resets the frame stack and last-node state, and clears cached module export maps before a fresh run.

### Operand resolution

The transform emits operand metadata with one of three broad forms:

- **Identifier:** resolve the name through the active frame stack. If no recorded binding exists, create a global input leaf with the runtime value.
- **Literal:** create a fresh literal node for that operand.
- **Expression:** use the most recently created node, relying on nested instrumented calls running before their enclosing operation.

That last-node fallback is a compact mechanism tied to the transform’s evaluation order and current supported syntax. It is not a universal value-identity system; aliasing, mutation, and more complex expression constructs deserve care when extending the implementation.

### Operations and calls

`Tape.op` computes supported primitive operations using JavaScript’s native semantics, resolves operand parent IDs, records an `op` node, and returns the computed result. `Tape.logical` selects the native short-circuit outcome and only invokes the right thunk when required. `Tape.call` resolves receiver and argument provenance before invoking the method or function, then records the call result. Resolving inputs before invocation matters because a traced function can append many nodes during the call.

### Bindings and scopes

`Tape.bind` records a named binding and its source node. Declarations add or replace the binding in the current frame. Assignments search outward for an existing binding and update it; if no matching binding is found, the runtime records it in the current frame.

Function frames are created by instrumented named function declarations. Parameters are registered as input nodes. Return instrumentation records a return node and pops the frame. The runtime also unwinds a leaked function frame after a thrown call so later provenance lookups are not left at the wrong frame depth.

### Environment values and outputs

`Tape.envVar` records a captured `process.env` value as an environment input. `Tape.output` associates a returned object property with a function-qualified label. `Tape.ret` records the function return. These entries make it possible to query an individual result attribute instead of treating a returned object only as one opaque value.

### Module export/import links

The transform emits `recordExport` calls and tagged `importBinding` calls for supported local imports. The module frame stores export-name-to-local-name relationships. Once a module completes, `registerModule` snapshots those names to node IDs. When an importer executes, `importBinding` can add a bind node whose input points at the exporting module’s node, preserving an edge across a local file boundary.

## Multi-file tracing

The multi-file flow uses three helpers:

1. **`resolve-module.ts`** classifies relative specifiers and resolves them against the importing file. It checks a small candidate list: the exact path, `.ts`, `.tsx`, `.js`, and common `index` variants.
2. **`compile.ts`** offers one compile entry point for both entry files and their local imports. Instrumented mode uses the Mnemosyne plugin. Plain comparison mode uses Babel’s CommonJS transform plugin so imports and exports remain executable in a `vm.Script` context.
3. **`module-loader.ts`** loads relative imports with a CommonJS-shaped wrapper in the shared VM context. It caches modules by resolved absolute path, matching the important Node behavior of not executing the same module repeatedly. Bare specifiers delegate to Node’s own `require` and are opaque to local-source tracing.

The compile-time transform and runtime loader share `resolveLocalModule`. This is important: the source path stamped into an import-binding node must match the path used by the loader when it registers the exporting module. A mismatch would prevent the importer’s provenance edge from finding the origin node.

`pipeline.ts` runs the entry program in a sandbox context with `process`, a log-capturing `console`, the tape when instrumented, and a `require` function backed by the local module system. Both the entry and local imports receive the same plain/instrumented mode for each side of the comparison.

## Export formats and graph queries

`src/export-mermaid.ts` works from `TapeNode[]` and offers several utilities:

- **`toJSON(nodes)`** produces indented JSON with the node collection.
- **`toMermaid(nodes)`** emits a Mermaid `graph TD` diagram. Each input node ID is connected to its consuming node.
- **`toDot(nodes)`** emits Graphviz DOT with a top-to-bottom layout.
- **`subgraphFrom(nodes, rootId)`** walks backward through `inputs` to produce the ancestry of a target.
- **`descendantsOf(nodes, rootId)`** walks forward to find nodes that transitively depend on a target.
- **`safeStringify(value, space?)`** safely serializes common special trace value shapes, including BigInt and circular references.

The ancestry helper first builds a map by ID and walks parent links. The descendant helper checks which nodes list the current ID as an input. Both return nodes ordered by ID, preserving the recorded order in the selected subgraph.

Diagram labels include the node’s readable name or operation, a formatted runtime value, and a line marker when source location is available. Large values are shortened for diagram readability; JSON retains the richer node data.

## MCP server and AI-agent workflow

`src/mcp-server.ts` starts an MCP server using the official TypeScript SDK and stdio transport. The server exposes the trace through five tools:

| Tool | Purpose |
|---|---|
| `run_trace` | Execute the example with optional environment overrides, compare plain and instrumented logs, cache the graph, and report a summary. |
| `find_variable_origin` | Find a matching variable or output label and return its node description, ancestry, and Mermaid subgraph. |
| `query_causality` | Return backward ancestry or forward descendants for a named node. |
| `get_diagram` | Return the full Mermaid graph or the ancestry graph for a requested name. |
| `get_execution_summary` | Summarize input nodes, output nodes, functions touched, and total node count. |

`run_trace` may be called again with different string environment-variable overrides; this refreshes the cached graph for subsequent queries. If queries happen before an explicit run, the server lazily creates a trace through `ensureTrace`.

Name resolution accepts an exact label. If no exact label matches, it also searches for labels ending in `.<name>`, which supports requests such as `total` matching a qualified output such as `priceBox.total`. Ambiguous names can refer to multiple locals, parameters, or outputs, so the server returns the most recently recorded match and includes a note listing candidates. Qualified names are preferable when precision matters.

A typical client workflow is:

1. Call `run_trace` to produce/cache a graph.
2. Call `get_execution_summary` to orient yourself to inputs and outputs.
3. Ask `find_variable_origin` for a qualified output such as `priceBox.total`.
4. Use `query_causality` for backward or forward exploration, or `get_diagram` for a visual subgraph.
5. If investigating a different environment input, run again with an `envOverrides` object.

Example MCP configuration (adapt the absolute working directory to your checkout):

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

The server is designed for an MCP client; running `npm run mcp` directly starts a stdio process rather than an interactive terminal command prompt.

## Repository map

```text
.
├── .github/
│   └── workflows/
│       └── publish.yml             # npm publishing workflow
├── docs/
│   ├── DEMO.md                     # walkthrough script
│   ├── DESIGN.md                   # concept, motivation, design notes
│   ├── FUTURE-EXTENSIONS.md        # plan for external package source tracing
│   └── presentation/
│       ├── Mnemosyne-Overview.pptx # presentation deck
│       └── build_deck.py           # deck-generation script
├── examples/
│   ├── example.ts                  # one-file pricing + label example
│   └── multi-file/
│       ├── label-box.ts            # exported string-label function
│       ├── main.ts                 # imports and chains both functions
│       └── price-box.ts            # exported pricing function
├── src/
│   ├── compile.ts                  # shared plain/instrumented compile step
│   ├── esbuild-plugin.ts           # optional esbuild integration
│   ├── export-mermaid.ts           # JSON, Mermaid, DOT, graph traversal
│   ├── index.ts                    # public package entry point
│   ├── mcp-server.ts               # MCP tools and stdio server
│   ├── module-loader.ts            # local CommonJS-style VM loader
│   ├── pipeline.ts                 # run plain and instrumented programs
│   ├── resolve-module.ts           # relative module path resolution
│   ├── run-example.ts              # command-line runner and file output
│   ├── runtime.ts                  # Tape, node types, runtime operations
│   └── transform.ts                # Babel instrumentation plugin
├── babel.config.js                # standalone/reference Babel configuration
├── package.json                   # package metadata, exports, scripts, dependencies
├── package-lock.json              # locked dependency graph
├── tsconfig.json                  # TypeScript compiler settings
├── CLAUDE.md                      # detailed project specification and conventions
├── LICENSE                        # MIT license
└── README.md                      # quickstart and product overview
```

Generated directories such as `node_modules/`, `dist/`, and `output/` are excluded by `.gitignore`.

### Main source files in more detail

#### `src/transform.ts`

The compile-time heart of the project. It defines helpers for generated tape member/call expressions, source location literals, operand descriptions, and scope classification. Its visitors handle environment reads, supported imports and exports, binary and logical expressions, supported calls, simple bindings and assignments, returns, and named function declarations.

A key implementation detail is that instrumented calls are themselves `CallExpression` nodes. `isTapeCall` prevents a later visitor pass from instrumenting the plugin’s own generated calls again.

#### `src/runtime.ts`

Defines public node and metadata types, operation evaluation, frame management, provenance resolution, local module export bookkeeping, and the `Tape` class. It exports both the class for isolated traces and a shared `__t` singleton for convenience.

#### `src/compile.ts`

Centralizes Babel invocation. Both modes strip TypeScript syntax. Instrumented mode applies the Mnemosyne transform, which also lowers the supported module forms. Plain mode applies Babel’s official CommonJS module transform, deliberately omitting Mnemosyne instrumentation for comparison.

#### `src/pipeline.ts`

Coordinates reading the entry file, environment overrides, plain execution, tape reset, instrumented execution, log capture, and equality comparison. It is shared by the CLI and MCP server.

#### `src/module-loader.ts` and `src/resolve-module.ts`

Together support same-repository relative dependencies. The resolver is shared at compile and runtime so module identity remains consistent. The loader caches resolved module paths and runs wrapped modules in the VM context that owns the trace.

#### `src/export-mermaid.ts`

Contains all graph serialization and traversal helpers. It takes plain node records, maintaining separation from the Babel transform and tape implementation.

#### `src/mcp-server.ts`

Adapts the pipeline and graph utilities to MCP tool schemas. It caches one latest trace and serves JSON/text/Mermaid results over stdio.

#### `src/run-example.ts`

CLI entry point. It runs the default example or an optional entry file, reports whether logs matched, and writes the trace JSON and Mermaid output under `output/`.

#### `src/index.ts`

Public package surface: plugin, tape class/singleton, type exports, graph utility exports, and `installGlobalTape` for making the tape available to transformed code that expects global `__t`.

#### `src/esbuild-plugin.ts`

esbuild’s plugin hook does not provide Babel-style AST visitors. This integration hooks `onLoad`, reads matching source files, runs the same Babel-based `compile()` instrumentation, and returns transformed JavaScript for esbuild to bundle. Babel remains responsible for source rewriting; esbuild provides bundling. By default, `.ts`/`.tsx` files are matched and `node_modules` paths are skipped.

## Examples explained

### One-file example

`examples/example.ts` defines two functions and chains them:

- `priceBox(price, qty)` calculates `subtotal`, `tax`, and `total`, then derives `isPremium` from a comparison.
- `labelBox(first, last, total)` trims names, joins them, and formats a summary string.
- `TAX_RATE` is read from `process.env` and converted to a number.
- `GREETING` is a module-level constant used in the output string.
- The result from `priceBox` is read into `chainedTotal` before being passed to `labelBox`.

This showcases numeric operations, comparisons, method calls, module constants, environment capture, intermediate local names, per-property returned outputs, and provenance spanning a function-call chain.

At the default tax rate of `0.08`, the price calculation is conceptually:

```text
price = 19.99
qty = 3
subtotal = price * qty = 59.97
tax = subtotal * TAX_RATE = 4.7976
total = subtotal + tax = 64.7676
```

The graph can connect `priceBox.total` back to the inputs and captured rate. The label function then uses the chained value in its summary computation.

### Multi-file example

The `examples/multi-file/` variant separates the pricing and label functions into separate source files. `main.ts` imports both, calls the pricing function, binds its `total` property, and passes that value to the label function.

This exercises relative imports/exports, module loading, caching, shared tape identity, and import-binding nodes. It is useful for confirming that provenance continues through local module boundaries rather than stopping at each file.

### Running a custom entry file

The CLI accepts an optional entry path, for example:

```bash
npx ts-node --transpile-only src/run-example.ts examples/multi-file/main.ts
```

The runner chooses a filename suffix for non-default entries to avoid replacing the default trace output. It writes JSON and Mermaid artifacts into `output/`.

## Installation and development commands

Use a Node.js/npm environment compatible with the project’s dependency set. The CI publishing workflow uses Node 24.

```bash
npm install
```

Available package scripts:

```bash
npm run trace            # trace examples/example.ts
npm run trace:multifile  # trace examples/multi-file/main.ts
npm run mcp              # start MCP server on stdio
npm run typecheck        # TypeScript check without emitting files
npm run build            # emit compiled files and declarations into dist/
```

The trace command runs the selected entry in plain and instrumented modes, compares captured logs, reports the node count, and writes `output/trace.json` and `output/trace.mmd` (with a suffix for a non-default example). The generated Mermaid text can be opened in a Mermaid viewer.

`typecheck` and `build` set Node’s old-space limit to 8192 MB because the MCP SDK tool-registration types combined with Zod can produce deep TypeScript generic instantiations. Runtime scripts use `ts-node --transpile-only` and therefore do not run the full typechecker at startup.

## Using Mnemosyne as a package

The package name is `@web4w3/mnemosyne`. Its package exports provide the root API and an `./esbuild` subpath. The root entry exports:

- `mnemosynePlugin`
- `Tape` and the shared `__t`
- `installGlobalTape`
- `TapeNode`, `Loc`, `NodeKind`, `ScopeKind`, `OperandKind`, and `OperandMeta` types
- Graph utilities: `toJSON`, `toMermaid`, `toDot`, `subgraphFrom`, `descendantsOf`, and `safeStringify`

A typical Babel use needs the TypeScript preset, the Mnemosyne plugin, and a tape made globally available before executing transformed code. For isolation, consumers can create a fresh `Tape` per run instead of sharing the default singleton.

Conceptually:

```js
const { mnemosynePlugin } = require("@web4w3/mnemosyne");

module.exports = {
  presets: [["@babel/preset-typescript", {}]],
  plugins: [mnemosynePlugin],
};
```

The generated code references a free/global `__t`. The package provides `installGlobalTape(tape?)` to install a tape on `globalThis`, or consumers can arrange an equivalent binding in their execution context.

### esbuild integration

The optional `@web4w3/mnemosyne/esbuild` export provides `mnemosyneEsbuildPlugin`. esbuild is an optional peer dependency, so users who do not use that subpath do not need to rely on esbuild being installed as a peer. The plugin’s options include:

- `filter`: a regular expression selecting files to process; defaults to TypeScript/TSX extensions.
- `includeNodeModules`: whether matching files under `node_modules` should be instrumented; defaults to false.

The Babel transform still does the instrumentation. esbuild bundles the already-transformed code. As with direct plugin use, install the global tape before running the bundle.

## Build, types, and dependencies

The package is configured as CommonJS. Its root `main` and `types` entries point to generated files under `dist/src/`. The `exports` map also exposes the esbuild plugin subpath. `tsconfig.json` uses strict checking, emits declarations and source maps, targets ES2020, and includes `src` and `examples`.

The primary dependency groups are:

- **Babel:** core, TypeScript preset, parser/traverse/generator/types ecosystem, and CommonJS transform support for the plain baseline.
- **MCP and validation:** `@modelcontextprotocol/sdk` and `zod`.
- **Development/runtime tooling:** TypeScript, `ts-node`, Node type definitions, and esbuild for local development/testing of the optional integration.

The package’s runtime Babel packages are regular dependencies because they perform the actual AST rewriting. esbuild is declared as an optional peer dependency.

## Publishing workflow

`.github/workflows/publish.yml` runs on pushes to `main`. In broad strokes, the workflow:

1. Checks out the repository.
2. Sets up Node 24 and npm registry configuration.
3. Installs the lockfile dependencies with `npm ci`.
4. Runs typecheck, build, and the behavior-comparison trace.
5. Increments the patch version without creating a version commit yet.
6. Publishes to npm using the configured trusted-publishing/OIDC setup.
7. After a successful publish, commits the bumped package metadata, tags the version, and pushes the release commit/tag.

The workflow requires trusted publishing to be configured for the repository/workflow in npm’s package settings. This is a publishing configuration prerequisite, not something established merely by the YAML file.

## Scope and limitations

Mnemosyne is explicitly a proof of concept. Its current tracing surface is useful for the included examples but does not amount to complete TypeScript semantic instrumentation.

### Language and syntax coverage

Deferred or unsupported areas include, among others:

- Compound assignment such as `+=` and increment/decrement operators.
- Unary operations.
- Template literals.
- Destructuring bindings and destructuring parameters.
- Spread arguments.
- Async/await and generators.
- Loops and loop-node aggregation.
- Optional chaining.
- Namespace imports and re-export forms; the transform explicitly rejects some of these.
- Complex or computed call expressions outside the patterns implemented by the visitor.

Always inspect the transform and test the exact syntax you plan to use. The README and `CLAUDE.md` describe the intended PoC boundary; the current implementation is the definitive source for what a specific revision handles.

### One execution path at a time

Only the operations taken during a run appear in the graph. Conditional behavior can be explored by running multiple inputs, but each run is a separate concrete trace. The current CLI/MCP workflow is not a symbolic execution engine and does not automatically compare traces across sessions.

### External dependencies

Relative local imports are the multi-file tracing target. Bare package imports are not expanded into dependency source by the local module loader; they fall through to Node `require` and remain opaque or untraced internally. External package source tracing is a plan documented in `docs/FUTURE-EXTENSIONS.md`, not an implemented feature in this snapshot.

### Object property provenance across call boundaries

A returned object’s literal attributes can be recorded as named output nodes. However, the runtime does not attach hidden per-property provenance metadata to the object value itself. A property read from a returned object can therefore be less precise when it is used directly as an expression across a call boundary. Binding the property to a local first, as the example does with `chainedTotal`, provides a named binding point for subsequent tracing.

### Frame and identity model

The tape resolves identifiers by names in runtime frames and uses a last-produced-node fallback for unnamed expressions. This is intentionally lightweight. Aliasing, mutation of objects, complex nested expressions, unsupported syntax, and unusual control flow can make provenance less precise than a full compiler-level dataflow analysis.

### Behavior-preservation scope

The pipeline compares JSON-serialized captured console logs for a plain and instrumented run of the same example under the same environment. This is a helpful regression signal. It does not compare all possible side effects, timing, I/O, thrown errors, or all paths for arbitrary programs. Instrumentation itself also has overhead and may expose edge cases beyond the example’s tested syntax.

## Security and operational considerations

The pipeline executes instrumented code through Node’s `vm` module and provides the real `process` object to its sandbox. Node’s VM contexts should not be treated as a security boundary for hostile code. Use this tool with trusted source and controlled inputs. Do not interpret the word “sandbox” in the implementation as a guarantee that untrusted code is securely contained.

The external-package extension plan calls out this risk explicitly: automatically fetching and executing third-party source would materially change the threat model. The future plan recommends opt-in package expansion, immutable source pinning, and a stronger isolation model before any such feature is used beyond trusted local code.

Trace nodes can contain actual values, including environment-derived data. Treat trace JSON, diagrams, MCP responses, and logs according to the sensitivity of the data being traced. Avoid exposing traces that contain secrets or personal data to unauthorized users or external services.

## Design rationale

### Why Babel and source ASTs?

The AST contains the source-level facts the tool wants to retain: names, operators, and positions. Babel provides a mature JavaScript/TypeScript transformation path and scope information. Mnemosyne can therefore insert instrumentation without asking the application author to rewrite every expression by hand.

### Why a side-channel instead of wrappers?

Wrappers may interfere with primitive operations, coercion, identity, and library APIs. A side-channel tape keeps real values flowing through the program and records graph nodes separately. This supports behavior-preserving intent and keeps the instrumentation API conceptually small.

### Why separate transform, runtime, and exporter?

Each layer has a narrow responsibility:

- The transform emits calls and metadata; it need not know the internal node-storage format.
- The runtime implements the tape and provenance resolution; it need not know the exporter’s presentation choices.
- The exporter consumes node records; it need not parse source or know Babel.
- The MCP server consumes queryable nodes and graph utilities; it need not know how each node was produced.

This separation makes it easier to replace or extend one stage without coupling all the others.

### Why a run-once MCP workflow?

Repeatedly reading and mentally executing a large source file can be expensive for both engineers and AI systems. A trace captures runtime values and causal edges once; follow-up MCP calls can request a target’s ancestry, descendants, or diagram from the cached DAG. This is the intended AI-helper value proposition, not a claim that the graph substitutes for source review in every debugging task.

## Roadmap and future extensions

`docs/FUTURE-EXTENSIONS.md` specifically proposes a phased exploration of tracing into external package source. Its status is plan-only. The main challenges identified there include mapping a published import path to repository source, mapping package versions to immutable Git commits, handling monorepos, gracefully dealing with unavailable repositories, broadening syntax support, limiting dependency expansion, caching fetched source, and protecting execution of third-party code.

The broader design document discusses possible directions such as broader expression coverage, loops, an interactive viewer, TypeScript type information, and comparisons between runs. Those are design/roadmap ideas, not a promise that they are already implemented. Use the source and package exports to distinguish available behavior from future concepts.

## Suggested exploration path

For someone new to this repository, the following reading sequence gives a useful progression:

1. **`README.md`** — quick product overview, commands, MCP tools, and example diagram.
2. **`examples/example.ts`** — source-level workload that demonstrates the feature set.
3. **`src/transform.ts`** — how ordinary syntax becomes calls with provenance metadata.
4. **`src/runtime.ts`** — how emitted calls record graph nodes and resolve inputs.
5. **`src/pipeline.ts` and `src/compile.ts`** — how plain and instrumented executions are prepared and compared.
6. **`src/module-loader.ts` and `src/resolve-module.ts`** — how relative imports share the trace.
7. **`src/export-mermaid.ts`** — how graph output and ancestry/descendant queries work.
8. **`src/mcp-server.ts`** — how the trace is exposed to MCP clients.
9. **`examples/multi-file/`** — a compact test of import/export provenance across files.
10. **`CLAUDE.md`, `docs/DESIGN.md`, and `docs/FUTURE-EXTENSIONS.md`** — specification, motivation, and planned work.

A good first experiment is to run `npm run trace`, inspect the generated JSON and Mermaid graph, then vary `TAX_RATE` and compare the resulting values. Next, run `npm run trace:multifile` and inspect whether import bindings connect the modules in one graph.

## Glossary

| Term | Definition in this project |
|---|---|
| **AST** | Abstract syntax tree: the parsed representation of source code that Babel visitors inspect and rewrite. |
| **Binding** | A named variable declaration, assignment, or import relationship recorded as a trace node. |
| **Black box** | A function treated as a unit from the user’s perspective; Mnemosyne can instrument its source when that source is part of the supported traced inputs. |
| **Concrete trace** | The operations and values observed in one actual execution. |
| **DAG** | Directed acyclic graph. In this context, nodes represent values/operations and edges represent provenance inputs. |
| **Frame** | Runtime bookkeeping for names in a module or function scope. |
| **MCP** | Model Context Protocol, used here to make trace operations available as tools over stdio. |
| **Provenance** | Information about which earlier values and operations contributed to a value. |
| **Side-channel** | Recording trace information separately while the program continues to use ordinary runtime values. |
| **Tape** | The ordered collection of `TapeNode` records from one run. Its input links form the DAG. |

## References within this repository

- [`README.md`](../README.md) — project quickstart and package usage.
- [`CLAUDE.md`](../CLAUDE.md) — PoC scope, conventions, and implementation expectations.
- [`docs/DESIGN.md`](DESIGN.md) — design and concept document.
- [`docs/DEMO.md`](DEMO.md) — walkthrough script.
- [`docs/FUTURE-EXTENSIONS.md`](FUTURE-EXTENSIONS.md) — plan for external package-source tracing.
- [`src/transform.ts`](../src/transform.ts) — Babel plugin.
- [`src/runtime.ts`](../src/runtime.ts) — runtime tape.
- [`src/pipeline.ts`](../src/pipeline.ts) — compile/run coordination.
- [`src/export-mermaid.ts`](../src/export-mermaid.ts) — exporters and graph traversals.
- [`src/mcp-server.ts`](../src/mcp-server.ts) — MCP interface.
- [`src/index.ts`](../src/index.ts) — public API.
