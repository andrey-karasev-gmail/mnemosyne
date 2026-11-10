/**
 * Mnemosyne MCP server — the run-once, low-token AI-helper workflow.
 *
 * Runs examples/example.ts through the pipeline exactly once (cached after
 * that), then exposes the resulting DAG to an AI agent via the tool
 * vocabulary borrowed from Chronos (github.com/Rubentxu/chronos):
 * run_trace, find_variable_origin, query_causality, get_diagram,
 * get_execution_summary.
 *
 * Decoupled from the runtime/transpiler: everything below reads the plain
 * `TapeNode[]` array produced by src/pipeline.ts. It has no idea how nodes
 * were produced.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runTraceOnce } from "./pipeline";
import { toMermaid, subgraphFrom, descendantsOf, safeStringify } from "./export-mermaid";
import type { TapeNode } from "./runtime";

let cachedNodes: TapeNode[] | null = null;

function ensureTrace(): TapeNode[] {
  if (!cachedNodes) {
    cachedNodes = runTraceOnce().nodes;
  }
  return cachedNodes;
}

interface Resolution {
  target?: TapeNode;
  /** Every node matching `name`, when there was more than one — surfaced so
   * the caller can disambiguate instead of silently picking one (the same
   * bare name, e.g. "total", can legitimately be a local in one black box
   * AND a param in another AND an output attribute of a third). */
  candidates: TapeNode[];
}

/**
 * Resolve a user-supplied name to a tape node. Matches an exact label, or a
 * label ending in `.name` (so `find_variable_origin("total")` finds
 * `priceBox.total`). When several nodes match, the most recently recorded
 * one is returned as `target`, but all matches are returned as `candidates`.
 */
function resolveNode(nodes: TapeNode[], name: string): Resolution {
  const exact = nodes.filter((n) => n.label === name);
  const matches = exact.length ? exact : nodes.filter((n) => n.label.endsWith(`.${name}`));
  return { target: matches[matches.length - 1], candidates: matches };
}

function describeNode(node: TapeNode): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    op: node.op,
    label: node.label,
    scope: node.scope,
    value: node.value,
    fn: node.fn,
    loc: node.loc,
    inputs: node.inputs,
    package: node.package,
    ai: node.ai,
  };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function serialize(value: unknown): string {
  return safeStringify(value, 2);
}

function resolveRequired(nodes: TapeNode[], resultId: number): TapeNode | undefined {
  return nodes.find((node) => node.id === resultId);
}

function uniqueNodes(nodes: TapeNode[]): TapeNode[] {
  return Array.from(new Map(nodes.map((node) => [node.id, node])).values()).sort((a, b) => a.id - b.id);
}

function tokensFor(nodes: TapeNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.ai?.tokens ?? 0), 0);
}

function decisionsAndOutputs(nodes: TapeNode[]): TapeNode[] {
  return nodes.filter((node) => node.kind === "output" || node.scope === "return" || /decision|result/i.test(node.label));
}

const server = new McpServer({ name: "mnemosyne", version: "0.1.0" });

server.registerTool("showPackages", {
  title: "Show packages",
  description: "List packages observed in this trace with installed version and invocation count.",
  inputSchema: {},
}, async () => {
  const calls = ensureTrace().filter((node) => node.kind === "package");
  const grouped = new Map<string, { packageName: string; version: string; usageCount: number }>();
  for (const node of calls) {
    const key = `${node.package?.packageName ?? "unknown"}@${node.package?.version ?? "unknown"}`;
    const entry = grouped.get(key) ?? { packageName: node.package?.packageName ?? "unknown", version: node.package?.version ?? "unknown", usageCount: 0 };
    entry.usageCount++;
    grouped.set(key, entry);
  }
  return textResult(serialize(Array.from(grouped.values())));
});

server.registerTool("showPackageUsage", {
  title: "Show package usage",
  description: "Show observed calls, called exports, argument inputs, result outputs, and call count for a package.",
  inputSchema: { packageName: z.string().min(1) },
}, async ({ packageName }) => {
  const nodes = ensureTrace();
  const calls = nodes.filter((node) => node.kind === "package" && node.package?.packageName === packageName);
  return textResult(serialize({ packageName, functionsUsed: Array.from(new Set(calls.map((node) => node.package?.functionName))), inputs: calls.flatMap((node) => node.inputs.map((id) => nodes.find((candidate) => candidate.id === id)).filter(Boolean).map((node) => describeNode(node!))), outputs: calls.map((node) => describeNode(node)), callCount: calls.length }));
});

server.registerTool("showAIUsage", {
  title: "Show AI usage",
  description: "Aggregate observed AI calls by provider and model, including calls and known token consumption.",
  inputSchema: {},
}, async () => {
  const calls = ensureTrace().filter((node) => node.kind === "ai");
  const grouped = new Map<string, { provider: string; model: string; callCount: number; tokenConsumption: number }>();
  for (const node of calls) {
    const provider = node.ai?.provider ?? "unknown";
    const model = node.ai?.model ?? "unknown";
    const key = `${provider}/${model}`;
    const entry = grouped.get(key) ?? { provider, model, callCount: 0, tokenConsumption: 0 };
    entry.callCount++;
    entry.tokenConsumption += node.ai?.tokens ?? 0;
    grouped.set(key, entry);
  }
  return textResult(serialize(Array.from(grouped.values())));
});

server.registerTool("explainResult", {
  title: "Explain result",
  description: "Return the full upstream provenance chain for a tape result node id.",
  inputSchema: { resultId: z.number().int().nonnegative() },
}, async ({ resultId }) => {
  const nodes = ensureTrace();
  const target = resolveRequired(nodes, resultId);
  return textResult(serialize(target ? { target: describeNode(target), provenance: subgraphFrom(nodes, resultId).map(describeNode), diagram: toMermaid(subgraphFrom(nodes, resultId)) } : { error: `No result node with id ${resultId}` }));
});

server.registerTool("findDependencies", {
  title: "Find package dependencies",
  description: "Find every package node in the ancestry of a result node.",
  inputSchema: { resultId: z.number().int().nonnegative() },
}, async ({ resultId }) => {
  const nodes = ensureTrace();
  if (!resolveRequired(nodes, resultId)) return textResult(serialize({ error: `No result node with id ${resultId}` }));
  const ancestry = subgraphFrom(nodes, resultId);
  return textResult(serialize({ resultId, packages: ancestry.filter((node) => node.kind === "package").map(describeNode) }));
});

server.registerTool("findAIInfluence", {
  title: "Find AI influence",
  description: "Find every AI node in the ancestry of a result node.",
  inputSchema: { resultId: z.number().int().nonnegative() },
}, async ({ resultId }) => {
  const nodes = ensureTrace();
  if (!resolveRequired(nodes, resultId)) return textResult(serialize({ error: `No result node with id ${resultId}` }));
  const ancestry = subgraphFrom(nodes, resultId);
  return textResult(serialize({ resultId, aiNodes: ancestry.filter((node) => node.kind === "ai").map(describeNode) }));
});

server.registerTool("simulatePackageRemoval", {
  title: "Simulate package removal",
  description: "Report traced descendants, outputs, and decision-like values affected by removing a package. This is a dynamic trace impact estimate.",
  inputSchema: { packageName: z.string().min(1) },
}, async ({ packageName }) => {
  const nodes = ensureTrace();
  const calls = nodes.filter((node) => node.kind === "package" && node.package?.packageName === packageName);
  const affected = uniqueNodes(calls.flatMap((node) => descendantsOf(nodes, node.id)));
  return textResult(serialize({ packageName, affectedNodes: affected.map(describeNode), affectedOutputs: affected.filter((node) => node.kind === "output").map(describeNode), affectedBusinessDecisions: decisionsAndOutputs(affected).map(describeNode) }));
});

server.registerTool("simulateAIRemoval", {
  title: "Simulate AI model removal",
  description: "Report traced outputs and decisions downstream of a model, plus unaffected alternate ancestry paths visible in the graph.",
  inputSchema: { model: z.string().min(1) },
}, async ({ model }) => {
  const nodes = ensureTrace();
  const calls = nodes.filter((node) => node.kind === "ai" && node.ai?.model === model);
  const affected = uniqueNodes(calls.flatMap((node) => descendantsOf(nodes, node.id)));
  const affectedIds = new Set(affected.map((node) => node.id));
  const alternatives = nodes.filter((node) => !affectedIds.has(node.id) && (node.kind === "package" || node.kind === "call" || node.kind === "op"));
  return textResult(serialize({ model, affectedDecisions: decisionsAndOutputs(affected).filter((node) => node.kind !== "output").map(describeNode), affectedOutputs: affected.filter((node) => node.kind === "output").map(describeNode), alternativePaths: alternatives.map(describeNode), caveat: "Alternate paths are observed graph paths outside the removed model's descendants; this does not recompute program behavior." }));
});

/** When a bare name matched more than one node, tell the caller so it can re-query precisely. */
function ambiguityNote(name: string, candidates: TapeNode[]): string | undefined {
  if (candidates.length <= 1) return undefined;
  const alternatives = candidates.map((n) => `${n.label} (${n.kind}${n.fn ? ` in ${n.fn}` : ""}, id ${n.id})`);
  return `"${name}" matched ${candidates.length} nodes; showing the most recent. Others: ${alternatives.join("; ")}. Re-query with a qualified "fnName.attr" name for precision.`;
}

server.registerTool(
  "run_trace",
  {
    title: "Run trace",
    description:
      "Run the instrumented example program once (optionally overriding env vars), producing and caching the value-provenance DAG. Call this first.",
    inputSchema: {
      envOverrides: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variables to set before running, e.g. { TAX_RATE: '0.10' }"),
    },
  },
  async ({ envOverrides }) => {
    const result = runTraceOnce(envOverrides);
    cachedNodes = result.nodes;
    return textResult(
      safeStringify(
        {
          identicalOutput: result.identicalOutput,
          nodeCount: result.nodes.length,
          consoleOutput: result.instrumentedLogs,
        },
        2,
      ),
    );
  },
);

server.registerTool(
  "find_variable_origin",
  {
    title: "Find variable origin",
    description:
      "Given a variable name, parameter name, or output attribute (e.g. 'total' or 'priceBox.total'), return where it was set and its full ancestry: every input, operation, and source line that produced it.",
    inputSchema: {
      name: z.string().describe("Variable name, parameter name, or 'fnName.attr' output attribute"),
    },
  },
  async ({ name }) => {
    const nodes = ensureTrace();
    const { target, candidates } = resolveNode(nodes, name);
    if (!target) {
      return textResult(safeStringify({ error: `No node found for "${name}"` }));
    }
    const ancestry = subgraphFrom(nodes, target.id);
    return textResult(
      safeStringify(
        {
          target: describeNode(target),
          ancestry: ancestry.map(describeNode),
          diagram: toMermaid(ancestry),
          note: ambiguityNote(name, candidates),
        },
        2,
      ),
    );
  },
);

server.registerTool(
  "query_causality",
  {
    title: "Query causality",
    description:
      "Trace a value backward (its ancestry — what produced it) or forward (its descendants — what it went on to affect) through the DAG.",
    inputSchema: {
      name: z.string().describe("Variable name, parameter name, or 'fnName.attr' output attribute"),
      direction: z.enum(["backward", "forward"]).default("backward"),
    },
  },
  async ({ name, direction }) => {
    const nodes = ensureTrace();
    const { target, candidates } = resolveNode(nodes, name);
    if (!target) {
      return textResult(safeStringify({ error: `No node found for "${name}"` }));
    }
    const related = direction === "backward" ? subgraphFrom(nodes, target.id) : descendantsOf(nodes, target.id);
    return textResult(
      safeStringify(
        {
          target: describeNode(target),
          direction,
          nodes: related.map(describeNode),
          note: ambiguityNote(name, candidates),
        },
        2,
      ),
    );
  },
);

server.registerTool(
  "get_diagram",
  {
    title: "Get diagram",
    description:
      "Return a Mermaid diagram of the value-provenance DAG — the whole trace, or (if `name` is given) just the ancestry sub-graph for one variable/output attribute.",
    inputSchema: {
      name: z.string().optional().describe("Optional: restrict to one variable/output attribute's ancestry"),
    },
  },
  async ({ name }) => {
    const nodes = ensureTrace();
    if (!name) {
      return textResult(toMermaid(nodes));
    }
    const { target } = resolveNode(nodes, name);
    if (!target) {
      return textResult(safeStringify({ error: `No node found for "${name}"` }));
    }
    return textResult(toMermaid(subgraphFrom(nodes, target.id)));
  },
);

server.registerTool(
  "get_package_usage",
  {
    title: "Get package usage",
    description: "List package provenance nodes, optionally for one package. Includes the exact calls, versions, inputs, outputs, locations, and duration where available.",
    inputSchema: { packageName: z.string().optional().describe("Optional npm package name") },
  },
  async ({ packageName }) => {
    const nodes = ensureTrace().filter((node) => node.kind === "package" && (!packageName || node.package?.packageName === packageName));
    return textResult(safeStringify({ packageName, callCount: nodes.length, nodes: nodes.map(describeNode) }, 2));
  },
);

server.registerTool(
  "assess_package_removal",
  {
    title: "Assess package removal",
    description: "Report whether a package participated in the observed execution and every downstream value that its calls affected. A package with no observed calls is removable only from this trace's provenance perspective.",
    inputSchema: { packageName: z.string().describe("npm package name") },
  },
  async ({ packageName }) => {
    const nodes = ensureTrace();
    const calls = nodes.filter((node) => node.kind === "package" && node.package?.packageName === packageName);
    const affected = Array.from(new Map(calls.flatMap((call) => descendantsOf(nodes, call.id)).map((node) => [node.id, node])).values());
    return textResult(safeStringify({
      packageName,
      observedCallCount: calls.length,
      removableFromObservedTrace: calls.length === 0,
      calls: calls.map(describeNode),
      affectedValues: affected.map(describeNode),
      caveat: "This is dynamic evidence for the executed trace, not proof that static imports or unexecuted paths can be removed.",
    }, 2));
  },
);

server.registerTool(
  "get_ai_nodes",
  {
    title: "Get AI nodes",
    description: "List all AI provenance nodes involved in the trace, optionally filtered by provider or model.",
    inputSchema: {
      provider: z.string().optional(),
      model: z.string().optional(),
    },
  },
  async ({ provider, model }) => {
    const nodes = ensureTrace().filter((node) => node.kind === "ai" &&
      (!provider || node.ai?.provider === provider) && (!model || node.ai?.model === model));
    return textResult(safeStringify({ provider, model, callCount: nodes.length, nodes: nodes.map(describeNode) }, 2));
  },
);

server.registerTool(
  "get_execution_summary",
  {
    title: "Get execution summary",
    description:
      "High-level overview of the cached trace: inputs (params/env/consts), output attributes, black-box functions touched, and total node count.",
    inputSchema: {},
  },
  async () => {
    const nodes = ensureTrace();
    const inputs = nodes.filter((n) => n.kind === "input").map(describeNode);
    const outputs = nodes.filter((n) => n.kind === "output").map(describeNode);
    const blackBoxes = Array.from(new Set(nodes.map((n) => n.fn).filter((fn): fn is string => Boolean(fn))));
    const packages = nodes.filter((n) => n.kind === "package");
    const aiCalls = nodes.filter((n) => n.kind === "ai");
    return textResult(
      safeStringify(
        {
          nodeCount: nodes.length,
          inputs,
          outputs,
          blackBoxesTouched: blackBoxes,
          packageCalls: packages.length,
          packagesTouched: Array.from(new Set(packages.map((n) => n.package?.packageName).filter(Boolean))),
          aiCalls: aiCalls.length,
          aiModels: Array.from(new Set(aiCalls.map((n) => n.ai && `${n.ai.provider}/${n.ai.model}`).filter(Boolean))),
        },
        2,
      ),
    );
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Mnemosyne MCP server failed to start:", err);
  process.exit(1);
});
