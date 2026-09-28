import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../composition/install.ts";
import { db, withBypass, withBypassContext, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { installTaxReturnPacks } from "../tax/seed-tax-forms.ts";
import { postEntry } from "../journal/post-entry.ts";
import { createFund, setFundPair } from "./funds.ts";
import { createFundRelease, submitFundRelease } from "./releases.ts";
import { setFunctionalMapping } from "./functional.ts";
import { setFramework } from "./frameworks.ts";
import { provisionFundAccounting } from "./provision.ts";
import { computeForm990Workpaper } from "./form990.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("Form 990 workpaper ties to nonprofit statements and names unmapped expense activity", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Workpaper Controller", "admin"));
    installEngineSeams();
    await withOrgContext(org.orgId, async () => {
      const changed = await db.execute<{ id: string }>(sql`
        update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"nonprofit":true,"fundAccounting":true,"functionalExpenses":true,"form990":true}'::jsonb, true)
         where id = ${org.orgId} returning id`);
      assert.equal(changed.rows.length, 1);
    });
    const operating = await provisionFundAccounting({ orgId: org.orgId, defaultFund: { code: "OPERATING", name: "Operating" }, classifications: { OPERATING: { kind: "operating", restrictionClass: "without_donor_restrictions" } }, actorId });
    const restricted = await createFund({ orgId: org.orgId, code: "COMMUNITY", name: "Community", kind: "restricted", restrictionClass: "with_donor_restrictions", actorId });
    await setFramework({ orgId: org.orgId, framework: "us_asc958", actorId, reason: "Prepare annual nonprofit statements" });
    await setFundPair({ orgId: org.orgId, fromFundId: operating.defaultFundId, toFundId: restricted.id, dueFromAccountId: org.accounts.ar, dueToAccountId: org.accounts.ap, actorId, reason: "Support interfund settlement in Form 990 workpaper fixtures" });
    await withOrgTransaction(org.orgId, () => postEntry(db, { orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId, entryNumber: `GIFT-${randomUUID()}`, postingDate: org.date, periodId: org.periodId, currency: "CAD", actorId, origin: "gift", memo: "Restricted community gift", lines: [{ accountId: org.accounts.bank, amount: "100.0000", extraDims: { fund: restricted.id } }, { accountId: org.accounts.revenue, amount: "-100.0000", extraDims: { fund: restricted.id } }] }));
    const release = await createFundRelease({ orgId: org.orgId, fromFundId: restricted.id, toFundId: operating.defaultFundId, releaseAccountId: org.accounts.revenue, releaseDate: org.date, amount: "20.0000", purpose: "Satisfy the donor restriction", satisfactionRef: "Program work completed", actorId });
    await submitFundRelease({ orgId: org.orgId, releaseId: release.id, actorId });
    const departmentId = randomUUID();
    await withOrgContext(org.orgId, async () => db.execute(sql`
      insert into departments (id, org_id, name, is_active, custom) values (${departmentId}, ${org.orgId}, 'Programs', true, '{}'::jsonb)`));
    await setFunctionalMapping({ orgId: org.orgId, departmentId, functionKey: "program", effectiveFrom: org.date, actorId, reason: "Classify program expense" });
    await withOrgTransaction(org.orgId, () => postEntry(db, { orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId, entryNumber: `COST-${randomUUID()}`, postingDate: org.date, periodId: org.periodId, currency: "CAD", actorId, origin: "journal", memo: "Program cost", lines: [{ accountId: org.accounts.cogs, amount: "30.0000", departmentId }, { accountId: org.accounts.bank, amount: "-30.0000" }] }));
    await withBypassContext(() => installTaxReturnPacks(org.orgId, ["US_990"], actorId));
    const disabled = await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`update orgs set settings=jsonb_set(settings,'{features,form990}','false'::jsonb,true) where id=${org.orgId} returning id`));
    assert.equal(disabled.rows.length, 1);
    await assert.rejects(computeForm990Workpaper(org.orgId, org.date, org.date), (error: unknown) =>
      error instanceof Error && (error as Error & { code?: string }).code === "feature_off" && error.message.includes("form990"));
    const restored = await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`update orgs set settings=jsonb_set(settings,'{features,form990}','true'::jsonb,true) where id=${org.orgId} returning id`));
    assert.equal(restored.rows.length, 1);
    const workpaper = await computeForm990Workpaper(org.orgId, org.date, org.date);
    const value = (code: string) => workpaper.boxes.find((box) => box.lineCode === code)!.value;
    assert.equal(value("VIII12A"), "100.0000");
    assert.equal(value("IX25B"), "30.0000");
    assert.equal(value("IX25A"), "30.0000");
    assert.equal(value("X16B"), value("X33B"));
    assert.ok(workpaper.tieOuts.every((row) => row.tied));
    await withOrgTransaction(org.orgId, () => postEntry(db, { orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId, entryNumber: `UNCATEGORIZED-${randomUUID()}`, postingDate: org.date, periodId: org.periodId, currency: "CAD", actorId, origin: "journal", memo: "Unmapped expense", lines: [{ accountId: org.accounts.cogs, amount: "1.0000" }, { accountId: org.accounts.bank, amount: "-1.0000" }] }));
    await assert.rejects(computeForm990Workpaper(org.orgId, org.date, org.date), (error: unknown) => error instanceof Error && error.message.includes("IX25A") && error.message.includes("Cost of Goods Sold"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
