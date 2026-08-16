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
- `src/export-mermaid.ts` — DAG → JSON + Mermaid diagram
- `examples/example.ts` — demo with two black boxes

## Status

Proof of concept. See `CLAUDE.md` for the full spec and scope.
