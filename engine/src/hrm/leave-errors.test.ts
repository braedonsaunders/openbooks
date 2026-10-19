import assert from "node:assert/strict";
import test from "node:test";
import { postgresErrorCode } from "./leave-errors.ts";

test("PostgreSQL codes survive nested driver errors and cyclic causes", () => {
  assert.equal(postgresErrorCode({ cause: { cause: { code: "23P01" } } }), "23P01");
  assert.equal(postgresErrorCode({ code: "23505", cause: { code: "23P01" } }), "23505");

  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(postgresErrorCode(cyclic), undefined);
});
