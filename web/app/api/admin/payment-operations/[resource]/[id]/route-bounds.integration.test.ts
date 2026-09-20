import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Mandate PATCH casts signedOn/validFrom/expiresOn to date with no
 * validation at all — so a September 31 sails through every named check
 * and dies in Postgres, surfacing the raw driver failure as the 422 body
 * instead of failing closed with a named error and nothing written.
 * signed_on/valid_from/expires_on are date.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __mandatePatchBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__mandatePatchBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
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
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture(): Promise<{ orgId: string; mandateId: string; date: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  const bankAccountId = randomUUID();
  const mandateId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into party_bank_accounts
      (id, org_id, party_id, bank_name, country, currency, routing,
       account_last_four, approved_at, approved_by, created_by, updated_by)
    values
      (${bankAccountId}, ${org.orgId}, ${org.customerId}, 'Customer bank',
       'CA', 'CAD', '{}'::jsonb, '1234', ${org.date}, ${actorId}, ${actorId}, ${actorId})`));
  await withBypassContext(() => db.execute(sql`
    insert into payment_mandates
      (id, org_id, party_id, party_bank_account_id, scheme, mandate_reference,
       status, signed_on, valid_from, created_by, updated_by)
    values
      (${mandateId}, ${org.orgId}, ${org.customerId}, ${bankAccountId},
       'nacha', 'MANDATE-BOUNDS', 'active', ${org.date}, ${org.date},
       ${actorId}, ${actorId})`));
  return { orgId: org.orgId, mandateId, date: org.date };
}

const patch = (mandateId: string, body: unknown) =>
  withOrgContext(state.orgId, () =>
    PATCH(
      new Request(`http://mandate.test/api/admin/payment-operations/mandates/${mandateId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ resource: "mandates", id: mandateId }) },
    ),
  );

async function signedOn(orgId: string, mandateId: string): Promise<string | null> {
  const rows = (await withBypassContext(() =>
    db.execute<{ signed_on: string | null }>(
      sql`select signed_on::text as signed_on from payment_mandates where org_id = ${orgId} and id = ${mandateId}`,
    ))).rows;
  return rows[0]?.signed_on ?? null;
}

test("mandate update refuses a non-calendar signed date without writing", { skip: !DB }, async () => {
  const { orgId, mandateId, date } = await fixture();
  try {
    const response = await patch(mandateId, { signedOn: "2026-09-31" });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /invalid input syntax|Failed query/i);
    assert.equal(await signedOn(orgId, mandateId), date);
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("mandate update still saves an ordinary signed date", { skip: !DB }, async () => {
  const { orgId, mandateId } = await fixture();
  try {
    const response = await patch(mandateId, { signedOn: "2026-02-15" });
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await signedOn(orgId, mandateId), "2026-02-15");
  } finally {
    await dropScratchOrg(orgId);
  }
});
