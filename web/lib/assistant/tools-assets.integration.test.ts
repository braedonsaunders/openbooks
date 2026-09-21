import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';

const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
    }
    return nextResolve(path, context);
  }
  return nextResolve(specifier, context);
} });

const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { executeAssistantTool } = await import('./registry');

function reader(orgId: string, subsidiaryIds: Set<string> | null, perms: string[] = ['assistant.use', 'assets.read']) {
  const userId = randomUUID();
  const user: SessionUser = {
    id: userId,
    orgId,
    name: 'Asset scope reader',
    email: 'asset-scope@scratch.test',
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
  return { user, permissions: new Set(perms), allowedSubsidiaryIds: subsidiaryIds };
}

test('asset reads: register totals, drawer detail, and subsidiary isolation', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const hidden = randomUUID();
  const categoryId = randomUUID();
  const assetId = randomUUID();
  const poolId = randomUUID();
  const hiddenPoolId = randomUUID();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"fixedAssets":true}'::jsonb) where id=${org.orgId}`);
      await db.execute(sql`
        insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination)
        values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden plant','CAD','CA',true,false)
      `);
      await db.execute(sql`
        insert into asset_categories(id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,default_method,tax_attributes)
        values (${categoryId},${org.orgId},'Fleet machinery',${org.accounts.invAsset},${org.accounts.adjustment},${org.accounts.cogs},'straight_line','{}')
      `);
      await db.execute(sql`
        insert into fixed_assets(id,org_id,category_id,asset_number,name,status,acquired_on,acquisition_cost,subsidiary_id)
        values (${assetId},${org.orgId},${categoryId},'FA-0001','Visible press','in_service',${org.date},'10000',${org.subsidiaryId}),
               (${randomUUID()},${org.orgId},${categoryId},'FA-0002','Hidden press','in_service',${org.date},'50000',${hidden})
      `);
      await db.execute(sql`
        insert into tax_depreciation_pools(id,org_id,book_id,subsidiary_id,regime,class_code,rate,method,opening_balance)
        values (${poolId},${org.orgId},${org.bookId},${org.subsidiaryId},'test-regime','10.1','30','declining','1000'),
               (${hiddenPoolId},${org.orgId},${org.bookId},${hidden},'test-regime','10.1','30','declining','9000')
      `);
      const visibleWindow = randomUUID();
      const hiddenWindow = randomUUID();
      await db.execute(sql`
        insert into tax_year_windows(id,org_id,subsidiary_id,regime,year_start,year_end,filing_year,reason)
        values (${visibleWindow},${org.orgId},${org.subsidiaryId},'test-regime','2025-01-01','2025-12-31',2025,'calendar-year tax window'),
               (${hiddenWindow},${org.orgId},${hidden},'test-regime','2025-01-01','2025-12-31',2025,'calendar-year tax window')
      `);
      await db.execute(sql`
        insert into tax_pool_periods(id,org_id,pool_id,tax_year,tax_year_window_id,opening_balance,additions,dispositions,net_additions,immediate_expense,base,allowance,closing_balance,recapture,terminal_loss,short_year_factor,year_start,year_end)
        values (${randomUUID()},${org.orgId},${poolId},2025,${visibleWindow},'1000','0','0','0','0','1000','100','900','0','0','1','2025-01-01','2025-12-31'),
               (${randomUUID()},${org.orgId},${hiddenPoolId},2025,${hiddenWindow},'9000','0','0','0','0','9000','900','8100','0','0','1','2025-01-01','2025-12-31')
      `);
    });

    const restricted = reader(org.orgId, new Set([org.subsidiaryId]));
    const search = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'search_assets', {}));
    assert.equal(search.ok, true, JSON.stringify(search));
    const searchData = (search as { ok: true; data: Record<string, unknown> }).data;
    assert.equal(searchData.total, 1);
    assert.equal(searchData.sumAcquisitionCost, '10000.0000');
    assert.equal(searchData.sumNetBookValue, '10000.0000');

    const get = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'get_asset', { id: assetId }));
    assert.equal(get.ok, true, JSON.stringify(get));
    const detail = (get as { ok: true; data: Record<string, unknown> }).data;
    assert.equal((detail.totals as Record<string, string>).netBookValue, '10000.0000');

    const pools = await withOrgContext(org.orgId, () =>
      executeAssistantTool(restricted, 'asset_tax_pools', { taxYear: 2025 }));
    assert.equal(pools.ok, true, JSON.stringify(pools));
    const poolRows = (pools as { ok: true; data: Record<string, unknown> }).data.pools as Record<string, unknown>[];
    assert.equal(poolRows.length, 1);
    assert.equal(poolRows[0]?.closingBalance, '900.0000');

    const noperm = reader(org.orgId, null, ['assistant.use']);
    const denied = await withOrgContext(org.orgId, () =>
      executeAssistantTool(noperm, 'search_assets', {}));
    assert.equal(denied.ok, false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('asset reads refuse while the feature is off', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"fixedAssets":false}'::jsonb) where id=${org.orgId}`);
    });
    const authz = reader(org.orgId, null);
    const search = await withOrgContext(org.orgId, () =>
      executeAssistantTool(authz, 'search_assets', {}));
    assert.equal(search.ok, false);
    assert.equal((search as { ok: false; error: string }).error, 'fixedAssets_feature_disabled');
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
