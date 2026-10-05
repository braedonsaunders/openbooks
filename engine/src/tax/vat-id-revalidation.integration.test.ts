import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { runTaxIdRevalidationScanForOrg } from "./vat-id-validation.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

// The scheduled revalidation re-checks due IDs through the real rows: a
// confirmed number stays valid with a new horizon, an authority outage keeps
// the row unverified for the operator instead of flipping or dropping it.

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function seedDueId(org: Org, actorId: string, value: string): Promise<string> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', '{"crossBorderTax": true}'::jsonb)
     where id = ${org.orgId}`);
  const id = randomUUID();
  await db.execute(sql`
    insert into party_tax_ids (id, org_id, party_id, scheme, value, status, checked_at, revalidate_after, is_active, created_by, updated_by)
    values (${id}, ${org.orgId}, ${org.customerId}, 'vies', ${value}, 'valid', '2026-01-01', '2026-10-01', true, ${actorId}, ${actorId})`);
  return id;
}

async function readRow(org: Org, id: string): Promise<{ status: string; revalidateAfter: string | null }> {
  const rows = (
    await db.execute<{ status: string; revalidateAfter: string | null }>(sql`
      select status, revalidate_after::text as "revalidateAfter" from party_tax_ids
       where org_id = ${org.orgId} and id = ${id}`)
  ).rows;
  return { status: rows[0]!.status, revalidateAfter: rows[0]!.revalidateAfter };
}

test("due IDs revalidate and outages mark unverified without flipping", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Tax Controller", "admin");
    const goodId = await seedDueId(org, actorId, "DE123456789");
    const outageId = await seedDueId(org, actorId, "FR123456789");
    const mixed = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as { countryCode?: string }) : {};
      if (body.countryCode === "DE") {
        return new Response(
          JSON.stringify({ countryCode: "DE", vatNumber: "123456789", valid: true, consultationNumber: "W9" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("service down", { status: 503 });
    }) as typeof fetch;

    const result = await runTaxIdRevalidationScanForOrg(org.orgId, {
      transport: mixed,
      today: "2026-10-05",
    });
    assert.equal(result.scanned, 2);
    assert.equal(result.revalidated, 1);
    assert.equal(result.markedUnverified, 1);
    assert.equal(result.failed, 0);

    const good = await readRow(org, goodId);
    assert.equal(good.status, "valid");
    assert.equal(good.revalidateAfter, "2027-01-03");
    const outage = await readRow(org, outageId);
    assert.equal(outage.status, "unverified");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
