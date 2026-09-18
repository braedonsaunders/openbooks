import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../../../../lib/auth';
import type { PageSpec } from '@braedonsaunders/appkit-viewspec';
import type { Customer360Data } from '../../../../lib/customer-360';
import { resolveAppModule } from '../../../../lib/test-module-hooks';

// Same module-hook seam as cash-scope.integration.test.ts: shim server-only
// and next-intl, and let authz.ts read the session from test state so the
// real permission/subsidiary resolution runs against the scratch org.
const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __crm360Scope: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__crm360Scope.user}' };
  const app = resolveAppModule(specifier, context, next, root);
  if (app) return app;
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { WIDGET_NAMES } = await import('../../../../components/viewspec/registry-names');
const { loadCustomer360 } = await import('../../../../lib/customer-360');
const { loadCustomer360View, customer360Spec } = await import('./view');

function widgetNames(spec: PageSpec): string[] {
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (node && typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      if (rec.kind === 'widget' && typeof rec.widget === 'string') names.push(rec.widget);
      for (const value of Object.values(rec)) visit(value);
    }
  };
  visit((spec as { body?: unknown }).body ?? []);
  return names;
}

const emptyViewData = {
  title: 't',
  description: 'd',
  emptyTitle: 'e',
  emptyDescription: 'ed',
  customers: [],
  selectedCustomerId: null,
  cockpit: null,
};

test('customer-360 empty spec names only registered widgets', () => {
  // The e2e tenant has zero customers, so this is the branch CI renders:
  // 'empty-state-view' is not a registry name and threw UnknownWidgetError
  // mid-render on every visit.
  const names = widgetNames(customer360Spec({ ...emptyViewData }));
  assert.deepEqual(names, ['empty-state']);
  for (const name of names) assert.ok(WIDGET_NAMES.has(name), `${name} is not a registered widget`);
});

test('customer-360 cockpit spec names the cockpit widget', () => {
  const names = widgetNames(customer360Spec({ ...emptyViewData, cockpit: { party: {} } as unknown as Customer360Data }));
  assert.deepEqual(names, ['customer-360-cockpit']);
  for (const name of names) assert.ok(WIDGET_NAMES.has(name), `${name} is not a registered widget`);
});

interface Crm360Fixture {
  orgId: string;
  subsidiaryId: string;
  hiddenSubsidiaryId: string;
  visiblePartyId: string;
  hiddenPartyId: string;
  restrictedUserId: string;
}

async function seed(): Promise<Crm360Fixture> {
  // createScratchOrg is bypass-safe on all three of its paths, but the
  // author-time guard matches on name, so scope it explicitly rather than
  // carry a baseline entry for an exposure that cannot happen.
  const org = await withBypassContext(() => createScratchOrg());
  const fx = await withBypassContext(async () => {
    const restrictedUserId = await createScratchUser(org.orgId, 'CRM reviewer', 'crm360_reviewer');
    await db.execute(sql`update app_roles set permissions='["crm.accounts.read"]'::jsonb,
      subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
      where org_id=${org.orgId} and key='crm360_reviewer'`);
    const hiddenSubsidiaryId = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hiddenSubsidiaryId},${org.orgId},${org.subsidiaryId},'Hidden','USD','US')`);
    const visiblePartyId = randomUUID();
    const hiddenPartyId = randomUUID();
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values
      (${visiblePartyId},${org.orgId},'customer','Visible Corp',${org.subsidiaryId}),
      (${hiddenPartyId},${org.orgId},'customer','Hidden Ltd',${hiddenSubsidiaryId})`);
    await db.execute(sql`insert into customer_roles(org_id,party_id,credit_limit,currency) values
      (${org.orgId},${visiblePartyId},'5000','USD'),
      (${org.orgId},${hiddenPartyId},'9000','USD')`);
    // projects.customer_id is the link column; customer_party_id does not exist.
    await db.execute(sql`insert into projects(id,org_id,name,customer_id,subsidiary_id,is_active,status,contract_value) values
      (${randomUUID()},${org.orgId},'Visible rollout',${visiblePartyId},${org.subsidiaryId},true,'active','10000')`);
    return { hiddenSubsidiaryId, visiblePartyId, hiddenPartyId, restrictedUserId };
  });
  return { orgId: org.orgId, subsidiaryId: org.subsidiaryId, ...fx };
}

function sessionUser(userId: string, orgId: string): SessionUser {
  return { id: userId, orgId, name: 'CRM reviewer', email: 'crm360@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: userId };
}

test('customer-360 projects rollup and empty-history arithmetic resolve', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seed();
  try {
    const data = await withOrgContext(fx.orgId, () =>
      loadCustomer360(fx.visiblePartyId, fx.orgId, new Set([fx.subsidiaryId])));
    assert.ok(data, 'visible customer must load');
    assert.equal(data.party.id, fx.visiblePartyId);
    // Empty history: no settlements anywhere, so the 45-day default DSO
    // applies and the party average stays null rather than NaN.
    assert.equal(data.paymentMetrics.dso, 45);
    assert.equal(data.paymentMetrics.partyAvgDaysToPay, null);
    assert.equal(data.paymentMetrics.settlementsCount, 0);
    // No open items and no unbilled orders: the full limit is headroom and
    // the win rate over zero closed deals is null, not 0/0.
    assert.equal(data.credit.creditLimit, 5000);
    assert.equal(data.credit.openArBalance, 0);
    assert.equal(data.credit.remainingCredit, 5000);
    assert.equal(data.credit.creditUtilizationPercent, 0);
    assert.equal(data.aging.totalOpen, 0);
    assert.equal(data.pipeline.totalOpportunities, 0);
    assert.equal(data.pipeline.winRatePercent, null);
    assert.deepEqual(data.timeline, []);
    // The project linked by projects.customer_id rolls up.
    assert.equal(data.projects.enabled, true);
    assert.equal(data.projects.totalCount, 1);
    assert.equal(data.projects.activeCount, 1);
    assert.equal(data.projects.totalContractValue, 10000);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test('customer-360 hides another subsidiary\u2019s customer from a restricted caller', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seed();
  try {
    const restricted = new Set([fx.subsidiaryId]);
    const hidden = await withOrgContext(fx.orgId, () => loadCustomer360(fx.hiddenPartyId, fx.orgId, restricted));
    assert.equal(hidden, null, 'out-of-scope customer must load as null');
    const visible = await withOrgContext(fx.orgId, () => loadCustomer360(fx.visiblePartyId, fx.orgId, restricted));
    assert.ok(visible, 'in-scope customer must load');
    const missing = await withOrgContext(fx.orgId, () => loadCustomer360(randomUUID(), fx.orgId, restricted));
    assert.equal(missing, null, 'unknown party must load as null');
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test('customer-360 list is subsidiary-scoped and permission-gated', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seed();
  try {
    state.user = sessionUser(fx.restrictedUserId, fx.orgId);
    const view = await withOrgContext(fx.orgId, () => loadCustomer360View({}));
    assert.deepEqual(view.customers.map((c) => c.name), ['Visible Corp']);
    assert.equal(view.selectedCustomerId, fx.visiblePartyId);
    assert.ok(view.cockpit, 'the listed customer must load a cockpit');
    assert.equal(view.cockpit?.party.id, fx.visiblePartyId);
    // A caller without crm.accounts.read never reaches the list.
    const outsiderId = await withBypassContext(() => createScratchUser(fx.orgId, 'Outsider', 'crm360_outsider'));
    state.user = sessionUser(outsiderId, fx.orgId);
    await assert.rejects(withOrgContext(fx.orgId, () => loadCustomer360View({})));
  } finally {
    state.user = null;
    await dropScratchOrg(fx.orgId);
  }
});
