import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { db, env, withOrgTransaction } from '@openbooks/engine/src/db.ts';
import { buildSchedule, runDepreciation } from '@openbooks/engine/src/depreciation.ts';
import { remeasureAsset, disposeAsset, reverseAssetLifecycleEvent } from '@openbooks/engine/src/asset-lifecycle.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/test-fixtures.ts';

const state: { gate: { user: { orgId: string; id: string } } | null } = { gate: null };
Object.assign(globalThis, { __assetCategoryPolicy: state });
const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier.endsWith('/lib/authz') && context.parentURL?.includes('/api/admin/setup/')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function guardPermission(){return globalThis.__assetCategoryPolicy.gate}' };
  }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context);
  return next(specifier, context);
} });
const { PATCH } = await import('../app/api/admin/setup/[entity]/route');

async function seed(org: ScratchOrg) {
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const categoryId = randomUUID(), assetId = randomUUID();
  const body = { id: categoryId, name: 'Category policy', assetAccountId: org.accounts.invAsset,
    accumulatedDepreciationAccountId: org.accounts.clearing, depreciationExpenseAccountId: org.accounts.adjustment,
    gainLossAccountId: org.accounts.adjustment, defaultMethod: 'straight_line', defaultLifeMonths: 10,
    defaultConvention: 'full_month', isActive: true };
  await db.execute(sql`insert into asset_categories(id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention)
    values(${categoryId},${org.orgId},${body.name},${body.assetAccountId},${body.accumulatedDepreciationAccountId},${body.depreciationExpenseAccountId},${body.gainLossAccountId},'straight_line',10,'full_month')`);
  await db.execute(sql`insert into fixed_assets(id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,salvage_value,depreciation_method,useful_life_months,depreciation_convention)
    values(${assetId},${org.orgId},${org.subsidiaryId},${categoryId},'CATEGORY-POLICY','Category asset','in_service',${org.date},${org.date},1000,0,'straight_line',10,'full_month')`);
  state.gate = { user: { orgId: org.orgId, id: actorId } };
  return { actorId, categoryId, assetId, body };
}
function patch(body: Record<string, unknown>) {
  return PATCH(new Request('http://audit.local/api/admin/setup/asset-categories', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ entity: 'asset-categories' }) });
}
for (const history of ['depreciation', 'impairment'] as const) {
  test(`category account changes cannot redirect an asset with ${history} history`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const f = await seed(org);
      if (history === 'depreciation') {
        await buildSchedule(f.assetId, org.orgId, f.actorId, org.bookId);
        assert.equal((await runDepreciation(org.orgId, '2026-07-31', f.actorId, f.assetId)).posted, 1);
      } else await remeasureAsset(org.orgId, f.assetId, { actorId: f.actorId, date: '2026-07-31', newCarryingValue: '800' });
      const before = (await db.execute(sql`select * from asset_categories where id=${f.categoryId}`)).rows;
      const response = await patch({ ...f.body, accumulatedDepreciationAccountId: org.accounts.taxOutput });
      assert.equal(response.status, 409, JSON.stringify(await response.json()));
      assert.deepEqual((await db.execute(sql`select * from asset_categories where id=${f.categoryId}`)).rows, before);
    } finally { state.gate = null; await dropScratchOrg(org.orgId); }
  });
}

for (const history of ['depreciation', 'impairment', 'disposal', 'reversed impairment'] as const) {
  test(`storage preserves category policy after ${history}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const f = await seed(org);
      if (history === 'depreciation') {
        await buildSchedule(f.assetId, org.orgId, f.actorId, org.bookId);
        assert.equal((await runDepreciation(org.orgId, '2026-07-31', f.actorId, f.assetId)).posted, 1);
      } else if (history === 'disposal') {
        await disposeAsset(org.orgId, f.assetId, { actorId: f.actorId, date: '2026-07-31', proceeds: '300', proceedsAccountId: org.accounts.bank });
      } else {
        await remeasureAsset(org.orgId, f.assetId, { actorId: f.actorId, date: '2026-07-31', newCarryingValue: '800' });
        if (history === 'reversed impairment') {
          const event = (await db.execute<{id:string}>(sql`select id from asset_events where org_id=${org.orgId} and asset_id=${f.assetId}`)).rows[0]!;
          await reverseAssetLifecycleEvent(org.orgId, event.id, { actorId: f.actorId, date: '2026-07-31', reason: 'Policy regression reversal' });
        }
      }
      const methodId = randomUUID();
      await db.execute(sql`insert into depreciation_methods(id,org_id,code,name,formula) values(${methodId},${org.orgId},'POLICY-TEST','Policy test','(OC-RV)/AL')`);
      const changes: Record<string, unknown> = {
        asset_account_id: org.accounts.taxInput, accumulated_depreciation_account_id: org.accounts.taxOutput,
        depreciation_expense_account_id: org.accounts.taxInput, gain_loss_account_id: org.accounts.taxOutput,
        default_method: 'double_declining', default_depreciation_method_id: methodId, default_life_months: 24, default_convention: 'mid_month',
      };
      for (const [column, value] of Object.entries(changes)) {
        await assert.rejects(db.execute(sql`update asset_categories set ${sql.identifier(column)}=${value} where id=${f.categoryId}`),
          (error: unknown) => (error as { cause?: { constraint?: string } }).cause?.constraint === 'asset_category_posted_policy', column);
      }
      const before = (await db.execute(sql`select * from asset_categories where id=${f.categoryId}`)).rows[0]!;
      const response = await patch({ ...f.body, name: 'Reviewed category label' });
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
      const after = (await db.execute(sql`select * from asset_categories where id=${f.categoryId}`)).rows[0]!;
      const evidence = (await db.execute<{changes:unknown;actor_id:string}>(sql`select changes,actor_id from audit_log where org_id=${org.orgId} and row_id=${f.categoryId} and action='update' order by at desc limit 1`)).rows[0]!;
      assert.deepEqual(evidence.changes, JSON.parse(JSON.stringify({ before, after })));
      assert.equal(evidence.actor_id, f.actorId);
    } finally { state.gate = null; await dropScratchOrg(org.orgId); }
  });
}

test('category defaults remain editable before financial history and independent categories stay independent', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const f = await seed(org);
    const response = await patch({ ...f.body, accumulatedDepreciationAccountId: org.accounts.taxOutput, defaultLifeMonths: 24 });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    const other = randomUUID();
    await db.execute(sql`insert into asset_categories(id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id) values(${other},${org.orgId},'Unused category',${org.accounts.invAsset},${org.accounts.clearing},${org.accounts.adjustment})`);
    await remeasureAsset(org.orgId, f.assetId, { actorId: f.actorId, date: '2026-07-31', newCarryingValue: '800' });
    await db.execute(sql`update asset_categories set default_life_months=36 where id=${other}`);
    assert.equal((await db.execute(sql`select default_life_months from asset_categories where id=${other}`)).rows[0]!.default_life_months, 36);
  } finally { state.gate = null; await dropScratchOrg(org.orgId); }
});

async function waitForBlock(pid: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await db.execute<{blocked:boolean}>(sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))) as blocked`);
    if (result.rows[0]?.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('expected a database lock wait');
}

for (const operation of ['impairment', 'disposal'] as const) {
  test(`${operation} locks category defaults before reading them`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    const writer = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
    let pending: Promise<unknown> | undefined;
    try {
      const f = await seed(org);
      await writer.connect();
      await writer.query('begin');
      await writer.query('update asset_categories set accumulated_depreciation_account_id=$1 where id=$2', [org.accounts.taxOutput, f.categoryId]);
      const pid = (await writer.query<{pid:number}>('select pg_backend_pid() as pid')).rows[0]!.pid;
      pending = operation === 'impairment'
        ? remeasureAsset(org.orgId, f.assetId, { actorId: f.actorId, date: '2026-07-31', newCarryingValue: '800' })
        : disposeAsset(org.orgId, f.assetId, { actorId: f.actorId, date: '2026-07-31', proceeds: '300', proceedsAccountId: org.accounts.bank });
      void pending.catch(() => {});
      await waitForBlock(pid);
      await writer.query('commit');
      await pending;
      const accounts = (await db.execute<{account_id:string}>(sql`select account_id from journal_lines where org_id=${org.orgId}`)).rows.map(row => row.account_id);
      if (operation === 'impairment') assert.ok(accounts.includes(org.accounts.taxOutput));
      assert.ok(!accounts.includes(org.accounts.clearing));
    } finally {
      await writer.query('rollback').catch(() => {});
      await pending?.catch(() => {});
      await writer.end();
      state.gate = null; await dropScratchOrg(org.orgId);
    }
  });
}

test('category policy update waits for an in-flight posting and then rejects committed history', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let ready!: (pid:number) => void;
  let failReady!: (error:unknown) => void;
  const started = new Promise<number>((resolve,reject) => { ready = resolve; failReady = reject; });
  let posting: Promise<unknown> | undefined;
  let saving: Promise<Response> | undefined;
  try {
    const f = await seed(org);
    posting = withOrgTransaction(org.orgId, async () => {
      await remeasureAsset(org.orgId, f.assetId, { actorId: f.actorId, date: '2026-07-31', newCarryingValue: '800' });
      ready((await db.execute<{pid:number}>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid);
      await gate;
    });
    void posting.catch(failReady);
    const pid = await started;
    saving = patch({ ...f.body, accumulatedDepreciationAccountId: org.accounts.taxOutput });
    void saving.catch(() => {});
    await waitForBlock(pid);
    release();
    await posting;
    const response = await saving;
    assert.equal(response.status, 409, JSON.stringify(await response.json()));
  } finally {
    release(); await posting?.catch(() => {}); await saving?.catch(() => {});
    state.gate = null; await dropScratchOrg(org.orgId);
  }
});

test('category metadata and evidence roll back together on audit failure', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const f = await seed(org);
    const name = `category_audit_${randomUUID().replaceAll('-', '')}`;
    await db.execute(sql.raw(`create function public."${name}"() returns trigger language plpgsql as $$ begin if new.table_name='asset_categories' and new.actor_id='${f.actorId}'::uuid then raise exception 'forced category audit failure'; end if; return new; end $$; create trigger "${name}" before insert on audit_log for each row execute function public."${name}"();`));
    cleanup = async () => { await db.execute(sql.raw(`drop trigger if exists "${name}" on audit_log; drop function if exists public."${name}"();`)); };
    const before = (await db.execute(sql`select * from asset_categories where id=${f.categoryId}`)).rows;
    const response = await patch({ ...f.body, name: 'Unrecorded category edit' });
    assert.equal(response.status, 400);
    assert.deepEqual((await db.execute(sql`select * from asset_categories where id=${f.categoryId}`)).rows, before);
    assert.equal((await db.execute(sql`select id from audit_log where row_id=${f.categoryId}`)).rows.length, 0);
  } finally { await cleanup?.(); state.gate = null; await dropScratchOrg(org.orgId); }
});

test('category update cannot reach another organization', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg(), other = await createScratchOrg();
  try {
    const f = await seed(org);
    state.gate = { user: { orgId: other.orgId, id: (await seedFlowActors(other.orgId)).adminId } };
    const before = (await db.execute(sql`select * from asset_categories where id=${f.categoryId}`)).rows;
    const response = await patch({ ...f.body, name: 'Cross-tenant edit' });
    assert.equal(response.status, 404, JSON.stringify(await response.json()));
    assert.deepEqual((await db.execute(sql`select * from asset_categories where id=${f.categoryId}`)).rows, before);
  } finally { state.gate = null; await dropScratchOrg(org.orgId); await dropScratchOrg(other.orgId); }
});
