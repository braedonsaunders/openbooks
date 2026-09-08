import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";

const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-payment-route-scope")] = state;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "../../../../../lib/feature-gates" &&
        decodeURIComponent(context.parentURL ?? "").endsWith("/api/payroll/runs/[id]/route.ts")) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.payroll-payment-route-scope')].gate}",
      ) };
    }
    return next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/db.ts");
const { seedAdoption, calculatedRun } = await import("@openbooks/engine/src/payroll-filing-test-fixtures.ts");
const { dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
const { commitPayRun } = await import("@openbooks/engine/src/payroll-run.ts");
const { recordPayRunPayment } = await import("@openbooks/engine/src/payroll-payment.ts");
const { POST } = await import("../app/api/payroll/runs/[id]/route");

test("payroll payment API carries the caller's scope to historical liability authorization", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const fx = await seedAdoption();
  try {
    const branchId = randomUUID(), dueFrom = randomUUID(), dueTo = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values(${branchId},${fx.orgId},${fx.subsidiaryId},'Original employer','CAD','CA')`);
    await db.execute(sql`insert into accounts(id,org_id,number,name,type,is_summary,is_active,eliminate,required_dimensions,custom)
      values(${dueFrom},${fx.orgId},'1410','Due from employer','asset_current_other',false,true,true,'[]'::jsonb,'{}'::jsonb),
            (${dueTo},${fx.orgId},'2410','Due to payer','liability_current_other',false,true,true,'[]'::jsonb,'{}'::jsonb)`);
    await db.execute(sql`insert into intercompany_pairs
      (org_id,from_subsidiary_id,to_subsidiary_id,due_from_account_id,due_to_account_id,is_active,created_by,updated_by)
      values(${fx.orgId},${fx.subsidiaryId},${branchId},${dueFrom},${dueTo},true,${fx.actorId},${fx.actorId})`);
    await db.execute(sql`update parties set subsidiary_id=${branchId} where org_id=${fx.orgId} and id=${fx.employeeId}`);
    const { input } = await calculatedRun(fx);
    await commitPayRun(input);
    await db.execute(sql`update documents set status='approved' where org_id=${fx.orgId} and id=${input.documentId}`);
    const bankId = (await db.execute<{ id: string }>(sql`
      select id from accounts where org_id=${fx.orgId} and type='asset_bank' order by number limit 1`)).rows[0]!.id;
    // Historical mixed-entity journals are supported: retain the committed GL
    // projection while its liabilities belong to the branch, not the header.
    const postedEntryId = randomUUID();
    await db.execute(sql`insert into journal_entries
      (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id,created_by,updated_by)
      select ${postedEntryId},d.org_id,b.id,d.subsidiary_id,'PAY-HISTORICAL-SCOPE',r.pay_date,
             p.id,'draft','payroll',d.id,${fx.actorId},${fx.actorId}
        from documents d join accounting_books b on b.org_id=d.org_id and b.is_primary
        join pay_runs r on r.document_id=d.id and r.org_id=d.org_id
        join accounting_periods p on p.org_id=d.org_id and not p.is_adjustment and r.pay_date between p.starts_on and p.ends_on
       where d.org_id=${fx.orgId} and d.id=${input.documentId}`);
    await db.execute(sql`insert into journal_lines
      (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,party_id,is_open_item,memo)
      select org_id,${postedEntryId},line_number,account_id,${branchId},amount,'CAD',amount,1,
             party_id,party_id is not null,description
        from document_lines where org_id=${fx.orgId} and document_id=${input.documentId}`);
    await db.execute(sql`update journal_entries set status='posted',posted_at=now(),posted_by=${fx.actorId}
      where org_id=${fx.orgId} and id=${postedEntryId}`);
    await db.execute(sql`update documents d set status='posted',posted_entry_id=${postedEntryId},
        posting_date=e.posting_date,posting_period_id=e.period_id
      from journal_entries e where e.id=${postedEntryId} and e.org_id=d.org_id
        and d.org_id=${fx.orgId} and d.id=${input.documentId}`);
    const scope = new Set([fx.subsidiaryId]);
    await assert.rejects(recordPayRunPayment({ ...input, bankAccountId: bankId, allowedSubsidiaryIds: scope }), /pay run not found/);
    state.gate = { user: { orgId: fx.orgId, id: fx.actorId }, permissions: new Set(["payroll.run"]), allowedSubsidiaryIds: scope } as Authz;
    const request = () => new Request("https://openbooks.test/api/payroll/runs/fixture", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "record-payment", bankAccountId: bankId }),
    });
    const response = await POST(request(), { params: Promise.resolve({ id: input.documentId }) });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "pay run not found" });
    const run = (await db.execute<{ paid_at: string | null }>(sql`
      select paid_at from pay_runs where org_id=${fx.orgId} and document_id=${input.documentId}`)).rows[0]!;
    assert.equal(run.paid_at, null);
    state.gate = { ...state.gate, allowedSubsidiaryIds: null };
    const allowed = await POST(request(), { params: Promise.resolve({ id: input.documentId }) });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).ok, true);
  } finally {
    state.gate = null;
    await dropScratchOrgReporting(fx.orgId);
  }
});
