import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction, withOrgTransaction } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { ensureCrmDefaults } from "../crm/crm.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createPaymentDocument, updateDraftPayment } from "../payments/payment-documents.ts";
import { postPaymentWithApplications } from "../payments/payment-posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { enableFeatures } from "../testing/hrm-harness.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";

installEngineSeams();
const DB = !!process.env.OPENBOOKS_DB_URL;

async function cloneFlags() {
  await db.execute(sql`select set_config('openbooks.clone','on',true),
    set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`);
}

for (const masked of [false, true]) test(`${masked ? "masked" : "full"} sandbox preserves exact sales credits and reversals without recapturing sources`, { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const name = `Recorded sales ${randomUUID()}`;
  let failed = false;
  let failure: unknown;
  try {
    const actor = await createScratchUser(org.orgId, "Sandbox sales owner", "admin");
    await enableFeatures(org.orgId, ["crm"]);
    await ensureCrmDefaults(org.orgId, actor);
    const statuses = (await db.execute<{ id: string; is_won: boolean }>(sql`select id,is_won
      from crm_opportunity_statuses where org_id=${org.orgId} and key in ('qualification','closed_won')`)).rows;
    const won = statuses.find(row => row.is_won)!.id;
    const open = statuses.find(row => !row.is_won)!.id;
    assert.equal((await db.execute(sql`insert into customer_roles(org_id,party_id,created_by,updated_by)
      values(${org.orgId},${org.customerId},${actor},${actor}) returning party_id`)).rows.length, 1);
    const invoice = randomUUID(), opportunity = randomUUID(), reopened = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,
      document_date,due_date,currency,fx_rate,subtotal,tax_total,total,created_by)
      values(${invoice},${org.orgId},'customer_invoice','draft','RECORDED-INVOICE',${org.subsidiaryId},${org.customerId},
        ${org.date},${org.date},'CAD','1','100.1200','0','100.1200',${actor})`);
    await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount)
      values(${org.orgId},${invoice},1,${org.accounts.revenue},'1','100.1200','100.1200','0','0')`);
    await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${invoice}`);
    await postDocument(invoice, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    assert.equal((await db.execute<{ status: string }>(sql`select status from documents where org_id=${org.orgId} and id=${invoice}`)).rows[0]!.status, "posted");
    const openLine = (await db.execute<{ id: string }>(sql`select id from journal_lines
      where org_id=${org.orgId} and entry_id=(select posted_entry_id from documents where id=${invoice})
        and is_open_item`)).rows[0]!.id;
    const payment = await createPaymentDocument({ allowedSubsidiaryIds: null, orgId: org.orgId,
      kind: "customer_payment", createdBy: actor, partyId: org.customerId, bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId, documentDate: org.date, currency: "CAD", fxRate: "1" });
    await updateDraftPayment(payment.id, { bankAccountId: org.accounts.bank, allocations: [{ openLineId: openLine,
      sourceTransactionAmount: "40", targetTransactionAmount: "40", settlementRate: "1",
      settlementRateSource: "same_currency", settlementRateReference: "Recorded partial settlement" }] },
      actor, org.orgId, { allowedSubsidiaryIds: null });
    assert.equal((await db.execute(sql`update documents set status='approved',submitted_by=${actor},submitted_at=now()
      where org_id=${org.orgId} and id=${payment.id} returning id`)).rows.length, 1);
    await postPaymentWithApplications(payment.id, undefined, actor);
    const originalSettlement = (await db.execute<{ facts: unknown }>(sql`select to_jsonb(a) as facts
      from applications a where org_id=${org.orgId} order by id`)).rows;
    assert.equal(originalSettlement.length, 1);
    assert.equal((await db.execute<{ balance: string }>(sql`select open_balance::text as balance
      from documents where org_id=${org.orgId} and id=${invoice}`)).rows[0]!.balance, "60.1200");
    // Today's customer assignment must not reinterpret a posted invoice
    // whose original sales attribution was unassigned.
    const representative = randomUUID();
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id)
      values(${representative},${org.orgId},'employee','Current sales representative',${org.subsidiaryId})`);
    await db.execute(sql`insert into employee_roles(org_id,party_id,is_sales_rep,sales_rep_since)
      values(${org.orgId},${representative},true,'2020-01-01')`);
    assert.equal((await db.execute(sql`update customer_roles set sales_rep_id=${representative}
      where org_id=${org.orgId} and party_id=${org.customerId} returning party_id`)).rows.length, 1);
    const documentFacts = (await db.execute<{ facts: unknown }>(sql`select jsonb_build_object(
      'kind',kind,'document_number',document_number,'revision_seq',revision_seq,'status',status,
      'subtotal',subtotal,'currency',currency,'document_date',document_date,'posting_date',posting_date,
      'updated_at',updated_at,'updated_by',updated_by,'open_balance',open_balance,
      'sales_rep_id',sales_rep_id,'sales_team_id',sales_team_id) as facts
      from documents where org_id=${org.orgId} and id=${invoice}`)).rows;
    assert.equal((documentFacts[0]!.facts as { sales_rep_id: unknown }).sales_rep_id, null);
    assert.equal((await db.execute<{ matches: boolean }>(sql`select sales_document_clone_matches(d) as matches
      from documents d where org_id=${org.orgId} and id=${invoice}`)).rows[0]!.matches, false,
      "ordinary production records never acquire native clone authority");
    for (const id of [opportunity, reopened]) {
      await db.execute(sql`insert into crm_opportunities(id,org_id,opportunity_number,title,status_id,
        subsidiary_id,currency,projected_amount,closed_at,updated_by)
        values(${id},${org.orgId},${id},'Recorded sale',${won},${org.subsidiaryId},'CAD','10.1234',${org.date}::date,${actor})`);
    }
    await db.execute(sql`update crm_opportunities set status_id=${open},win_loss_reason='Customer deferred purchase',
      closed_at=null,updated_at=clock_timestamp(),updated_by=${actor} where org_id=${org.orgId} and id=${reopened}`);
    // Privileged clone flags do not suppress ordinary production capture.
    await withMaintenanceTransaction(null, async () => {
      await cloneFlags();
      await db.execute(sql`insert into crm_opportunities(org_id,opportunity_number,title,status_id,subsidiary_id,currency,projected_amount,closed_at)
        values(${org.orgId},'ORDINARY-PRODUCTION','New production sale',${won},${org.subsidiaryId},'CAD','7.1250',${org.date}::date)`);
    });
    const sourceEvidence = async () => (await db.execute<{ evidence: unknown }>(sql`select to_jsonb(e) as evidence
      from crm_sales_evidence e where org_id=${org.orgId} order by id`)).rows;
    const original = await sourceEvidence();
    assert.equal(original.length, 5);
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from crm_sales_evidence
      where org_id=${org.orgId} and event_kind='reversal' and source_id=${reopened}`)).rows[0]!.count, 1);
    const created = await createSandbox({ productionOrgId: org.orgId, name, tier: masked ? "masked" : "full", masked,
      createdBy: actor, lifecycleAuthority: { actorId: actor } });
    const target = created.sandboxOrgId;
    const identities = (await db.execute<{ won: string; open: string; opportunity: string; subsidiary: string }>(sql`select
      ob_rebase(${won}::uuid,sandbox_seed) as won,ob_rebase(${open}::uuid,sandbox_seed) as open,
      ob_rebase(${opportunity}::uuid,sandbox_seed) as opportunity,ob_rebase(${org.subsidiaryId}::uuid,sandbox_seed) as subsidiary
      from orgs where id=${target}`)).rows[0]!;
    const assertCopy = async () => {
      const actual = (await db.execute<{ evidence: unknown }>(sql`select to_jsonb(e) as evidence from crm_sales_evidence e
        where org_id=${target} order by id`)).rows;
      const expected = (await db.execute<{ evidence: unknown }>(sql`select to_jsonb(e)||jsonb_build_object(
        'id',ob_rebase(e.id,o.sandbox_seed),'org_id',o.id,'source_id',ob_rebase(e.source_id,o.sandbox_seed),
        'employee_id',ob_rebase(e.employee_id,o.sandbox_seed),'sales_team_id',ob_rebase(e.sales_team_id,o.sandbox_seed),
        'subsidiary_id',ob_rebase(e.subsidiary_id,o.sandbox_seed),'reverses_id',ob_rebase(e.reverses_id,o.sandbox_seed),
        'source_number',case when ${masked} then md5(e.source_number) else e.source_number end) as evidence
        from crm_sales_evidence e join orgs o on o.sandbox_of=e.org_id
        where o.id=${target} order by ob_rebase(e.id,o.sandbox_seed)`)).rows;
      const copiedDocument = (await db.execute<{ facts: unknown }>(sql`select jsonb_build_object(
        'kind',d.kind,'document_number',d.document_number,'revision_seq',d.revision_seq,'status',d.status,
        'subtotal',d.subtotal,'currency',d.currency,'document_date',d.document_date,'posting_date',d.posting_date,
        'updated_at',d.updated_at,'updated_by',d.updated_by,'open_balance',d.open_balance,
        'sales_rep_id',d.sales_rep_id,'sales_team_id',d.sales_team_id) as facts
        from documents d join orgs o on o.id=d.org_id
        where d.org_id=${target} and d.id=ob_rebase(${invoice}::uuid,o.sandbox_seed)`)).rows;
      assert.deepEqual(copiedDocument, documentFacts,
        "copy and refresh preserve unassigned attribution, balance, revision and exact recorded timestamps");
      assert.deepEqual((await db.execute<{ facts: unknown }>(sql`select jsonb_build_object(
        'kind',kind,'document_number',document_number,'revision_seq',revision_seq,'status',status,
        'subtotal',subtotal,'currency',currency,'document_date',document_date,'posting_date',posting_date,
        'updated_at',updated_at,'updated_by',updated_by,'open_balance',open_balance,
        'sales_rep_id',sales_rep_id,'sales_team_id',sales_team_id) as facts
        from documents where org_id=${org.orgId} and id=${invoice}`)).rows, documentFacts);
      assert.equal(actual.length, 5, "copying source records must not mint additional sales events");
      assert.deepEqual(actual, expected, "amounts, effective dates, revisions, creators, timestamps and reversal links preserve recorded history");
      const copiedSettlement = (await db.execute<{ facts: unknown }>(sql`select to_jsonb(a) as facts
        from applications a where org_id=${target} order by id`)).rows;
      const expectedSettlement = (await db.execute<{ facts: unknown }>(sql`select to_jsonb(a)||jsonb_build_object(
        'id',ob_rebase(a.id,o.sandbox_seed),'org_id',o.id,
        'from_line_id',ob_rebase(a.from_line_id,o.sandbox_seed),'to_line_id',ob_rebase(a.to_line_id,o.sandbox_seed),
        'fx_gain_loss_entry_id',ob_rebase(a.fx_gain_loss_entry_id,o.sandbox_seed),
        'settlement_fx_rate_id',ob_rebase(a.settlement_fx_rate_id,o.sandbox_seed)) as facts
        from applications a join orgs o on o.sandbox_of=a.org_id where o.id=${target}
        order by ob_rebase(a.id,o.sandbox_seed)`)).rows;
      assert.deepEqual(copiedSettlement, expectedSettlement,
        "settlement amounts, currencies, dates, actors and soft-reversal state retain exact recorded evidence");
      assert.deepEqual((await db.execute<{ facts: unknown }>(sql`select to_jsonb(a) as facts
        from applications a where org_id=${org.orgId} order by id`)).rows, originalSettlement);

      assert.deepEqual(await sourceEvidence(), original);
      assert.equal((await db.execute<{ status: string }>(sql`select status from sandboxes where id=${created.sandboxId}`)).rows[0]!.status, "ready");
    };
    await assertCopy();
    await withMaintenanceTransaction(null, async () => {
      await cloneFlags();
      const matches = (await db.execute<{ original: boolean; altered_balance: boolean; altered_attribution: boolean }>(sql`
        select sales_document_clone_matches(d) as original,
          sales_document_clone_matches(jsonb_populate_record(null::documents,
            to_jsonb(d)||jsonb_build_object('open_balance',d.open_balance+1))) as altered_balance,
          sales_document_clone_matches(jsonb_populate_record(null::documents,
            to_jsonb(d)||jsonb_build_object('sales_rep_id',ob_rebase(${representative}::uuid,o.sandbox_seed)))) as altered_attribution
        from documents d join orgs o on o.id=d.org_id
        where d.org_id=${target} and d.id=ob_rebase(${invoice}::uuid,o.sandbox_seed)`)).rows[0]!;
      assert.deepEqual(matches, { original: true, altered_balance: false, altered_attribution: false },
        "privileged copying admits exact history and refuses substituted balances or current attribution");
    });
    await withMaintenanceTransaction(null, async () => {
      await cloneFlags();
      const line = (await db.execute<{ exact: boolean; changed_amount: boolean; changed_identity: boolean; foreign_org: boolean; unsupported_relation: boolean }>(sql`select
        document_balance_clone_child_matches(d,'journal_lines'::regclass,to_jsonb(l)) as exact,
        document_balance_clone_child_matches(d,'journal_lines'::regclass,to_jsonb(l)||jsonb_build_object('txn_amount',l.txn_amount+1)) as changed_amount,
        document_balance_clone_child_matches(d,'journal_lines'::regclass,to_jsonb(l)||jsonb_build_object('id',${randomUUID()}::uuid)) as changed_identity,
        document_balance_clone_child_matches(d,'journal_lines'::regclass,to_jsonb(l)||jsonb_build_object('org_id',${randomUUID()}::uuid)) as foreign_org,
        document_balance_clone_child_matches(d,'documents'::regclass,to_jsonb(l)) as unsupported_relation
        from documents d join journal_lines l on l.org_id=d.org_id and l.entry_id=d.posted_entry_id
        join orgs o on o.id=d.org_id where d.org_id=${target} and d.id=ob_rebase(${invoice}::uuid,o.sandbox_seed)
        and l.is_open_item`)).rows[0]!;
      assert.deepEqual(line, { exact: true, changed_amount: false, changed_identity: false, foreign_org: false, unsupported_relation: false });
      const settlement = (await db.execute<{ exact: boolean; changed_amount: boolean; changed_endpoint: boolean }>(sql`select
        document_balance_clone_child_matches(d,'applications'::regclass,to_jsonb(a)) as exact,
        document_balance_clone_child_matches(d,'applications'::regclass,to_jsonb(a)||jsonb_build_object('target_transaction_amount',a.target_transaction_amount+1)) as changed_amount,
        document_balance_clone_child_matches(d,'applications'::regclass,to_jsonb(a)||jsonb_build_object('to_line_id',${randomUUID()}::uuid)) as changed_endpoint
        from documents d join journal_lines l on l.org_id=d.org_id and l.entry_id=d.posted_entry_id
        join applications a on a.org_id=l.org_id and a.to_line_id=l.id join orgs o on o.id=d.org_id
        where d.org_id=${target} and d.id=ob_rebase(${invoice}::uuid,o.sandbox_seed)`)).rows[0]!;
      assert.deepEqual(settlement, { exact: true, changed_amount: false, changed_endpoint: false });
    });
    await withOrgTransaction(target, async () => {
      await cloneFlags();
      assert.equal((await db.execute<{ matches: boolean }>(sql`select document_balance_clone_child_matches(
        d,'journal_lines'::regclass,to_jsonb(l)) as matches from documents d
        join journal_lines l on l.org_id=d.org_id and l.entry_id=d.posted_entry_id
        join orgs o on o.id=d.org_id where d.org_id=${target} and d.id=ob_rebase(${invoice}::uuid,o.sandbox_seed)
        and l.is_open_item`)).rows[0]!.matches, false, "ordinary forged flags do not grant historical balance-copy authority");
    });
    const beforeTarget = (await db.execute(sql`select * from crm_sales_evidence where org_id=${target} order by id`)).rows;
    // Preserve every other recorded fact so each substitution tests its own refusal.
    for (const [number, amount] of [[opportunity, "99.0000"], ["ALTERED-SOURCE-NUMBER", "10.1234"]] as const) {
      await assert.rejects(withMaintenanceTransaction(null, async () => {
        await cloneFlags();
        assert.equal((await db.execute(sql`delete from crm_opportunities where org_id=${target} and id=${identities.opportunity} returning id`)).rows.length, 1);
        await db.execute(sql`insert into crm_opportunities select (jsonb_populate_record(null::crm_opportunities,
          to_jsonb(original)||jsonb_build_object('id',${identities.opportunity}::uuid,'org_id',${target}::uuid,
            'status_id',${identities.won}::uuid,'subsidiary_id',${identities.subsidiary}::uuid,
            'opportunity_number',${number}::text,'projected_amount',${amount}::numeric))).*
          from crm_opportunities original where original.org_id=${org.orgId} and original.id=${opportunity}`);
      }), error => errorChainMatches(error, /Sandbox sales sources must retain.*amount and dates.*refresh from the recorded source/));
      await assertCopy();
    }
    await assert.rejects(withMaintenanceTransaction(null, async () => {
      await cloneFlags();
      await db.execute(sql`insert into crm_opportunities(org_id,opportunity_number,title,status_id,subsidiary_id,currency,projected_amount,closed_at)
        values(${target},'UNBACKED-COPY','Unbacked sale',${identities.won},${identities.subsidiary},'CAD','12',${org.date}::date)`);
    }), error => errorChainMatches(error, /Sandbox sales sources must retain.*refresh from the recorded source/));
    await assertCopy();
    // Forged flags on an ordinary tenant transaction cannot suppress a new sale.
    await withOrgTransaction(target, async () => {
      await cloneFlags();
      assert.equal((await db.execute<{ allowed: boolean }>(sql`select openbooks_clone_authority() as allowed`)).rows[0]!.allowed, false);
      await db.execute(sql`insert into crm_opportunities(org_id,opportunity_number,title,status_id,subsidiary_id,currency,projected_amount,closed_at)
        values(${target},'ORDINARY-SANDBOX','New sandbox sale',${identities.won},${identities.subsidiary},'CAD','8.2500',${org.date}::date)`);
    });
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from crm_sales_evidence where org_id=${target}`)).rows[0]!.count, 6);
    // UPDATE remains the ordinary controlled reopening path, even with clone flags.
    await assert.rejects(withMaintenanceTransaction(null, async () => {
      await cloneFlags();
      await db.execute(sql`update crm_opportunities set projected_amount='99' where org_id=${target} and id=${identities.opportunity}`);
    }), error => errorChainMatches(error, /Closed-won sales evidence is immutable.*reopen the opportunity/));
    await withMaintenanceTransaction(null, async () => {
      await cloneFlags();
      await db.execute(sql`update crm_opportunities set status_id=${identities.open},win_loss_reason='Customer cancelled',
        closed_at=null,updated_at=clock_timestamp() where org_id=${target} and id=${identities.opportunity}`);
    });
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from crm_sales_evidence
      where org_id=${target} and event_kind='reversal' and source_id=${identities.opportunity}`)).rows[0]!.count, 1);
    assert.deepEqual((await db.execute(sql`select * from crm_sales_evidence where org_id=${target}
      and id in (${sql.join(beforeTarget.map(row => sql`${row.id}`), sql`,`)}) order by id`)).rows, beforeTarget);
    await withMaintenanceTransaction(null, async () => {
      await cloneFlags();
      assert.equal((await db.execute(sql`update applications set unapplied_at=clock_timestamp()
        where org_id=${target} and unapplied_at is null returning id`)).rows.length, 1);
    });
    assert.equal((await db.execute<{ balance: string }>(sql`select d.open_balance::text as balance
      from documents d join orgs o on o.id=d.org_id where d.org_id=${target}
      and d.id=ob_rebase(${invoice}::uuid,o.sandbox_seed)`)).rows[0]!.balance, "100.1200",
      "ordinary unapplication still refreshes the balance under privileged clone flags");
    await refreshSandbox(created.sandboxId, { keepCustomizations: false, authority: { actorId: actor } });
    await assertCopy();
    await deleteSandbox(created.sandboxId, { actorId: actor });
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from crm_sales_evidence where org_id=${target}`)).rows[0]!.count, 0);
    assert.deepEqual(await sourceEvidence(), original);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      const shells = (await db.execute<{ id: string }>(sql`select id from sandboxes where production_org_id=${org.orgId} and name=${name}`)).rows;
      for (const shell of shells) await deleteSandbox(shell.id, { systemReason: "Remove recorded sales clone fixture" });
      await dropScratchOrg(org.orgId);
    } catch (cleanup) {
      if (failed) throw new AggregateError([failure, cleanup], "Sales evidence assertion and cleanup both failed", { cause: failure });
      throw cleanup;
    }
  }
});
