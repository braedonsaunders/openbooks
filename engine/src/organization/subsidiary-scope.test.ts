import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAnyPermission,
  assertUnrestrictedScope,
  ScopeNotFoundError,
  subsidiaryScopeAllows,
  UNRESTRICTED_SCOPE_REQUIRED,
  UnrestrictedScopeError,
} from "./subsidiary-scope.ts";

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

test("unrestricted scope allows every subsidiary including null", () => {
  assert.equal(subsidiaryScopeAllows(null, A), true);
  assert.equal(subsidiaryScopeAllows(null, null), true);
  assert.equal(subsidiaryScopeAllows(null, undefined), true);
});

test("restricted scope fails closed on unknown, null and empty subsidiaries", () => {
  const scope = new Set([A]);
  assert.equal(subsidiaryScopeAllows(scope, A), true);
  assert.equal(subsidiaryScopeAllows(scope, B), false);
  assert.equal(subsidiaryScopeAllows(scope, null), false);
  assert.equal(subsidiaryScopeAllows(scope, undefined), false);
  assert.equal(subsidiaryScopeAllows(scope, ""), false);
  assert.equal(subsidiaryScopeAllows(new Set(), A), false);
});

test("org-wide null subsidiaries read only with the explicit option", () => {
  assert.equal(subsidiaryScopeAllows(new Set([A]), null, { orgWideNull: true }), true);
  assert.equal(subsidiaryScopeAllows(new Set([A]), B, { orgWideNull: true }), false);
});

test("assertUnrestrictedScope passes only the explicit null sentinel", () => {
  assert.doesNotThrow(() => assertUnrestrictedScope(null));
  const cases: ReadonlyArray<ReadonlySet<string> | null | undefined> = [
    new Set([A]),
    new Set<string>(),
    undefined,
  ];
  for (const scope of cases) {
    assert.throws(() => assertUnrestrictedScope(scope), (error: unknown) => {
      assert.ok(error instanceof UnrestrictedScopeError);
      assert.equal((error as UnrestrictedScopeError).status, 403);
      assert.equal((error as Error).message, UNRESTRICTED_SCOPE_REQUIRED);
      return true;
    });
  }
});

test("assertAnyPermission passes when any family permission is held", () => {
  const grants = new Set(["ar.pay"]);
  assert.doesNotThrow(() => assertAnyPermission((p) => grants.has(p), ["ap.pay", "ar.pay"]));
  assert.throws(() => assertAnyPermission((p) => grants.has(p), ["ap.pay"]), (error: unknown) => {
    assert.ok(error instanceof ScopeNotFoundError);
    assert.equal((error as ScopeNotFoundError).status, 404);
    assert.equal((error as Error).message, "not found");
    return true;
  });
  assert.throws(() => assertAnyPermission(() => false, []), ScopeNotFoundError);
});
