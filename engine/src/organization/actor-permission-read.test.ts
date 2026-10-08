import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { actorHasPermission, createActorPermissionRead } from "./actor-permissions.ts";

function fixture() {
  const state = {
    identity: { isActive: true, isSuperAdmin: false },
    roles: [["payroll.*", "time.read"]],
    overrides: [{ permission: "payroll.manage", effect: "deny" as "deny" | "grant" },
      { permission: "admin.setup.manage", effect: "grant" as "deny" | "grant" }],
    extensions: [{ key: "sample.read", active: true }, { key: "retired.read", active: false }],
    failIdentity: false,
  };
  const calls = { identity: 0, roles: 0, overrides: 0, extensions: 0 };
  const dialect = new PgDialect();
  const exec = { async execute(query: SQL) {
    const compiled = dialect.sqlToQuery(query);
    assert.ok(compiled.params.includes("org"));
    let rows: unknown[];
    if (compiled.sql.includes("is_super_admin")) {
      calls.identity++;
      if (state.failIdentity) throw new Error("Identity read refused");
      rows = [state.identity];
    } else if (compiled.sql.includes("from role_assignments")) {
      calls.roles++; rows = state.roles.map(permissions => ({ permissions }));
    } else if (compiled.sql.includes("from user_permission_overrides")) {
      calls.overrides++; rows = state.overrides;
    } else if (compiled.sql.includes("from apps m")) {
      calls.extensions++; rows = state.extensions;
    } else throw new Error("Unexpected authority query");
    if (!compiled.sql.includes("from apps m")) assert.ok(compiled.params.includes("actor"));
    return { rows: structuredClone(rows) };
  } } as unknown as SqlExecutor;
  return { state, calls, exec };
}

test("concurrent permission keys share native identity and grants while denies retain precedence", async () => {
  const f = fixture();
  const read = createActorPermissionRead(f.exec, "org", "actor");
  assert.deepEqual(await Promise.all([read("payroll.read"), read("payroll.manage"), read("time.read"), read("admin.setup.manage")]),
    [true, false, true, true]);
  assert.deepEqual(f.calls, { identity: 1, roles: 1, overrides: 1, extensions: 0 });
  f.state.overrides.push({ permission: "time.read", effect: "deny" });
  assert.equal(await createActorPermissionRead(f.exec, "org", "actor")("time.read"), false);
  assert.equal(await actorHasPermission(f.exec, "org", "actor", "time.read"), false);
  f.state.identity.isActive = false;
  assert.equal(await createActorPermissionRead(f.exec, "org", "actor")("payroll.read"), false);
  assert.equal(await actorHasPermission(f.exec, "org", "actor", "payroll.read"), false);
});

test("super-admin reads still refuse inactive extension declarations and refresh on the next read", async () => {
  const f = fixture(); f.state.identity.isSuperAdmin = true;
  const read = createActorPermissionRead(f.exec, "org", "actor");
  assert.deepEqual(await Promise.all([read("sample.read"), read("retired.read"), read("gl.post")]), [true, false, true]);
  assert.deepEqual(f.calls, { identity: 1, roles: 0, overrides: 0, extensions: 1 });
  f.state.extensions[0]!.active = false;
  assert.equal(await createActorPermissionRead(f.exec, "org", "actor")("sample.read"), false);
  assert.equal(await actorHasPermission(f.exec, "org", "actor", "sample.read"), false);
});

test("a failed shared identity refuses every dependent permission instead of returning a grant", async () => {
  const f = fixture(); f.state.failIdentity = true;
  const read = createActorPermissionRead(f.exec, "org", "actor");
  const results = await Promise.allSettled([read("payroll.read"), read("time.read")]);
  assert.equal(f.calls.identity, 1);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.match(result.reason.message, /Identity read refused/);
  }
  assert.equal(f.calls.roles, 0);
});
