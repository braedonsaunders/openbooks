import assert from "node:assert/strict";
import test from "node:test";
import { remapScopeFilter } from "./json-references.ts";

const ids = {
  subsidiaries: new Map([["11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]]),
  departments: new Map([["22222222-2222-4222-8222-222222222222", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]]),
};

test("remapScopeFilter keeps absent and null pins, maps both identities case-insensitively", () => {
  assert.deepEqual(remapScopeFilter({}, ids, "t"), {});
  assert.deepEqual(remapScopeFilter({ employer_subsidiary_id: null, department_id: null }, ids, "t"), { employer_subsidiary_id: null, department_id: null });
  assert.deepEqual(
    remapScopeFilter({ employer_subsidiary_id: "11111111-1111-4111-8111-111111111111".toUpperCase(), department_id: "22222222-2222-4222-8222-222222222222" }, ids, "t"),
    { employer_subsidiary_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", department_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  );
});

test("remapScopeFilter refuses unknown keys, non-objects and identities without a counterpart", () => {
  assert.throws(() => remapScopeFilter(null, ids, "row"), /row: invalid scope filter/);
  assert.throws(() => remapScopeFilter([], ids, "row"), /row: invalid scope filter/);
  assert.throws(() => remapScopeFilter({ location_id: "x" }, ids, "row"), /row: scope filter carries an unknown key location_id/);
  assert.throws(() => remapScopeFilter({ department_id: "33333333-3333-4333-8333-333333333333" }, ids, "row"), /row: scope filter department_id has no counterpart in the target organization/);
  assert.throws(() => remapScopeFilter({ employer_subsidiary_id: 7 }, ids, "row"), /row: scope filter employer_subsidiary_id has no counterpart/);
});
