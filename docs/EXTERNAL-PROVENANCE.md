# Package and AI provenance

Mnemosyne 0.2 adds two first-class DAG node kinds: `package` and `ai`. They use the same `id`, `inputs`, source location, value, ancestry, descendant, Mermaid, DOT, and JSON paths as all existing nodes. No graph consumer needs a separate graph or edge type.

## Package nodes

The Babel transform recognizes bare-package ESM imports. Named imports are tagged as exported functions; default imports are tagged as package namespaces. When an instrumented call invokes one of those values, the tape records a `package` node instead of an ordinary `call` node.

Each node has `packageName`, installed `version` (or `"unknown"` where no manifest can be resolved), `functionName`, argument provenance in `inputs`, result in `value`, `loc`, ISO `timestamp`, and `executionTimeMs`. Local relative imports retain the existing cross-module provenance behavior.

```ts
import { round } from "lodash";
const total = round(12.345, 2);
// package node: lodash@4.17.21.round, then a normal bind node for total
```

## AI nodes

AI SDKs differ too widely for safe automatic interception, so AI calls are intentionally explicit. Wrap the actual SDK invocation with `tape.ai`; it returns exactly the original synchronous value or Promise result.

```ts
const response = await tape.ai(
  () => client.responses.create({ model: "gpt-5", input: prompt }),
  {
    provider: "openai",
    model: "gpt-5",
    prompt,
    temperature: 0.2,
    inputMeta: { kind: "ident", name: "prompt" },
    metadata: { feature: "recommendation" },
  },
);
```

The resulting `ai` node stores provider, model, prompt, response, token count, temperature, custom metadata, timestamp, and execution time. Token usage is read from common `usage.total_tokens`, `usage.totalTokens`, or `usageMetadata` fields; pass `tokens` explicitly for other SDKs. `inputMeta` attaches the prompt to its existing tape node, making AI influence visible in ancestry queries.

## MCP queries

- `get_package_usage(packageName?)` answers which packages contributed and how many calls were observed.
- `assess_package_removal(packageName)` returns all observed downstream values; it explicitly distinguishes dynamic evidence from a static removal proof.
- `get_ai_nodes(provider?, model?)` lists every AI call, or only a provider/model.

Existing `find_variable_origin`, `query_causality`, and `get_diagram` include both node kinds automatically.

## Migration

This is additive. Existing serialized nodes remain valid because `kind` is a discriminated union extension and all new fields are optional on non-package/non-AI nodes. Consumers that switch on `NodeKind` should add `package` and `ai` branches (or a default). Existing code needs no change for package imports. Adopt AI tracking incrementally by replacing an SDK invocation with `tape.ai(() => invocation, metadata)`; behavior and return types are preserved. Persisted traces from prior releases can be read unchanged, while new traces should retain the new node fields.
