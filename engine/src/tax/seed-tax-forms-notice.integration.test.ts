import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { installTaxReturnPacks } from "./seed-tax-forms.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function formNoticeKey(orgId: string, code: string): Promise<string | null | undefined> {
  const rows = (await db.execute<{ notice_key: string | null }>(sql`
    select notice_key from tax_return_forms where org_id = ${orgId} and code = ${code}`)).rows;
  return rows[0]?.notice_key;
}

// F-w4-001: the pack declares the filing notice, provisioning carries it onto
// the tenant-owned form row, and the generic UI renders whatever the row
// declares. A pack that declares nothing must provision NULL — never a
// fallback notice from another jurisdiction.
test("pack provisioning carries the declared filing notice onto the form row", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(() => installTaxReturnPacks(org.orgId, ["CA_GST34", "DE_USTVA"]));
    assert.equal(
      await withBypassContext(() => formNoticeKey(org.orgId, "CA_GST34")),
      "submission.gst34Notice",
    );
    assert.equal(await withBypassContext(() => formNoticeKey(org.orgId, "DE_USTVA")), null);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

// Reset-to-library-defaults must refresh the notice like every other
// pack-owned column: the ON CONFLICT UPDATE branch has to name notice_key,
// not just the INSERT branch.
test("reinstalling a pack refreshes a stale notice key", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(() => installTaxReturnPacks(org.orgId, ["CA_GST34"]));
    await withBypassContext(() => db.execute(sql`
      update tax_return_forms set notice_key = 'stale'
       where org_id = ${org.orgId} and code = 'CA_GST34'`));
    await withBypassContext(() => installTaxReturnPacks(org.orgId, ["CA_GST34"]));
    assert.equal(
      await withBypassContext(() => formNoticeKey(org.orgId, "CA_GST34")),
      "submission.gst34Notice",
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
