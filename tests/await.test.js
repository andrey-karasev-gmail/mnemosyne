require("ts-node/register/transpile-only");

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { compile } = require("../src/compile");
const { Tape } = require("../src/runtime");

async function execute(source, withPlugin, tape) {
  const context = vm.createContext({ __t: tape });
  new vm.Script(compile(source, withPlugin, "await-case.ts")).runInContext(context);
  await vm.runInContext("pendingResult", context);
  return context;
}

test("await detaches async frames so synchronous bindings use their own scope", async () => {
  const source = `
    let shared = 10;
    let release;
    let pendingResult;
    let asyncValue;
    const gate = new Promise((resolve) => { release = resolve; });
    async function later() {
      const shared = 100;
      await gate;
      const afterAwait = shared + 1;
      await Promise.resolve();
      return afterAwait;
    }
    const task = later();
    const syncValue = shared + 1;
    release();
    pendingResult = task.then((value) => { asyncValue = value; });
  `;

  const tape = new Tape();
  const plain = await execute(source, false, undefined);
  tape.reset();
  const traced = await execute(source, true, tape);

  assert.equal(vm.runInContext("syncValue", traced), vm.runInContext("syncValue", plain));
  assert.equal(vm.runInContext("asyncValue", traced), vm.runInContext("asyncValue", plain));
  assert.equal(vm.runInContext("asyncValue", traced), 101);

  const syncBinding = tape.nodes.find((node) => node.kind === "bind" && node.label === "syncValue");
  assert.ok(syncBinding);
  const syncOperation = tape.nodes[syncBinding.inputs[0]];
  const moduleShared = tape.nodes.find((node) => node.kind === "bind" && node.label === "shared");
  assert.equal(syncOperation.value, 11);
  assert.ok(syncOperation.inputs.includes(moduleShared.id));
});

test("a synchronous async-fn pre-await path keeps return frame balance", async () => {
  const source = `
    async function immediate() { return 7; }
    pendingResult = immediate().then((value) => { answer = value; });
  `;
  const tape = new Tape();
  const context = await execute(source, true, tape);
  assert.equal(vm.runInContext("answer", context), 7);
  assert.equal(tape.nodes.some((node) => node.kind === "return" && node.label === "immediate return"), true);
});
