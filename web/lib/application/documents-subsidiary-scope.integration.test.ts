import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// Regression coverage (X4): correct_document gated the SOURCE document's
// subsidiary but never the correction body's `subsidiaryId`, so a restricted
// actor could re-home the replacement draft into an entity outside its scope.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { postDocument } = await import("@openbooks/engine/src/posting.ts");
const { documentRevisionSql } = await import("@openbooks/engine/src/document-revision.ts");
const { correctPostedDocument } = await import("./documents.ts");
const { ApplicationError } = await import("./errors.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

async function postedBill(org: Awaited<ReturnType<typeof createScratchOrg>>, actor: string, subsidiaryId: string, number: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,posting_date,currency,fx_rate,subtotal,tax_total,total,created_by)
    values (${id},${org.orgId},'vendor_bill','draft',${number},${subsidiaryId},${org.vendorId},${org.date},${org.date},'CAD','1','100','0','100',${actor})`);
  await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount,created_by)
    values (${org.orgId},${id},1,${org.accounts.cogs},'1','100','100','0','0',${actor})`);
  await db.execute(sql`update documents set status='approved' where id=${id} and org_id=${org.orgId}`);
  await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  return id;
}

async function revisionOf(orgId: string, id: string): Promise<string> {
  const r = (await db.execute<{ revision: string }>(sql`
    select ${documentRevisionSql(sql.raw("updated_at"))} as revision from documents where id = ${id} and org_id = ${orgId}`));
  return r.rows[0]!.revision;
}

async function documentCounts(orgId: string): Promise<{ bills: number; statuses: string[] }> {
  const r = (await db.execute<{ status: string; subsidiary_id: string }>(sql`
    select status::text, subsidiary_id::text from documents where org_id = ${orgId} and kind = 'vendor_bill' order by created_at`));
  return { bills: r.rows.length, statuses: r.rows.map((row) => `${row.status}:${row.subsidiary_id}`) };
}

test("a restricted actor cannot re-home a correction into an out-of-scope subsidiary", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Restricted corrector", "restricted_corrector");
    const hidden = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`);
    // The scratch fixture opens only 2026-07; the correction's void dates its
    // reversal on the business day, so open the current month as well.
    const today = new Date();
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    if (monthStart !== "2026-07-01") {
      await db.execute(sql`insert into accounting_periods(org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
        select ${org.orgId},${today.getUTCFullYear()},${today.getUTCMonth() + 1},${monthStart.slice(0, 7)},${monthStart},${monthEnd},false,fiscal_calendar_id
          from accounting_periods where id=${org.periodId} and org_id=${org.orgId}`);
    }
    const sourceId = await postedBill(org, actor, org.subsidiaryId, "SRC-BILL");
    const context = (allowed: Set<string> | null): ApplicationContext => ({
      authz: {
        user: { id: actor, orgId: org.orgId, name: "Restricted corrector", email: "c@scratch.test", roles: [], isSuperAdmin: false, envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor },
        permissions: new Set(["ap.create", "ap.post"]),
        allowedSubsidiaryIds: allowed,
      },
      source: "api",
      requestId: randomUUID(),
      apiKeyId: null,
    });

    await withOrgContext(org.orgId, async () => {
      const before = await documentCounts(org.orgId);
      const revision = await revisionOf(org.orgId, sourceId);
      for (const target of [hidden, null] as const) {
        let error: unknown;
        try {
          await correctPostedDocument(context(new Set([org.subsidiaryId])), {
            documentId: sourceId,
            correction: { amendmentReason: "re-home into another entity", expectedUpdatedAt: revision, subsidiaryId: target },
            idempotencyKey: `rehome-${target ?? "null"}-${randomUUID()}`,
          });
        } catch (caught) {
          error = caught;
        }
        assert.ok(error instanceof ApplicationError, `re-homing to ${target} must be refused`);
        assert.equal(error.code, "forbidden");
        assert.deepEqual(error.details, { permission: "subsidiary.restricted" });
      }
      // Nothing was created or voided by the refused attempts.
      assert.deepEqual(await documentCounts(org.orgId), before);
      assert.equal((await db.execute(sql`select 1 from documents where id = ${sourceId} and status = 'posted' and void_requested_at is null`)).rows.length, 1);

      // In-scope re-home (and an omitted id) still proceeds through the same path.
      const inScope = await correctPostedDocument(context(new Set([org.subsidiaryId])), {
        documentId: sourceId,
        correction: { amendmentReason: "correct the source evidence", expectedUpdatedAt: revision, subsidiaryId: org.subsidiaryId },
        idempotencyKey: `inscope-${randomUUID()}`,
      });
      assert.equal(inScope.replayed, false);
      const after = await documentCounts(org.orgId);
      assert.equal(after.bills, before.bills + 1);
      assert.ok(after.statuses.some((s) => s === `draft:${org.subsidiaryId}`), JSON.stringify(after));
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
