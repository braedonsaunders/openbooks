import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * The printable executed waiver regenerated from the live rows on every
 * print, so renaming the vendor or rewording the project silently rewrote an
 * already-executed legal release. Signing now freezes the full print image
 * (resolved names included) into executed_snapshot, and the printable route
 * serves that image for executed waivers. The renderer is stubbed to echo
 * its HTML, so these prove WHAT would print without launching Chromium.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
const captured: { html: string | null } = { html: null };
function resetCapture() {
  captured.html = null;
}
Object.assign(globalThis, { __lienExecutedState: state, __lienExecutedHtml: captured });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__lienExecutedState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
        export function guardSubsidiaryScope() { return null }
      `);
    // Never launch Chromium: echo the release HTML the printer would render.
    // A thin re-export-plus-override of the real @openbooks/pdf surface: the
    // star carries every name this double does not stub (notably
    // RendererUnavailableError, which lib/api/pdf-renderer imports), so the
    // next export added to the package cannot break this double's link again.
    // Importing the real index never launches Chromium — the browser pool
    // only launches on first render — so the stub stays hermetic.
    if (specifier === "@openbooks/pdf")
      return virtual(`
        export * from '${root}packages/pdf/src/index.ts';
        export async function renderHtmlDocumentPdf(args) {
          globalThis.__lienExecutedHtml.html = args.bodyHtml;
          return Buffer.from("MOCK-EXECUTED-PDF");
        }
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { PATCH } = await import("./route.ts");
const { GET } = await import("./pdf/route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

const VENDOR = "Original Vendor Co";
const PROJECT = "Original Project";

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = settings || '{"features": {"subcontractorCompliance": true, "projects": true}}'::jsonb where id = ${org.orgId}`),
  );
  const partyId = randomUUID();
  const projectId = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${partyId},${org.orgId},'vendor',${VENDOR},${org.subsidiaryId},true,'{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
    values (${projectId},${org.orgId},${org.subsidiaryId},'WAIVER',${PROJECT},${org.customerId},'active',true,'{}'::jsonb)`));
  const waiverId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into lien_waivers (org_id, waiver_number, direction, party_id, project_id, waiver_type, through_date, amount, currency, created_by, updated_by)
    values (${org.orgId}, 'LW-EXEC-1', 'received', ${partyId}, ${projectId}, 'conditional_progress', '2026-03-31', '1000.00', 'CAD', ${actorId}, ${actorId})
    returning id`))).rows[0]!.id;
  return { org, partyId, projectId, waiverId };
}

const sign = (waiverId: string) =>
  withOrgContext(state.orgId, () =>
    PATCH(
      new Request(`http://waiver.test/api/compliance/lien-waivers/${waiverId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sign", signedByName: "Sam Signer", signedAt: "2026-04-01" }),
      }),
      { params: Promise.resolve({ id: waiverId }) },
    ),
  );

const print = (waiverId: string) =>
  withOrgContext(state.orgId, () =>
    GET(
      new Request(`http://waiver.test/api/compliance/lien-waivers/${waiverId}/pdf`),
      { params: Promise.resolve({ id: waiverId }) },
    ),
  );

async function snapshotOf(waiverId: string) {
  const rows = (await withBypassContext(() =>
    db.execute<{ snapshot: { data: Record<string, unknown> } | null }>(
      sql`select executed_snapshot as snapshot from lien_waivers where id = ${waiverId}`,
    ))).rows;
  return rows[0]!.snapshot;
}

test("signing freezes the print image, later renames do not rewrite it", { skip: !DB }, async () => {
  const { org, partyId, projectId, waiverId } = await fixture();
  try {
    const signed = await sign(waiverId);
    assert.equal(signed.status, 200, JSON.stringify(await signed.json().catch(() => null)));
    const frozen = await snapshotOf(waiverId);
    assert.ok(frozen, "signing stamps the executed snapshot");
    assert.equal(frozen.data.claimantName, VENDOR);
    assert.ok(String(frozen.data.projectName).includes(PROJECT));

    // Rename everything the release names, then print.
    await withBypassContext(() => db.execute(sql`
      update parties set display_name = 'Renamed Vendor Inc' where id = ${partyId}`));
    await withBypassContext(() => db.execute(sql`
      update projects set name = 'Renamed Project' where id = ${projectId}`));
    resetCapture();
    const printed = await print(waiverId);
    assert.equal(printed.status, 200, JSON.stringify(await printed.json().catch(() => null)));
    const html = captured.html;
    assert.ok(html?.includes(VENDOR), "the print still names the vendor as executed");
    assert.ok(html?.includes(PROJECT), "the print still names the project as executed");
    assert.ok(!html?.includes("Renamed Vendor"), "the later rename does not rewrite the release");
    assert.ok(!html?.includes("Renamed Project"), "the later rewording does not rewrite the release");
    // The frozen image itself never moved.
    const still = await snapshotOf(waiverId);
    assert.deepEqual(still, frozen);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a waiver executed before the freeze prints bannered current records, never a clean release", { skip: !DB }, async () => {
  const { org, partyId, projectId, waiverId } = await fixture();
  try {
    // A legacy executed row: signed, but no frozen image was ever stamped.
    await withBypassContext(() => db.execute(sql`
      update lien_waivers set status = 'signed', signed_by_name = 'Old Signer',
             signed_at = '2026-04-01T00:00:00Z'::timestamptz
       where id = ${waiverId}`));
    // Rename everything the release names after the upgrade, then print.
    await withBypassContext(() => db.execute(sql`
      update parties set display_name = 'Renamed Vendor Inc' where id = ${partyId}`));
    await withBypassContext(() => db.execute(sql`
      update projects set name = 'Renamed Project' where id = ${projectId}`));
    resetCapture();
    const printed = await print(waiverId);
    assert.equal(printed.status, 200, JSON.stringify(await printed.json().catch(() => null)));
    const legacyHtml = captured.html;
    assert.ok(legacyHtml, "the legacy waiver still prints instead of stranding the operator");
    // The print is a bannered re-render of CURRENT records: the new names
    // appear, but always under the legacy banner naming its reading date.
    assert.ok(legacyHtml.includes("Renamed Vendor"), "the print reflects current records");
    assert.ok(legacyHtml.includes("Legacy waiver"), "the print banners itself as legacy evidence");
    assert.ok(
      legacyHtml.includes("reflect current records as of"),
      "the banner names the print as current records, not the release",
    );
    // A distinct filename and evidence header so the file is never archived
    // as the executed release.
    assert.match(
      printed.headers.get("content-disposition") ?? "",
      /LW-EXEC-1-legacy-unverified\.pdf/,
      "the legacy print files under its own name",
    );
    assert.equal(
      printed.headers.get("x-lien-waiver-evidence"),
      "legacy-unverified",
      "the legacy print carries its evidence state",
    );
    // The fix recovers nothing and invents nothing: no snapshot is stamped
    // from live rows at print time.
    const still = await snapshotOf(waiverId);
    assert.equal(still, null, "printing a legacy waiver never backfills a snapshot");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a newly signed waiver still freezes its snapshot and prints clean", { skip: !DB }, async () => {
  const { org, waiverId } = await fixture();
  try {
    const signed = await sign(waiverId);
    assert.equal(signed.status, 200, JSON.stringify(await signed.json().catch(() => null)));
    resetCapture();
    const printed = await print(waiverId);
    assert.equal(printed.status, 200, JSON.stringify(await printed.json().catch(() => null)));
    assert.ok(!captured.html?.includes("Legacy waiver"), "a frozen print carries no legacy banner");
    assert.equal(printed.headers.get("x-lien-waiver-evidence"), null, "a frozen print carries no legacy header");
    assert.match(
      printed.headers.get("content-disposition") ?? "",
      /LW-EXEC-1\.pdf/,
      "a frozen print files under the waiver number",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
