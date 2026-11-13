require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { runTraceOnce } = require("../src/pipeline");

// End-to-end guard for the flagship example. It exercises three things the unit
// tests cannot: hand-written `__t.ai()` calls in user code (which must also run
// in the plain pass), an async entrypoint whose trace continues after an
// `await` on a host-realm promise, and package calls into lodash/date-fns.
test("insurance-premium example traces end to end, past the AI await", async () => {
  const entryFile = path.join(__dirname, "..", "examples", "insurance-premium.ts");
  const result = await runTraceOnce(undefined, entryFile);

  assert.equal(result.identicalOutput, true);

  const aiNodes = result.nodes.filter((node) => node.kind === "ai");
  assert.equal(aiNodes.length, 1);
  assert.equal(aiNodes[0].ai.provider, "openai");
  assert.equal(aiNodes[0].ai.model, "gpt-5");

  const packageNames = new Set(
    result.nodes
      .filter((node) => node.kind === "package" && node.package)
      .map((node) => node.package.packageName),
  );
  assert.ok(packageNames.has("lodash"));
  assert.ok(packageNames.has("date-fns"));

  // The post-`await` tail must be on the tape: the final premium binding exists
  // and agrees with the decision the program itself printed.
  const decision = JSON.parse(result.instrumentedLogs.flat().join(""));
  const premium = result.nodes.find((node) => node.label === "premium");
  assert.ok(premium, "premium binding recorded after the AI await");
  assert.equal(premium.value, decision.premium);
});
