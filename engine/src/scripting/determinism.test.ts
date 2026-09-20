import assert from "node:assert/strict";
import test from "node:test";
import { runScript, type ScriptContext } from "./scripting.ts";

const context: ScriptContext = {
  trigger: "custom_gl_lines",
  document: { kind: "journal", documentDate: "2026-09-20" },
  lines: [{ amount: "12.3400" }],
  kernelLines: [{ accountCode: "1000", amount: "12.3400" }],
  org: { id: "not-a-database-tenant", name: "Sandbox only", baseCurrency: "USD" },
};

const deterministic = {
  strict: true,
  deterministic: true,
  forbidJournalCreate: true,
};

// Exercise the production runner and real QuickJS realm. No validation or VM
// doubles: a misplaced guard must actually allow the former capture to run.
for (const [name, source, refusal] of [
  ["top-level clock value", "const captured = Date.now(); function main() { return captured; }", "Date"],
  ["captured Date constructor", "const CapturedDate = Date; function main() { return new CapturedDate().getTime(); }", "Date"],
  ["captured random function", "const capturedRandom = Math.random; function main() { return capturedRandom(); }", "Math.random"],
  ["top-level random amount", "const amount = Math.random() < 0.5 ? '1.0000' : '2.0000'; function main() { return amount; }", "Math.random"],
  ["clock through globalThis", "function main() { return globalThis['Date'].now(); }", "Date"],
  ["random through indirect evaluation", "function main() { return (0, eval)('Math.random()'); }", "Math.random"],
  ["clock through Function", "function main() { return Function('return Date.now()')(); }", "Date"],
] as const) {
  test(`deterministic scripts refuse ${name} by name`, async () => {
    const result = await runScript(source, context, 2_000, deterministic);
    assert.equal(result.status, "error");
    assert.ok(result.abortReason?.includes(`${refusal} is not available`), result.abortReason ?? "(no abort reason)");
    assert.ok(result.abortReason?.includes("use values supplied in ctx"), result.abortReason ?? "(no abort reason)");
    assert.equal(result.returned, undefined);
  });
}

for (const [name, source] of [
  ["Date assignment", "globalThis.Date = function () {};"],
  ["Date replacement", "Object.defineProperty(globalThis, 'Date', { value: function () {} });"],
  ["Date deletion", "delete globalThis.Date;"],
  ["random assignment", "Math.random = () => 0.25;"],
  ["random replacement", "Object.defineProperty(Math, 'random', { value: () => 0.25 });"],
  ["random deletion", "delete Math.random;"],
  ["Math replacement", "globalThis.Math = { random: () => 0.25 };"],
] as const) {
  test(`deterministic controls reject ${name}`, async () => {
    const result = await runScript(`${source} function main() { return 'unprotected'; }`, context, 2_000, deterministic);
    assert.equal(result.status, "error");
    assert.equal(result.returned, undefined);
  });
}

test("user declarations cannot replace the intrinsics used to install the controls", async () => {
  const result = await runScript(`
    function Object() { throw new Error('user Object ran during installation'); }
    function Error() { return { message: 'user Error hid the refusal' }; }
    const captured = Math.random;
    function main() { return captured(); }
  `, context, 2_000, deterministic);
  assert.equal(result.status, "error");
  assert.match(result.abortReason ?? "", /Math\.random is not available/);
});

for (const [name, source] of [
  ["governed query", "function main() { return ob.query('select random()'); }"],
  ["record helper", "function main() { return ob.record.load('documents', 'id'); }"],
  ["search helper", "function main() { return ob.search('documents', {}); }"],
  ["raw bridge before main", "const captured = ob.__query('select now()'); function main() { return captured; }"],
] as const) {
  test(`deterministic scripts refuse ${name} before database access`, async () => {
    const result = await runScript(source, context, 2_000, deterministic);
    assert.equal(result.status, "error");
    assert.match(result.abortReason ?? "", /query is not available in custom_gl_lines/);
    assert.match(result.abortReason ?? "", /use document, lines, and kernelLines supplied in ctx/);
  });
}

test("deterministic scripts keep ordinary math and supplied document values", async () => {
  const source = `function main(ctx) {
    return { date: ctx.document.documentDate, lines: ctx.kernelLines, value: Math.max(2, 5) };
  }`;
  const first = await runScript(source, context, 2_000, deterministic);
  const second = await runScript(source, context, 2_000, deterministic);
  assert.equal(first.status, "ok", first.abortReason ?? "(no abort reason)");
  assert.equal(second.status, "ok", second.abortReason ?? "(no abort reason)");
  assert.deepEqual(first.returned, { date: "2026-09-20", lines: context.kernelLines, value: 5 });
  assert.deepEqual(second.returned, first.returned);
});

test("restrictions do not leak into subsequent non-deterministic script contexts", async () => {
  const blocked = await runScript("function main() { return Date.now(); }", context, 2_000, deterministic);
  assert.equal(blocked.status, "error");
  const ordinary = await runScript(`
    const clock = Date.now;
    const random = Math.random;
    function main() { return { clock: typeof clock(), random: typeof random() }; }
  `, { ...context, trigger: "scheduled" }, 2_000);
  assert.equal(ordinary.status, "ok", ordinary.abortReason ?? "(no abort reason)");
  assert.deepEqual(ordinary.returned, { clock: "number", random: "number" });
});
