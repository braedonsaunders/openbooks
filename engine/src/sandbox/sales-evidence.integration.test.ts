import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction, withOrgTransaction } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { ensureCrmDefaults } from "../crm/crm.ts";
import { postDocument } from "../ledger/posting-document.ts";
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
      assert.equal(actual.length, 5, "copying source records must not mint additional sales events");
      assert.deepEqual(actual, expected, "amounts, effective dates, revisions, creators, timestamps and reversal links preserve recorded history");
      assert.deepEqual(await sourceEvidence(), original);
      assert.equal((await db.execute<{ status: string }>(sql`select status from sandboxes where id=${created.sandboxId}`)).rows[0]!.status, "ready");
    };
    await assertCopy();
    const beforeTarget = (await db.execute(sql`select * from crm_sales_evidence where org_id=${target} order by id`)).rows;
    // Native authority alone cannot substitute an amount on a copied source.
    await assert.rejects(withMaintenanceTransaction(null, async () => {
      await cloneFlags();
      assert.equal((await db.execute(sql`delete from crm_opportunities where org_id=${target} and id=${identities.opportunity} returning id`)).rows.length, 1);
      await db.execute(sql`insert into crm_opportunities(id,org_id,opportunity_number,title,status_id,subsidiary_id,currency,projected_amount,closed_at)
        values(${identities.opportunity},${target},${opportunity},'Altered copy',${identities.won},${identities.subsidiary},'CAD','99.0000',${org.date}::date)`);
    }), error => errorChainMatches(error, /Sandbox sales sources must retain.*amount and dates.*refresh from the recorded source/));
    await assertCopy();
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
