import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { Client } from "pg";

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
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { documentRevisionCounterSql } = await import("@openbooks/engine/src/records/revision.ts");
const { correctPostedDocument, postJournalDocument } = await import("./documents.ts");
const { ApplicationError } = await import("./errors.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

async function postedBill(org: Awaited<ReturnType<typeof createScratchOrg>>, actor: string, subsidiaryId: string, number: string): Promise<string> {
  const id = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,posting_date,currency,fx_rate,subtotal,tax_total,total,created_by)
      values (${id},${org.orgId},'vendor_bill','draft',${number},${subsidiaryId},${org.vendorId},${org.date},${org.date},'CAD','1','100','0','100',${actor})`);
    await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount,created_by)
      values (${org.orgId},${id},1,${org.accounts.cogs},'1','100','100','0','0',${actor})`);
    await db.execute(sql`update documents set status='approved' where id=${id} and org_id=${org.orgId}`);
    await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  });
  return id;
}

async function revisionOf(orgId: string, id: string): Promise<string> {
  const r = (await withOrgContext(orgId, () => db.execute<{ revision: string }>(sql`
    select ${documentRevisionCounterSql(sql.raw("revision_seq"))} as revision from documents where id = ${id} and org_id = ${orgId}`)));
  return r.rows[0]!.revision;
}

async function documentCounts(orgId: string): Promise<{ bills: number; statuses: string[] }> {
  const r = (await withOrgContext(orgId, () => db.execute<{ status: string; subsidiary_id: string }>(sql`
    select status::text, subsidiary_id::text from documents where org_id = ${orgId} and kind = 'vendor_bill' order by created_at`)));
  return { bills: r.rows.length, statuses: r.rows.map((row) => `${row.status}:${row.subsidiary_id}`) };
}

test("a restricted actor cannot re-home a correction into an out-of-scope subsidiary", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Restricted corrector", "restricted_corrector"));
    const hidden = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden','CAD','CA')`));
    // The scratch fixture opens only 2026-07; the correction's void dates its
    // reversal on the business day, so open the current month as well.
    const today = new Date();
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    if (monthStart !== "2026-07-01") {
      await withBypassContext(() => db.execute(sql`insert into accounting_periods(org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
        select ${org.orgId},${today.getUTCFullYear()},${today.getUTCMonth() + 1},${monthStart.slice(0, 7)},${monthStart},${monthEnd},false,fiscal_calendar_id
          from accounting_periods where id=${org.periodId} and org_id=${org.orgId}`));
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

test("journal posting rechecks subsidiary scope after waiting for the document row", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() => createScratchUser(org.orgId, "Restricted journal poster", "restricted_journal_poster"));
  const journalId = randomUUID();
  const subsidiaryB = randomUUID();
  const holder = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
  let holderOpen = false;
  try {
    await withBypassContext(async () => {
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values (${subsidiaryB},${org.orgId},${org.subsidiaryId},'Rehomed journal entity','CAD','CA')`);
      await db.execute(sql`insert into documents
        (id,org_id,kind,status,document_number,subsidiary_id,document_date,currency,subtotal,tax_total,total,created_by)
        values (${journalId},${org.orgId},'journal','draft','SCOPE-JE',${org.subsidiaryId},${org.date},'CAD','10','0','10',${actor})`);
      await db.execute(sql`insert into document_lines
        (org_id,document_id,line_number,account_id,subsidiary_id,amount,quantity,unit_price,tax_amount,tax_input_amount)
        values
          (${org.orgId},${journalId},1,${org.accounts.bank},${org.subsidiaryId},'10','1','10','0','10'),
          (${org.orgId},${journalId},2,${org.accounts.cogs},${org.subsidiaryId},'-10','1','-10','0','-10')`);
      await db.execute(sql`update documents set status='approved' where id=${journalId} and org_id=${org.orgId}`);
    });
    const context = {
      authz: {
        user: { id: actor, orgId: org.orgId, name: "Restricted journal poster", email: "j@scratch.test", roles: [], isSuperAdmin: false, envKind: "production" as const, productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor },
        permissions: new Set(["gl.post"]),
        allowedSubsidiaryIds: new Set([org.subsidiaryId]),
      },
      source: "api" as const,
      requestId: randomUUID(),
      apiKeyId: null,
    };

    await holder.connect();
    holderOpen = true;
    await holder.query("begin");
    await holder.query("select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)", [org.orgId]);
    await holder.query("select id from documents where id = $1 and org_id = $2 for update", [journalId, org.orgId]);
    const postingOutcome = withOrgContext(org.orgId, () => postJournalDocument(context, {
      documentId: journalId,
      idempotencyKey: `rehome-journal-${randomUUID()}`,
    })).then((value) => ({ value }), (error: unknown) => ({ error }));
    const deadline = Date.now() + 15_000;
    let waiting = false;
    while (Date.now() < deadline) {
      const activity = await withOrgContext(org.orgId, () => db.execute<{ waiting: boolean }>(sql`
        select exists (
          select 1 from pg_stat_activity where datname = current_database()
            and pid <> pg_backend_pid() and wait_event_type = 'Lock'
            and query ilike '%from documents%' and query ilike '%for update%'
        ) as waiting`));
      if (activity.rows[0]?.waiting) { waiting = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(waiting, true, "application posting reached the locked document reread");
    await holder.query("update documents set subsidiary_id = $1 where id = $2 and org_id = $3", [subsidiaryB, journalId, org.orgId]);
    await holder.query("commit");
    await holder.end();
    holderOpen = false;

    const postingResult = await postingOutcome;
    const error = "error" in postingResult ? postingResult.error : undefined;
    assert.ok(error instanceof ApplicationError);
    assert.equal(error.code, "forbidden");
    assert.deepEqual(error.details, { permission: "subsidiary.restricted" });
    const state = await withOrgContext(org.orgId, () => db.execute<{ status: string; posted_entry_id: string | null }>(sql`
      select status, posted_entry_id from documents where id = ${journalId} and org_id = ${org.orgId}`));
    assert.equal(state.rows[0]?.status, "approved");
    assert.equal(state.rows[0]?.posted_entry_id, null);
    assert.equal((await withOrgContext(org.orgId, () => db.execute(sql`
      select 1 from journal_entries where org_id = ${org.orgId} and source_document_id = ${journalId}`))).rows.length, 0);
  } finally {
    if (holderOpen) {
      await holder.query("rollback").catch(() => {});
      await holder.end().catch(() => {});
    }
    await dropScratchOrg(org.orgId);
  }
});
