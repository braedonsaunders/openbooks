import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The informationReturns split: the 1099 worksheet/filings, vendor TIN
// capture and box rules ride their own tax switch, not subcontractor
// compliance. These cases invoke the real routes behind the real gates: with
// informationReturns on and subcontractorCompliance off every 1099 surface
// works, and with the tax switch off each API refuses while naming it.

const state: { orgId: string; actorId: string } = { orgId: "", actorId: "" };
Object.assign(globalThis, { __infoReturnsGateState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") return virtual("export function redirect() {}");
    // The route factory's shared feature gate reads the session through its
    // own relative import; the feature switches themselves stay real.
    if (
      specifier === "@/lib/authz" ||
      (specifier === "./authz" && context.parentURL?.endsWith("/web/lib/feature-gates.ts"))
    )
      return virtual(`
      export async function guardPermission() {
        const s = globalThis.__infoReturnsGateState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
      }
      export function guardSubsidiaryScope() { return null }
    `);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");
const { GET: listFilings } = await import("./route.ts");
const { PATCH: patchVendor } = await import("../vendors/[partyId]/route.ts");
const { preflightSetupWrite } = await import("@/lib/setup/write.ts");

async function fixture(features: Record<string, boolean>) {
  const org = await withBypassContext(() => createScratchOrg());
  state.orgId = org.orgId;
  state.actorId = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb)
     where id = ${org.orgId}`),
  );
  const partyId = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${partyId},${org.orgId},'company','Gate vendor',${org.subsidiaryId},true,'{}'::jsonb)`),
  );
  await withBypassContext(() =>
    db.execute(sql`
    insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
    values (${org.orgId}, ${partyId}, true, ${state.actorId}, ${state.actorId})`),
  );
  return { org, partyId };
}

const get = () =>
  withOrgContext(state.orgId, () =>
    listFilings(new Request("http://gate.test/api/compliance/information-returns")),
  );

const patch = (partyId: string, body: unknown) =>
  withOrgContext(state.orgId, () =>
    patchVendor(
      new Request(`http://gate.test/api/compliance/vendors/${partyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ partyId }) },
    ),
  );

const actor = () => ({
  orgId: state.orgId,
  id: state.actorId,
  permissions: new Set(["*"]),
  allowedSubsidiaryIds: null,
});

/** Filing storage rows for the fixture org; a refused worksheet read adds none. */
async function filingRowCount(): Promise<number> {
  const rows = await withBypassContext(() =>
    db.execute<{ n: number }>(
      sql`select ((select count(*) from information_return_filings where org_id = ${state.orgId})
        + (select count(*) from information_return_recipients where org_id = ${state.orgId}))::int as n`,
      "objects",
    ),
  );
  return rows[0]!.n;
}

/**
 * A disabled feature answers the route factory's uniform 404 refusal: no
 * worksheet data reaches the caller and nothing is written.
 */
async function assertWorksheetRefused(): Promise<void> {
  const before = await filingRowCount();
  const res = await get();
  assert.equal(res.status, 404);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, { error: "not_found" });
  assert.equal(await filingRowCount(), before, "a refused worksheet read writes no filing rows");
}

test("worksheet lists with the tax switch on and subcontractor compliance off", async () => {
  const { org } = await fixture({ informationReturns: true });
  try {
    const res = await get();
    assert.equal(res.status, 200, JSON.stringify(await res.json()));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("with the tax switch off the worksheet answers the not-found refusal and writes nothing", async () => {
  const { org } = await fixture({});
  try {
    await assertWorksheetRefused();
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("subcontractor compliance alone leaves the worksheet behind the not-found refusal and writes nothing", async () => {
  const { org } = await fixture({ subcontractorCompliance: true });
  try {
    await assertWorksheetRefused();
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("TIN capture works with the tax switch on and subcontractor compliance off", async () => {
  const { org, partyId } = await fixture({ informationReturns: true });
  try {
    const res = await patch(partyId, { tin: "222-33-4444", tinType: "ein", reportable: true });
    assert.equal(res.status, 200, JSON.stringify(await res.json()));
    const row = (
      await withOrgContext(state.orgId, () =>
        db.execute<{ last4: string | null }>(sql`
      select tin_last4 as "last4" from vendor_roles where org_id = ${state.orgId} and party_id = ${partyId}`),
      )
    ).rows[0];
    assert.equal(row?.last4, "4444");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("TIN capture refuses with the tax switch off, naming the feature, writing nothing", async () => {
  const { org, partyId } = await fixture({});
  try {
    const res = await patch(partyId, { tin: "222-33-4444", tinType: "ein" });
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "information returns feature is disabled",
    );
    const row = (
      await withOrgContext(state.orgId, () =>
        db.execute<{ last4: string | null }>(sql`
      select tin_last4 as "last4" from vendor_roles where org_id = ${state.orgId} and party_id = ${partyId}`),
      )
    ).rows[0];
    assert.equal(row?.last4, null);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("TIN capture refuses on subcontractor compliance alone", async () => {
  const { org, partyId } = await fixture({ subcontractorCompliance: true });
  try {
    const res = await patch(partyId, { tin: "222-33-4444", tinType: "ein" });
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "information returns feature is disabled",
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("class assignment still needs subcontractor compliance, naming it", async () => {
  const { org, partyId } = await fixture({ informationReturns: true });
  try {
    const res = await patch(partyId, { complianceClassId: randomUUID() });
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "subcontractor compliance feature is disabled",
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("box rules ride the tax switch at the setup fence", async () => {
  const { org } = await fixture({ informationReturns: true });
  try {
    const allowed = await withOrgContext(state.orgId, () =>
      preflightSetupWrite(actor(), "information-return-box-rules", "create"),
    );
    assert.equal(allowed, null);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("box rules refuse on subcontractor compliance alone at the setup fence", async () => {
  const { org } = await fixture({ subcontractorCompliance: true });
  try {
    const refused = await withOrgContext(state.orgId, () =>
      preflightSetupWrite(actor(), "information-return-box-rules", "create"),
    );
    assert.equal(refused?.status, 404);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
