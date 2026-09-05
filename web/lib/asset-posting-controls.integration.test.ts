import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildSchedule, runDepreciation } from '@openbooks/engine/src/depreciation.ts';
import { sql } from 'drizzle-orm';
import { db, env } from '@openbooks/engine/src/db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/test-fixtures.ts';

async function seedAsset(org: ScratchOrg) {
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const assetId = randomUUID(), categoryId = randomUUID();
  await db.execute(sql`insert into asset_categories
    (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention)
    values (${categoryId},${org.orgId},'Reversal equipment',${org.accounts.invAsset},${org.accounts.clearing},${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',10,'full_month')`);
  await db.execute(sql`insert into fixed_assets
    (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,salvage_value,depreciation_method,useful_life_months,depreciation_convention)
    values (${assetId},${org.orgId},${org.subsidiaryId},${categoryId},'REVERSE-CHAIN','Reversal asset','in_service',${org.date},${org.date},1000,0,'straight_line',10,'full_month')`);
  return { actorId, assetId };
}

const root = pathToFileURL(process.cwd() + '/').href;
const state: { gate: { user: { orgId: string; id: string }; allowedSubsidiaryIds: Set<string> | null } | null } = { gate: null };
Object.assign(globalThis, { __assetPostingControls: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier.endsWith('/lib/feature-gates') && context.parentURL?.includes('/api/assets/')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function guardFeaturePermission(){return globalThis.__assetPostingControls.gate}' };
  }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context);
  return next(specifier, context);
} });
const { POST: dispose } = await import('../app/api/assets/[id]/dispose/route');
const { POST: remeasure } = await import('../app/api/assets/[id]/remeasure/route');
const scenarios = ['allowed scope', 'outside scope', 'empty scope', 'native accounts', 'legacy accounts', 'malformed date', 'empty date', 'null date', 'invalid calendar'] as const;
for (const operation of ['dispose', 'remeasure'] as const) {
  for (const scenario of scenarios) {
    test(`asset posting controls: ${operation}, ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const { actorId, assetId } = await seedAsset(org);
        state.gate = { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: new Set(
          scenario === 'empty scope' ? [] : [scenario === 'outside scope' ? randomUUID() : org.subsidiaryId]
        ) };
        let accumulatedAccountId = org.accounts.clearing;
        let assetAccountId = org.accounts.invAsset;
        if (scenario === 'native accounts') {
          assetAccountId = org.accounts.taxInput;
          accumulatedAccountId = org.accounts.taxOutput;
          await db.execute(sql`update fixed_assets set asset_account_id=${assetAccountId}, accumulated_depreciation_account_id=${accumulatedAccountId} where id=${assetId}`);
        }
        if (scenario === 'legacy accounts') {
          await db.execute(sql`update fixed_assets set custom=${JSON.stringify({accounts:{asset:org.accounts.taxInput,accumulated:org.accounts.taxOutput,gainLoss:org.accounts.freight}})}::jsonb where id=${assetId}`);
        }
        await buildSchedule(assetId, org.orgId, actorId, org.bookId);
        const depreciation = await runDepreciation(org.orgId, '2026-07-31', actorId, assetId);
        assert.equal(depreciation.totalAmount, '100.0000');
        const snapshot = async () => (await db.execute(sql`
          select (select jsonb_agg(to_jsonb(a) order by id) from fixed_assets a where org_id=${org.orgId}) as assets,
                 (select jsonb_agg(to_jsonb(e) order by id) from asset_events e where org_id=${org.orgId}) as events,
                 (select jsonb_agg(to_jsonb(e) order by id) from journal_entries e where org_id=${org.orgId}) as entries,
                 (select jsonb_agg(to_jsonb(l) order by id) from depreciation_schedule_lines l where org_id=${org.orgId}) as schedule_lines
        `)).rows;
        const before = await snapshot();
        const dates: Record<string, unknown> = { 'malformed date':'31-07-2026', 'empty date':'', 'null date':null, 'invalid calendar':'2026-02-30' };
        const date = scenario in dates ? dates[scenario] : '2026-07-31';
        const route = operation === 'dispose' ? dispose : remeasure;
        const response = await route(new Request(`http://audit.local/api/assets/${assetId}/${operation}`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({date,writeOff:true,newCarryingValue:'800'}),
        }), {params:Promise.resolve({id:assetId})});
        const body = await response.json();
        if (scenario in dates || scenario === 'outside scope' || scenario === 'empty scope') {
          assert.equal(response.status,422,JSON.stringify(body));
          assert.match(body.error, scenario in dates ? /calendar/ : /not found|scope|permitted/);
          assert.deepEqual(await snapshot(), before);
          return;
        }
        assert.equal(response.status,200,JSON.stringify(body));
        const lines = (await db.execute<{ account_id:string; amount:string }>(sql`
          select account_id,amount::text from journal_lines where org_id=${org.orgId} and entry_id=${body.entryId}
        `)).rows;
        assert.equal(lines.find(line=>line.account_id===accumulatedAccountId)?.amount, operation==='dispose' ? '100.0000' : '-100.0000');
        if (operation==='dispose') assert.equal(lines.find(line=>line.account_id===assetAccountId)?.amount,'-1000.0000');
        assert.equal(lines.find(line=>line.account_id===org.accounts.adjustment)?.amount,operation==='dispose' ? '900.0000' : '100.0000');
      } finally { state.gate=null; await dropScratchOrg(org.orgId); }
    });
  }
}

for (const operation of ['dispose', 'remeasure'] as const) {
  test(`asset posting rechecks subsidiary scope after waiting: ${operation}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    const writer = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
    let connected = false;
    let pending: Promise<Response> | undefined;
    try {
      const { actorId, assetId } = await seedAsset(org);
      const outsideId = randomUUID();
      await db.execute(sql`insert into subsidiaries (id,org_id,parent_id,name,base_currency,country,is_active) values (${outsideId},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA',true)`);
      state.gate = { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: new Set([org.subsidiaryId]) };
      await writer.connect(); connected = true;
      await writer.query('begin');
      await writer.query("select set_config('app.bypass_rls','on',true)");
      await writer.query('update fixed_assets set subsidiary_id=$1 where id=$2', [outsideId,assetId]);
      const pid = (await writer.query<{ pid:number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      pending = (operation === 'dispose' ? dispose : remeasure)(new Request(`http://audit.local/api/assets/${assetId}/${operation}`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({date:'2026-07-31',writeOff:true,newCarryingValue:'800'}),
      }), {params:Promise.resolve({id:assetId})});
      void pending.catch(() => {});
      let blocked = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const row = (await writer.query<{ blocked:boolean }>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked',[pid])).rows[0]!;
        if (row.blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve,25));
      }
      assert.ok(blocked,'posting waits for the concurrent asset update');
      await writer.query('commit');
      const response = await pending;
      assert.equal(response.status,422);
      assert.match((await response.json()).error,/not found|scope|permitted/);
      assert.equal((await db.execute(sql`select id from journal_entries where org_id=${org.orgId}`)).rows.length,0);
      assert.equal((await db.execute(sql`select id from asset_events where org_id=${org.orgId}`)).rows.length,0);
      const asset = (await db.execute<{ subsidiary_id:string; status:string }>(sql`select subsidiary_id,status from fixed_assets where id=${assetId}`)).rows[0]!;
      assert.equal(asset.subsidiary_id,outsideId);
      assert.equal(asset.status,'in_service');
    } finally {
      if (connected) await writer.query('rollback').catch(() => {});
      if (pending) await pending.catch(() => {});
      if (connected) await writer.end();
      state.gate=null;
      await dropScratchOrg(org.orgId);
    }
  });
}
