require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { compile } = require("../src/compile");
const { Tape } = require("../src/runtime");
const { toMermaid, subgraphFrom } = require("../src/export-mermaid");

test("named package imports become package provenance nodes with value ancestry", () => {
  const tape = new Tape();
  const source = `
    import { parse } from "@babel/parser";
    const result = parse("const answer = 1", { sourceType: "module" });
  `;
  const context = vm.createContext({ __t: tape, require });
  new vm.Script(compile(source, true, "package-case.ts")).runInContext(context);

  const packageNode = tape.nodes.find((node) => node.kind === "package");
  assert.ok(packageNode);
  assert.equal(packageNode.package.packageName, "@babel/parser");
  assert.equal(packageNode.package.functionName, "parse");
  assert.equal(typeof packageNode.package.version, "string");
  assert.equal(typeof packageNode.package.timestamp, "string");
  assert.equal(typeof packageNode.package.executionTimeMs, "number");
  const binding = tape.nodes.find((node) => node.kind === "bind" && node.label === "result");
  assert.ok(binding.inputs.includes(packageNode.id));
  assert.match(toMermaid(subgraphFrom(tape.nodes, binding.id)), /@babel\/parser@/);
});

test("AI calls preserve values and capture prompt provenance, metadata, and usage", async () => {
  const tape = new Tape();
  tape.bind("prompt", "Choose A", { scope: "const", source: { kind: "literal" }, isDeclaration: true });
  const response = await tape.ai(
    async () => ({ text: "A", usage: { total_tokens: 17 } }),
    { provider: "openai", model: "gpt-5", prompt: "Choose A", temperature: 0.2, metadata: { purpose: "test" }, inputMeta: { kind: "ident", name: "prompt" } },
  );
  assert.equal(response.text, "A");
  const node = tape.nodes.find((candidate) => candidate.kind === "ai");
  assert.ok(node);
  assert.equal(node.ai.provider, "openai");
  assert.equal(node.ai.model, "gpt-5");
  assert.equal(node.ai.tokens, 17);
  assert.equal(node.inputs.length, 1);
  assert.equal(node.ai.metadata.purpose, "test");
});
