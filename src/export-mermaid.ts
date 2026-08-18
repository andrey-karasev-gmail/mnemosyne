/**
 * DAG -> JSON / Mermaid / Graphviz DOT.
 *
 * Decoupled from the runtime: this file only reads the plain `TapeNode[]`
 * array (id + inputs + label + value + loc). It has no idea how those nodes
 * were produced.
 */
import type { TapeNode } from "./runtime";

/**
 * `JSON.stringify` that never throws on the value shapes this tool actually
 * traces: BigInt (native `+`/comparisons over bigints are in scope) and
 * circular references. Uses the classic stack + `this`-context trick (see
 * e.g. `json-stringify-safe`) rather than a flat "seen" set — a flat set
 * would misreport ordinary *shared* references as circular, and this
 * codebase produces those routinely: side-channel tracing means the same
 * object literally is the value on multiple nodes (e.g. a `call` node and
 * the `bind` node that immediately captures its result).
 */
export function safeStringify(value: unknown, space?: number): string {
  const stack: unknown[] = [];
  const keys: string[] = [];

  function replacer(this: unknown, key: string, val: unknown): unknown {
    if (typeof val === "bigint") return `${val}n`;

    if (stack.length > 0) {
      const thisIndex = stack.indexOf(this);
      if (thisIndex === -1) {
        stack.push(this);
      } else {
        stack.splice(thisIndex + 1);
        keys.splice(thisIndex, Infinity);
      }
      keys.push(key);

      if (typeof val === "object" && val !== null) {
        const cycleIndex = stack.indexOf(val);
        if (cycleIndex !== -1) {
          return `[Circular ~${keys.slice(0, cycleIndex + 1).join(".")}]`;
        }
      }
    } else {
      stack.push(val);
    }
    return val;
  }

  return JSON.stringify(value, replacer, space);
}

export function toJSON(nodes: TapeNode[]): string {
  return safeStringify({ nodes }, 2);
}

function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  let s: string;
  if (typeof value === "object") {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  } else {
    s = String(value);
  }
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

function escapeMermaid(s: string): string {
  return s.replace(/"/g, "'").replace(/\n/g, " ");
}

function nodeLabel(node: TapeNode): string {
  const loc = node.loc ? ` @L${node.loc.line}` : "";
  switch (node.kind) {
    case "input":
      return `${node.label} (${node.scope}) = ${formatValue(node.value)}${loc}`;
    case "literal":
      return `${formatValue(node.value)} (literal)`;
    case "bind":
      return `${node.label} (${node.scope}) = ${formatValue(node.value)}${loc}`;
    case "op":
      return `${node.op} -> ${formatValue(node.value)}${loc}`;
    case "call":
      return `.${node.op}() -> ${formatValue(node.value)}${loc}`;
    case "output":
      return `${node.label} = ${formatValue(node.value)}${loc}`;
    case "return":
      return `${node.label} = ${formatValue(node.value)}${loc}`;
    default:
      return node.label;
  }
}

function nodeId(id: number): string {
  return `n${id}`;
}

export function toMermaid(nodes: TapeNode[]): string {
  const lines: string[] = ["graph LR"];
  for (const node of nodes) {
    lines.push(`  ${nodeId(node.id)}["${escapeMermaid(nodeLabel(node))}"]`);
  }
  for (const node of nodes) {
    for (const inputId of node.inputs) {
      lines.push(`  ${nodeId(inputId)} --> ${nodeId(node.id)}`);
    }
  }
  return lines.join("\n");
}

export function toDot(nodes: TapeNode[]): string {
  const lines: string[] = ["digraph mnemosyne {", '  rankdir="LR";'];
  for (const node of nodes) {
    lines.push(`  ${nodeId(node.id)} [label="${nodeLabel(node).replace(/"/g, '\\"')}"];`);
  }
  for (const node of nodes) {
    for (const inputId of node.inputs) {
      lines.push(`  ${nodeId(inputId)} -> ${nodeId(node.id)};`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}

/** Walk backward from `rootId` through `inputs` edges to get one value's full ancestry. */
export function subgraphFrom(nodes: TapeNode[], rootId: number): TapeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<number>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    for (const inputId of node.inputs) stack.push(inputId);
  }
  return nodes.filter((n) => seen.has(n.id)).sort((a, b) => a.id - b.id);
}

/** Walk forward from `rootId` to every node that (transitively) consumed it. */
export function descendantsOf(nodes: TapeNode[], rootId: number): TapeNode[] {
  const seen = new Set<number>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const node of nodes) {
      if (node.inputs.includes(id)) stack.push(node.id);
    }
  }
  return nodes.filter((n) => seen.has(n.id)).sort((a, b) => a.id - b.id);
}
