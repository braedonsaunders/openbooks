import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Rate-card saves fence dates and shapes but never bound rate magnitudes, so
 * a pasted 20-digit bill rate sails through every named check and dies in
 * Postgres as a raw numeric overflow — surfacing the unnamed "save" error
 * instead of failing closed with a named refusal and nothing written.
 * item_rate_lines.bill_rate/cost_rate are numeric(19,4).
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __rateCardWidthState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__rateCardWidthState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
      `);
    if (specifier.endsWith("/lib/projects-gate")) return virtual("export async function guardProjectsFeature() { return null }");
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { PUT } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = settings || '{"features": {"projects": true}}'::jsonb where id = ${org.orgId}`),
  );
  const bookId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into item_rate_books (org_id, id, code, name, currency, is_default, is_active, created_by, updated_by)
    values (${org.orgId}, ${bookId}, 'WBOUND', 'Width bound', 'CAD', false, true, ${actorId}, ${actorId})`));
  const versionId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into item_rate_versions (org_id, id, rate_book_id, effective_from, status, custom, created_by, updated_by)
    values (${org.orgId}, ${versionId}, ${bookId}, '2026-07-01', 'draft', '{}'::jsonb, ${actorId}, ${actorId})`));
  await withBypassContext(() => db.execute(sql`
    insert into labor_rate_version_policies (org_id, version_id, derivation_policy, created_by, updated_by)
    values (${org.orgId}, ${versionId}, 'explicit', ${actorId}, ${actorId})`));
  const lineId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into item_rate_lines (org_id, id, version_id, item_id, unit_code, unit_name, base_quantity, bill_rate,
                                 time_type_bill_rates, sort_order, created_by, updated_by)
    values (${org.orgId}, ${lineId}, ${versionId}, ${org.items.fifo}, 'hour', 'Hour', 1, '100.00', '{}'::jsonb,
            0, ${actorId}, ${actorId})`));
  return { org, versionId, lineId };
}

const put = (versionId: string, body: unknown) =>
  withOrgContext(state.orgId, () =>
    PUT(
      new Request(`http://rates.test/api/labor-rate-cards/${versionId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: versionId }) },
    ),
  );

const body = (lineId: string, itemId: string, regular: string) => ({
  name: "Width bound", code: "WBOUND2", effective_from: "2026-07-01", status: "draft",
  derivation_policy: "explicit", scopes: [], terms: [],
  lines: [{ id: lineId, itemId, regular }],
  adjustments: [],
});

async function billRate(lineId: string): Promise<string> {
  const rows = (await withBypassContext(() => db.execute<{ bill_rate: string }>(sql`
    select bill_rate::text from item_rate_lines where id = ${lineId}`))).rows;
  return rows[0]!.bill_rate;
}

test("rate-card save refuses a bill rate wider than numeric(19,4) without writing", { skip: !DB }, async () => {
  const { org, versionId, lineId } = await fixture();
  try {
    const response = await put(versionId, body(lineId, org.items.fifo, "99999999999999999999.99"));
    const json = (await response.json().catch(() => null)) as { errorCode?: string } | null;
    assert.notEqual(json?.errorCode, "save", `expected a named refusal, got: ${JSON.stringify(json)}`);
    assert.equal(await billRate(lineId), "100.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("rate-card save still files an ordinary rate", { skip: !DB }, async () => {
  const { org, versionId, lineId } = await fixture();
  try {
    const response = await put(versionId, body(lineId, org.items.fifo, "125.50"));
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await billRate(lineId), "125.5000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
