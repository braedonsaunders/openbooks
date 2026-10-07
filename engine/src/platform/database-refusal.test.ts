import assert from "node:assert/strict";
import test from "node:test";
import { guardRefusalMessage } from "./database-refusal.ts";

test("database refusals preserve the authored remedy through query wrappers without exposing driver detail", () => {
  const cause = Object.assign(new Error(" Configure Vacation terms.\nPrivate context"), {
    code: "P0001", detail: "Private row", hint: "Private query",
  });
  assert.equal(guardRefusalMessage(new Error("Failed query: private payroll values", {
    cause: new Error("Transaction failed", { cause }),
  })), "Configure Vacation terms.");
  assert.equal(guardRefusalMessage(cause), "Configure Vacation terms.");
});

test("explicit check-violation remedies require a PL/pgSQL raise and deliberate caller admission", () => {
  const raised = Object.assign(new Error("Preserve historical vacation evidence."), {
    code: "23514", routine: "exec_stmt_raise",
  });
  assert.equal(guardRefusalMessage(raised), undefined);
  assert.equal(guardRefusalMessage(new Error("Failed query", { cause: raised }), {
    includeRaisedCheckViolations: true,
  }), "Preserve historical vacation evidence.");
  assert.equal(guardRefusalMessage(Object.assign(new Error("Row violates private_constraint"), {
    code: "23514", routine: "ExecConstraints", detail: "Private values",
  }), { includeRaisedCheckViolations: true }), undefined);
});

test("unknown, empty and cyclic database causes expose no query text as a guard remedy", () => {
  assert.equal(guardRefusalMessage(new Error("Failed query: private values")), undefined);
  assert.equal(guardRefusalMessage({ code: "P0001", message: " \nPrivate detail" }), undefined);
  const loop: { cause?: unknown } = {};
  loop.cause = loop;
  assert.equal(guardRefusalMessage(loop), undefined);
});
