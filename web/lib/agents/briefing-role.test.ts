import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Briefing roles (b06): the narrative's focus follows the caller's grants —
// clerks get their lane, stewards and owners get everything.
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier.startsWith("@/")) {
    const path = root + "web/" + specifier.slice(2);
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { briefingRole, briefingReadAuthz, BRIEFING_SCOPE, BRIEFING_MAX_STEPS } = await import("./briefing");
import type { Authz } from "../authz";

function authzWith(perms: string[], superAdmin = false): Authz {
  return {
    user: {
      id: "99999999-0000-4000-8000-000000000001",
      email: "reader@scratch.test",
      name: "Reader",
      roles: [],
      orgId: "88888888-0000-4000-8000-000000000001",
      envKind: "production",
      productionOrgId: "88888888-0000-4000-8000-000000000001",
      isSuperAdmin: superAdmin,
      homeUserId: "99999999-0000-4000-8000-000000000001",
      homeOrgId: "88888888-0000-4000-8000-000000000001",
    },
    permissions: new Set(perms),
    allowedSubsidiaryIds: null,
  } as unknown as Authz;
}

test("briefing roles follow the caller's grants", () => {
  assert.equal(briefingRole(authzWith([], true)), "owner");
  assert.equal(briefingRole(authzWith(["assistant.use", "admin.setup.manage"])), "owner");
  assert.equal(briefingRole(authzWith(["assistant.use", "gl.read"])), "controller");
  assert.equal(briefingRole(authzWith(["assistant.use", "reports.read"])), "controller");
  assert.equal(briefingRole(authzWith(["assistant.use", "ap.read", "ar.read"])), "controller");
  assert.equal(briefingRole(authzWith(["assistant.use", "ap.read"])), "ap_clerk");
  assert.equal(briefingRole(authzWith(["assistant.use", "ar.read"])), "ar_clerk");
});

test("briefing tools are read-only for every caller", () => {
  const read = briefingReadAuthz(authzWith(["assistant.use", "assistant.write", "gl.read"]));
  assert.ok(!read.permissions.has("assistant.write"), "write grant stripped");
  assert.ok(read.permissions.has("gl.read"), "read grants preserved");
  assert.equal(BRIEFING_SCOPE, "briefing");
  assert.ok(BRIEFING_MAX_STEPS <= 12, "bounded background turn");
});
