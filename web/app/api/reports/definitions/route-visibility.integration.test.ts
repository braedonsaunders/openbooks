import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * RPT-VIS: the definitions list and detail endpoints must branch on
 * report_type. Statements carry query=null by design, so the entity gate
 * alone hides every built-in statement; they answer the statement feature
 * gate instead. A permitted reader sees the seeded P&L, balance sheet and
 * project-profitability; with the projects switch off, project-profitability
 * disappears from the list and 404s by id; unknown report types stay
 * hidden everywhere.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const engineRoot = new URL("../../../../../engine/", import.meta.url).href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __reportVisibilityState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__reportVisibilityState;
          return {
            user: { orgId: s.orgId, id: s.actorId },
            permissions: new Set(['reports.read']),
            allowedSubsidiaryIds: null,
          };
        }
      `);
    if (specifier.startsWith("@openbooks/engine/")) {
      return next(new URL(specifier.slice("@openbooks/engine/".length), engineRoot).href, context);
    }
    if (specifier.startsWith("@openbooks/reports")) {
      return next(new URL("packages/reports/src/index.ts", root).href, context);
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, createScratchUser } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { GET: listDefinitions } = await import("./route.ts");
const { GET: getDefinition } = await import("./[id]/route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

type Definition = { id: string; slug: string; report_type: string };

async function list(): Promise<Definition[]> {
  const response = await withOrgContext(state.orgId, () => listDefinitions());
  assert.equal(response.status, 200);
  const body = (await response.json()) as { definitions: Definition[] };
  return body.definitions;
}

async function detail(id: string): Promise<Response> {
  return withOrgContext(state.orgId, () =>
    getDefinition(new Request("http://reports.test/api/reports/definitions/x"), {
      params: Promise.resolve({ id }),
    }),
  );
}

async function setProjects(orgId: string, on: boolean): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,projects}', ${JSON.stringify(on)}::jsonb, true)
     where id = ${orgId}`));
}

test("statements are visible to a permitted reader and hide by feature switch", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Report Reader", "viewer"));
    state.orgId = org.orgId;
    state.actorId = actorId;

    // An unknown report type stays hidden everywhere, fail closed.
    const mysteryId = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into report_definitions
        (id, org_id, kind, report_type, slug, name, description, query, statement,
         system, created_by, updated_by)
      values (${mysteryId}, ${org.orgId}, 'custom', 'mystery', 'mystery-report',
              'Mystery Report', null, null, null, false, ${actorId}, ${actorId})`));

    await setProjects(org.orgId, true);
    const open = await list();
    const openSlugs = new Set(open.map((row) => row.slug));
    assert.ok(openSlugs.has("profit-and-loss"), "a permitted reader lists the seeded P&L");
    assert.ok(openSlugs.has("balance-sheet"), "a permitted reader lists the seeded balance sheet");
    assert.ok(openSlugs.has("project-profitability"), "a permitted reader lists project-profitability with projects on");
    assert.ok(!openSlugs.has("mystery-report"), "an unknown report type stays out of the list");
    const pnl = open.find((row) => row.slug === "profit-and-loss")!;
    const pnlDetail = await detail(pnl.id);
    assert.equal(pnlDetail.status, 200, "a permitted reader opens the seeded P&L by id");
    assert.equal(((await pnlDetail.json()) as { definition: Definition }).definition.slug, "profit-and-loss");

    await setProjects(org.orgId, false);
    const closed = await list();
    const closedSlugs = new Set(closed.map((row) => row.slug));
    assert.ok(closedSlugs.has("profit-and-loss"), "the P&L has no feature gate and stays listed");
    assert.ok(closedSlugs.has("balance-sheet"), "the balance sheet has no feature gate and stays listed");
    assert.ok(!closedSlugs.has("project-profitability"), "project-profitability hides with projects off");
    const gated = open.find((row) => row.slug === "project-profitability")!;
    assert.equal((await detail(gated.id)).status, 404, "a feature-hidden statement 404s by id like a missing one");
    assert.equal(
      (await detail(pnl.id)).status,
      200,
      "the ungated P&L stays readable with projects off",
    );
    assert.equal((await detail(mysteryId)).status, 404, "an unknown report type 404s by id");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
