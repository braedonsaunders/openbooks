import assert from "node:assert/strict";
import test from "node:test";
import { UnrestrictedScopeError } from "@openbooks/engine/organization/scope";
import { assertScheduleScope } from "./schedule-scope";

const customerId = "00000000-0000-4000-8000-000000000001";

test("customer-specific schedules remain available within restricted subsidiary scope", () => {
  assert.doesNotThrow(() => assertScheduleScope(new Set(["subsidiary-a"]), customerId, customerId));
});

test("price-level schedules require unrestricted scope on create, edit, or delete", () => {
  const restricted = new Set(["subsidiary-a"]);
  for (const scheduleCustomers of [[null], [null, customerId], [customerId, null]] as const) {
    assert.throws(
      () => assertScheduleScope(restricted, ...scheduleCustomers),
      (error: unknown) => error instanceof UnrestrictedScopeError && error.status === 403,
    );
  }
  assert.doesNotThrow(() => assertScheduleScope(null, null));
});

test("unknown subsidiary scope fails closed for organization-wide schedules", () => {
  assert.throws(() => assertScheduleScope(undefined, null), UnrestrictedScopeError);
});
