import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * The timesheet approval chain is org-wide policy: it governs every legal
 * entity's timesheets at once, so declaring it needs unrestricted
 * subsidiary scope. A restricted time.manage holder gets the named 403
 * and writes nothing; reading the chain stays open — approvers need it
 * to do their job and it discloses no per-subsidiary material.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = {
  orgId: "",
  actorId: "",
  allowedSubsidiaryIds: null as ReadonlySet<string> | null,
};
Object.assign(globalThis, { __approvalStageScopeState: state });
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
      context.parentURL?.includes("/api/time/approval-stages/")
    ) {
      return virtual(`
        export async function guardFeaturePermission() {
          const s = globalThis.__approvalStageScopeState;
          return {
            user: { orgId: s.orgId, id: s.actorId },
            permissions: new Set(['time.manage']),
            allowedSubsidiaryIds: s.allowedSubsidiaryIds,
          };
        }
      `);
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { GET, PUT } = await import("./route.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

const CHAIN = [{ order: 1, approverKind: "supervisor" }];

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() => db.execute(sql`
    update orgs
       set settings = jsonb_set(
         jsonb_set(coalesce(settings, '{}'::jsonb), '{features,fieldTime}', 'true'::jsonb, true),
         '{features,fieldTimeMultiStageApproval}', 'true'::jsonb, true)
     where id = ${org.orgId}`));
  return { org };
}

const get = (subject: string) =>
  withOrgContext(state.orgId, () => GET(new Request(`http://chain.test/api/time/approval-stages?subject=${subject}`)));

const put = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    PUT(
      new Request("http://chain.test/api/time/approval-stages", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );

async function chainCount(orgId: string): Promise<number> {
  const rows = (
    await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from time_approval_stages where org_id = ${orgId}`),
    )
  ).rows;
  return rows[0]!.n;
}

test("a restricted caller cannot declare the chain", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await put({ subject: "timesheet_week", stages: CHAIN });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
    assert.equal(await chainCount(org.orgId), 0, "a refused write stores no chain");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an unrestricted caller declares it; restricted callers still read it", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    state.allowedSubsidiaryIds = null;
    const saved = await put({ subject: "timesheet_week", stages: CHAIN });
    assert.equal(saved.status, 200, JSON.stringify(await saved.json().catch(() => null)));
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await get("timesheet_week");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { subject: string; stages: { order: number }[] };
    assert.equal(body.subject, "timesheet_week");
    assert.equal(body.stages.length, 1);
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
