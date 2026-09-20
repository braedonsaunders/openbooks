import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

// The budget drill-down must scope budget lines by the line's own legal
// entity — the rule every sibling reader applies (budget vs actual report,
// scenario list totals, module-home scenario gate: all key on
// bl.subsidiary_id). The drill instead attributed lines through dimension
// owners and never read bl.subsidiary_id at all, which cut both ways for a
// subsidiary-restricted caller: another entity's line wearing one of your
// dimensions leaked in, while your own undimensioned lines were denied —
// even though the report and the list right beside the drill showed them.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') {
    return { shortCircuit: true, url: `data:text/javascript,export async function getTranslations() { return (key) => key }` };
  }
  if (specifier === './money-server' || specifier.endsWith('/money-server')) {
    return { shortCircuit: true, url: `data:text/javascript,export async function getMoneyFormatter() { return { money: (value) => String(value) } }` };
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { loadReportDrillData } = await import('./report-drill-data.ts');
type Authz = import('./authz.ts').Authz;

const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(orgId: string, userId: string, allowed: string[]): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: 'Restricted Reader', orgId,
      roles: [{ key: 'viewer', name: 'viewer' }],
      envKind: 'sandbox', productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(['reports.read']),
    allowedSubsidiaryIds: new Set(allowed),
  };
}

test('budget drill keys lines on the line subsidiary, not dimension owners', { skip: !DB }, async () => {
  // Fixture seeds under explicit bypass: importing ./report-drill-data.ts
  // above pulls in the web request-org resolver, which denies every unscoped
  // query under pooled RLS (bare setup dies with 42501). The drill issues
  // bare reads with explicit org predicates, so it runs in the scratch org's
  // scope; the authz provides the app-level subsidiary restriction under test.
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const otherSub = randomUUID();
    const deptId = randomUUID();
    const scenarioId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${otherSub}, ${org.orgId}, ${org.subsidiaryId}, 'Other entity', 'CAD', 'CA')`);
      await db.execute(sql`insert into departments (id, org_id, name, subsidiary_id)
        values (${deptId}, ${org.orgId}, 'Home department', ${org.subsidiaryId})`);
      await db.execute(sql`insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
        values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Scope probe', 'budget', 'draft')`);
      // Own line, no dimensions: the report and the list both show it.
      await db.execute(sql`insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
        values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId}, 100)`);
      // Another entity's line wearing one of our dimensions: must stay hidden.
      await db.execute(sql`insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, department_id, amount)
        values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${otherSub}, ${deptId}, 999)`);
    });

    const authz = authzFor(org.orgId, randomUUID(), [org.subsidiaryId]);
    const drill = await withOrgContext(org.orgId, () => loadReportDrillData(
      { kind: 'budget', label: 'COGS budget', scenarioId, scope: 'budget' },
      authz,
      1,
    ));
    const amounts = drill.rows.map((row) => row.cells[3]);
    assert.ok(!amounts.includes('999.0000'), 'another entity line must not leak through a shared dimension');
    assert.ok(amounts.includes('100.0000'), 'own undimensioned line must be visible in the drill');
    assert.equal(drill.total, 1);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
