import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * H-TIMESET: the field-time rules are org-wide policy with no subsidiary
 * lineage — rounding, breaks and auto-close govern every entity's clocks at
 * once. PUT needs unrestricted subsidiary scope: a restricted time.manage
 * holder gets the named 403 and stores nothing. GET stays open: the rules
 * are operational policy disclosing no per-subsidiary material, and
 * foremen need them to enter time. Only the gate is doubled; validation,
 * writer and database are real.
 */
const state = {
  orgId: "",
  actorId: "",
  allowedSubsidiaryIds: null as ReadonlySet<string> | null,
};
Object.assign(globalThis, { __fieldTimeSettingsScopeState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation")
      return virtual("export function redirect() {}; export function notFound() {}");
    if (specifier === "next/headers")
      return virtual("export function cookies() { throw new Error('no cookies in route test') }");
    if (
      specifier.endsWith("/lib/feature-gates") &&
      context.parentURL?.includes("/api/time/settings")
    ) {
      return virtual(`
        export async function guardFeaturePermission() {
          const s = globalThis.__fieldTimeSettingsScopeState;
          return {
            user: { orgId: s.orgId, id: s.actorId },
            permissions: new Set(['time.manage']),
            allowedSubsidiaryIds: s.allowedSubsidiaryIds,
          };
        }
      `);
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { GET, PUT } = await import("./route.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

const RULES = {
  roundingIncrement: 15,
  roundingMode: "nearest",
  unpaidBreakMinutes: 30,
  autoCloseHours: 12,
  signatureRequired: true,
  equipmentToleranceHours: "0.5",
  photoRequired: false,
};

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  state.orgId = org.orgId;
  state.actorId = "00000000-0000-0000-0000-000000000000";
  return { org };
}

const put = (body: unknown) =>
  PUT(
    new Request("http://clock.test/api/time/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

async function storedRules(orgId: string): Promise<unknown> {
  const row = (
    await withBypassContext(() =>
      db.execute<{ settings: unknown }>(sql`
        select settings->'fieldTime' as settings from orgs where id = ${orgId}`),
    )
  ).rows[0];
  return row?.settings ?? null;
}

test("a restricted caller cannot rewrite org-wide field-time rules", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await put(RULES);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
    assert.equal(await storedRules(org.orgId), null, "a refused write stores no rules");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an unrestricted caller writes them; restricted callers still read them", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    state.allowedSubsidiaryIds = null;
    const saved = await put(RULES);
    assert.equal(saved.status, 200, JSON.stringify(await saved.json().catch(() => null)));
    assert.deepEqual(await storedRules(org.orgId), {
      roundingIncrement: 15,
      roundingMode: "nearest",
      unpaidBreakMinutes: 30,
      autoCloseHours: 12,
      signatureRequired: true,
      equipmentToleranceHours: "0.5",
      photoRequired: false,
    });
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await GET();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()) as unknown, {
      settings: {
        roundingIncrement: 15,
        roundingMode: "nearest",
        unpaidBreakMinutes: 30,
        autoCloseHours: 12,
        signatureRequired: true,
        equipmentToleranceHours: "0.5",
        photoRequired: false,
      },
    });
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
