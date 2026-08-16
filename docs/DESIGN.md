# Mnemosyne — Design & Concept Document

> A TypeScript source-to-source transpiler that reconstructs the full value-provenance
> path of a computation — across one or more "black box" functions — including the names
> of internal local and global variables.
>
> **Purpose:** reverse-engineering, debugging, and calculation-flow visualization.
> **Explicit non-goal:** production performance.

---

## 1. Executive summary

Modern business logic is often a chain of opaque functions ("black boxes") that transform
inputs into an output structure. When something is wrong — a bad total, a mangled string,
an unexpected date — engineers must manually trace *how* each output value was produced and
*from which inputs*. Mnemosyne automates that: it rewrites ordinary TypeScript so that, when
it runs, it records a **linear tape** of every operation actually executed, then renders that
tape as a **value-provenance diagram** (a DAG). Each node in the diagram is an operation or a
named variable; each edge shows where a value came from. You can point at any output attribute
and walk backward to the original inputs, through every intermediate step — including the
temporary local and global variables the original programmer used.

The key insight: what is **impossible at runtime** in JavaScript/TypeScript (operator
overloading, seeing internal variable names) becomes **straightforward at compile time** by
transforming the source AST.

---

## 2. Problem statement

Given one or more black-box functions where:

- inputs are a variable set of arguments (mixed types, variable count),
- outputs are a variable set of values / a structure with many attributes,
- outputs of one black box may feed the inputs of another,
- operations span **numbers** (`+ - * /`), **comparisons** (`< > <= >= === !==`),
  **strings** (`concat`, `split`, `trim`, ...), **booleans**, and **dates**,
- complex types implement method analogs of operators (`add`, `extract`, `multiply`, `divide`),

**reconstruct the entire calculation path** from the outputs, and present it visually so a
human can see exactly which inputs and intermediate steps produced each result — including
the internal variable names used inside each black box.

---

## 3. Landscape — what already exists

The general technique is called **tracing via operator overloading** (Python) or, more
broadly, **program instrumentation / provenance tracking**. Mnemosyne's contribution is not
inventing the idea — it is bringing a **name-preserving, compile-time** variant to TypeScript.

### 3.1 Python libraries (mature prior art)

| Library / Tool | What it does | Mechanism | Relevance |
|----------------|--------------|-----------|-----------|
| **JAX** (`jax.make_jaxpr`) | Traces a numeric function into a **jaxpr** IR — a fully inspectable list of primitive operations. | Pass-in `Tracer` objects overload every primitive op. | Gold standard for "reconstruct the path"; numeric only, invents its own variable names. |
| **Autograd** (HIPS) | Records ops onto a **tape** (Wengert list) for automatic differentiation. | `Box` wrapper overloads operators. | Closest to a hand-rolled tracer; pure Python, hackable. |
| **PyTorch autograd** | Every `Tensor` carries a `grad_fn` graph — the full DAG that produced it. | Operator overloading + dynamic graph. | Industrial-scale DAG-from-output. |
| **TensorFlow** (`tf.function`, autograph) | Traces Python into a `GraphDef` computation graph. | Tracing + graph capture. | Static graph IR. |
| **SymPy** | Native operators on `Symbol` objects build a symbolic **expression tree** you can print, simplify, walk. | Operator overloading. | Best for algebraic (single-expression) reconstruction. |
| **Theano** (deprecated), **SageMath** | Symbolic/graph computation. | Operator overloading. | Historical reference. |
| **`uncertainties`** | Propagates error bars by overloading operators; carries lineage. | Operator overloading. | Shows lineage-carrying values. |
| **`unittest.mock` / `wrapt`** | Record attribute access & method calls; build transparent proxies. | Proxy objects. | Method-call recording pattern. |

**Key limitation of all Python options:** they record their *own* built-in operations and
invent their *own* variable names. None recovers the **original source variable names** of an
arbitrary function, and none traces native operators in a language that lacks operator
overloading (like TS).

### 3.2 Data-lineage / provenance systems (cross-"box" prior art)

| Tool | Domain | Relevance |
|------|--------|-----------|
| **OpenLineage**, **Apache Atlas**, **Marquez** | Data-pipeline lineage | Track values flowing through transformation stages across many "boxes"; column-level lineage is conceptually identical to our cross-black-box DAG. |
| **Apache Spark / dbt** | ETL lineage | Same idea at dataset/column granularity. |
| **Symbolic execution** (angr, KLEE) | Security / analysis | Track operations across all types including comparisons and control flow. |
| **Taint analysis** | Security | Follows data provenance through arbitrary operations. |

### 3.3 Instrumentation / AST-rewriting prior art (the technique Mnemosyne uses)

| Tool | What it does | Relevance |
|------|--------------|-----------|
| **Babel** (`@babel/core`, `traverse`, `generator`) | The JS/TS AST transform ecosystem. | Our transpiler engine; `path.scope` yields variable names & binding kinds. |
| **Istanbul / c8 / `babel-plugin-istanbul`** | Rewrite source to record which lines/branches ran (coverage). | **Exact same technique**, applied to coverage instead of dataflow — the canonical reference. |
| **iroh.js** | Runtime JS analysis via self-instrumentation; observe execution. | Closest existing JS tool to Mnemosyne. |
| **TypeScript Compiler API / ts-morph** | Programmatic AST read/write with full type info. | Alternative engine if we later need type data in the trace. |

### 3.4 Why not just reuse one of these?

- **Language gap:** JAX/Autograd/SymPy are Python and rely on operator overloading. TS has
  none — so their core mechanism does not port.
- **Custom operations:** the black boxes use bespoke method analogs (`add`/`extract`/
  `multiply`/`divide`) that no off-the-shelf tracer knows.
- **Internal variable names:** *no* existing tool recovers the original internal local/global
  names of an arbitrary function. This is Mnemosyne's differentiator, and it is only
  achievable by reading the source AST at compile time.

---

## 4. Why TypeScript makes this hard (and how we solve it)

| Capability | Python | TypeScript (runtime) | Mnemosyne (compile-time) |
|------------|--------|----------------------|--------------------------|
| Trace native `+ - * / < >` | ✅ operator overloading | ❌ **impossible** | ✅ rewrite `a + b` → `__t.op('+', a, b, …)` |
| Trace method calls (`.trim()`, `.add()`) | ✅ | ✅ via `Proxy` | ✅ rewrite to `__t.call(...)` |
| Recover **internal variable names** | ❌ (invents names) | ❌ **erased after compile** | ✅ read identifier from AST |
| Source location (line/col) | partial | ⚠️ stack hacks only | ✅ exact, from AST |
| Global / temp variables | — | ❌ invisible | ✅ visible via assignment nodes + `path.scope` |

**The core realization:** operator overloading and variable-name recovery are impossible at
*runtime* in JS/TS, but both fall out naturally when you transform the *source* before it runs.
The AST still literally contains `const subtotal = a * b` — the name `subtotal`, the operator
`*`, and the line number are all right there.

---

## 5. The Mnemosyne approach

### 5.1 Side-channel, linear tracing (the chosen model)

Two tracing strategies exist:

- **Value-wrapping:** replace each value with a wrapper object carrying an id. Clean graph
  identity, but risks "unwrap leaks" (if a black box coerces the wrapper to a raw primitive,
  the trace breaks silently) and can subtly change behavior.
- **Side-channel (CHOSEN):** the **real value flows through unchanged**; each operation
  records a node into a **global tape** as a side effect and tags the produced value with a
  lightweight id. The program's results are **identical** to the original.

We chose **side-channel** deliberately: we want **linear calculations** — the operations that
*actually executed*, in order, with **no speculative branches and no "possible" deviations**.
The tape reflects exactly one concrete execution path. This is the correct model for
debugging and reverse-engineering a specific run.

### 5.2 What gets recorded

Each tape node stores:

```
{
  id,          // unique node id
  kind,        // 'input' | 'op' | 'call' | 'bind' | 'return'
  op,          // e.g. '+', '<', 'trim', 'multiply'
  label,       // human name: variable name, param name, or output attribute
  inputs: [],  // ids of parent nodes (the DAG edges)
  value,       // the actual runtime value on this run (side-channel snapshot)
  scope,       // 'local' | 'global' | 'param' | 'temp'
  loc          // source file, line, column
}
```

Chaining black boxes chains the DAG automatically: box B's inputs are box A's output nodes.

### 5.3 Rewrite mapping

| Source | Rewritten to |
|--------|--------------|
| `a + b` | `__t.op('+', a, b, {loc, lhs:'a', rhs:'b'})` |
| `a < b` | `__t.op('<', a, b, {...})` |
| `s.trim()` | `__t.call(s, 'trim', [], {...})` |
| `const total = x` | `const total = __t.bind('total', x, {scope, loc})` |
| `f(x, y)` | `__t.call(null, f, [x, y], {fn:'f', argNames:['x','y']})` |
| `return r` | `return __t.ret('f', r)` |

---

## 6. Pros and cons of the new approach

### 6.1 Pros

- **Recovers internal variable names** — local, global, and temporary. This is the standout
  capability no runtime tracer or existing library provides for arbitrary code.
- **Traces native operators** (`+ - * / < >`) that TS cannot intercept at runtime.
- **Exact source locations** (file / line / column) for every operation — click a node, jump
  to the code.
- **Cross-black-box provenance** — one DAG spans the whole pipeline; each output attribute
  walks back to original inputs.
- **Type-agnostic** — numbers, strings, booleans, dates, and complex custom types are all just
  "operation nodes"; more types simply mean richer labels.
- **Behavior-preserving** — side-channel means results are identical to the original program;
  safe to run on real code paths.
- **No source-of-truth drift** — instrumentation is generated from the real source, so it
  cannot disagree with what the code actually does.
- **Great for onboarding & audits** — the flow diagram doubles as living documentation of how
  a result is computed.
- **Language-appropriate** — leans on Babel, the standard, battle-tested JS/TS AST toolchain
  (same technique as code-coverage tools).

### 6.2 Cons / limitations (be honest)

- **Performance overhead** — every operation becomes a function call plus a tape write.
  Acceptable because it is a debug / RE-only tool, not for production.
- **Single execution path only** — the tape captures *this* run, not all possible branches.
  (This is intentional for linear reconstruction, but must be communicated clearly.)
- **Expression-coverage breadth** — TS has many node kinds; the PoC covers a subset. Full
  coverage (compound assignment, destructuring, template literals, spread, async) is
  incremental "breadth work."
- **The two genuinely hard parts:**
  1. **Faithful lowering of side-effecting & short-circuit expressions** (`&& || ?? ?:`,
     `a() + b()`) — must preserve left-to-right evaluation order and never double-evaluate.
     (Deferred in the PoC.)
  2. **Node-identity model** — deciding when two values are "the same" node (value-based vs.
     binding-based), especially with aliasing (`let x = y`) and in-place mutation.
- **Requires source access** — by definition this instruments source, so a truly compiled /
  minified black box with no source is out of scope (names would be lost).
- **Loops produce repeated nodes** — need per-iteration ids or aggregation for readability
  (deferred).
- **Not a substitute for a type checker** — Babel ignores types; if type-level provenance is
  needed later, we would add the TS Compiler API.

---

## 7. Proof of Concept (PoC)

### 7.1 Goal

Trace a small **two-black-box** example end to end and render a value-provenance diagram —
proving the pipeline (transform → run → export) works and that **internal variable names**
appear correctly.

### 7.2 Tooling

- **Babel** (`@babel/core`, `parser`, `traverse`, `generator`, `preset-typescript`).
  Chosen because `path.scope` gives binding classification (local / global / param / temp) and
  variable names for free; no type checker needed for the PoC.
- **TypeScript** for the runtime tape and exporter. **Node.js** to run.

### 7.3 Architecture — three decoupled components

1. **`src/transform.ts`** — Babel plugin. Pure AST-in / AST-out. Visitors for
   `BinaryExpression`, `CallExpression`, `VariableDeclarator`, `AssignmentExpression`,
   `ReturnStatement`. Rewrites nodes to `__t.*` calls, injecting `{ name, scope, loc }` from
   `path.scope` and `node.loc`.
2. **`src/runtime.ts`** — the `__t` side-channel tape: `op()`, `call()`, `bind()`, `ret()`.
   Assigns ids, records nodes into an in-memory DAG, passes the real value straight through.
3. **`src/export-mermaid.ts`** — serialize the DAG to JSON and emit a Mermaid diagram (and
   optionally Graphviz DOT).

### 7.4 In scope / deferred

- **In:** `+ - * /`; `< > <= >= === !==`; generic `obj.method(args)`; `f(x, y)` with arg-name
  capture; `const`/`let` + simple assignment with name + scope capture; `return`; one linear
  execution path.
- **Deferred:** short-circuit `&& || ?? ?:`; compound assignment / unary / template literals /
  destructuring / spread; async/await/generators; loops/aggregation; optional chaining.

### 7.5 How it works, step by step

1. **Parse** `example.ts` into an AST (Babel).
2. **Transform** — visitors replace operators, calls, bindings, and returns with `__t.*`
   calls carrying source metadata (names, scope, line/col).
3. **Generate** instrumented code (`@babel/generator`) + source map.
4. **Run** the instrumented code. Values compute normally; each op writes a node to the tape.
5. **Export** — the tape (now a DAG) is serialized to JSON and rendered to Mermaid.
6. **Inspect** — the diagram shows every input, internal variable, operation (with line), and
   output attribute, across both black boxes.

### 7.6 Example (illustrative)

Source:

```ts
function priceBox(price: number, qty: number) {
  const subtotal = price * qty;
  const total = subtotal + tax;      // tax is a global
  return { total };
}
function labelBox(first: string, last: string) {
  const name = first.trim() + " " + last.trim();
  return { name };
}
```

Reconstructed flow (Mermaid, illustrative):

```mermaid
graph LR
  price["price (param)"] --> mul["* (line 2)"]
  qty["qty (param)"] --> mul
  mul --> subtotal["subtotal (local, line 2)"]
  tax["tax (global)"] --> add["+ (line 3)"]
  subtotal --> add
  add --> total["result.total (line 4)"]
```

Note the presence of `subtotal` (internal local) and `tax` (global) as first-class,
named nodes — the capability that distinguishes Mnemosyne.

### 7.7 Success criteria

- Instrumented `example.ts` produces **identical** results to the original.
- The trace correctly names **inputs, internal locals, and output attributes**.
- The Mermaid diagram shows the full linear path across **both** black boxes, each op labeled
  with operation + source line.

---

## 8. Roadmap beyond the PoC

1. Short-circuit & side-effect lowering (`&& || ?? ?:`, sequenced calls).
2. Full expression coverage (compound assignment, unary, templates, destructuring, spread).
3. Loop handling (per-iteration nodes or aggregation).
4. Interactive HTML viewer (click node → value, source, ancestors).
5. Optional TS Compiler API integration for type-level provenance.
6. Multi-file / module-boundary tracing.
7. Diff mode: compare two runs' provenance to localize a regression.

---

## 9. Audience-specific framing (for the presentations)

### For developers
- It's Babel instrumentation (same technique as Istanbul coverage). Side-channel tape, linear
  trace. You get exact source lines and **internal variable names** in a clickable DAG.
- Emphasize: the two hard parts (short-circuit lowering, node identity) and the deferred scope.

### For architects
- A decoupled 3-stage pipeline (transform / runtime tape / exporter). Language-appropriate
  choice of Babel over runtime Proxy because TS lacks operator overloading and erases names.
- Positions cleanly next to data-lineage systems (OpenLineage/Atlas) but at expression
  granularity within code. Debug/RE-only; not on the production hot path.

### For managers
- Cuts the time to answer "where did this wrong value come from?" from hours of manual tracing
  to a single diagram. Improves debugging, audits, onboarding, and regulatory explainability
  ("show how this number was calculated"). Low risk: results are unchanged; it's a read-only
  lens over existing code.

---

## 10. References

- JAX tracing / jaxpr — https://jax.readthedocs.io
- Autograd (HIPS) — https://github.com/HIPS/autograd
- PyTorch autograd — https://pytorch.org/docs/stable/autograd.html
- SymPy — https://www.sympy.org
- Babel — https://babeljs.io
- Istanbul / `babel-plugin-istanbul` — https://github.com/istanbuljs
- iroh.js — https://github.com/maierfelix/iroh
- ts-morph — https://ts-morph.com
- TypeScript Compiler API — https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
- OpenLineage — https://openlineage.io
- Apache Atlas — https://atlas.apache.org
