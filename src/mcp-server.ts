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
  };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** When a bare name matched more than one node, tell the caller so it can re-query precisely. */
function ambiguityNote(name: string, candidates: TapeNode[]): string | undefined {
  if (candidates.length <= 1) return undefined;
  const alternatives = candidates.map((n) => `${n.label} (${n.kind}${n.fn ? ` in ${n.fn}` : ""}, id ${n.id})`);
  return `"${name}" matched ${candidates.length} nodes; showing the most recent. Others: ${alternatives.join("; ")}. Re-query with a qualified "fnName.attr" name for precision.`;
}

const server = new McpServer({ name: "mnemosyne", version: "0.1.0" });

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
    return textResult(
      safeStringify(
        {
          nodeCount: nodes.length,
          inputs,
          outputs,
          blackBoxesTouched: blackBoxes,
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
