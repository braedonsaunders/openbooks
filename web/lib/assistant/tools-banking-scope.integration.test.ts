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
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { executeAssistantTool } = await import('./registry');

test('banking assistant reads hide reconciliation data outside the caller subsidiary', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const hidden = randomUUID();
  const hiddenAccount = randomUUID();
  const statementId = randomUUID();
  const statementLineId = randomUUID();
  const reconciliationId = randomUUID();
  const userId = randomUUID();
  const user: SessionUser = {
    id: userId,
    orgId: org.orgId,
    name: 'Banking scope reader',
    email: 'banking-scope@scratch.test',
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: userId,
  };
  try {
    await db.execute(sql`
      insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active,is_elimination)
      values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden bank entity','CAD','CA',true,false)
    `);
    await db.execute(sql`
      insert into accounts(id,org_id,number,name,type,is_active,reconcilable,currency_restriction,subsidiary_id)
      values (${hiddenAccount},${org.orgId},'9900','Hidden cash','asset_bank',true,true,'CAD',${hidden})
    `);
    await db.execute(sql`
      insert into bank_statements(id,org_id,account_id,source,statement_date,closing_balance,raw_file_ref)
      values (${statementId},${org.orgId},${hiddenAccount},'scope-fixture','2026-07-31','1250','scope-fixture.raw')
    `);
    await db.execute(sql`
      insert into bank_statement_lines(
        id,org_id,statement_id,line_number,posted_on,amount,currency,description,match_status,account_id
      ) values (
        ${statementLineId},${org.orgId},${statementId},1,'2026-07-15','1250','CAD','Hidden transfer','unmatched',${hiddenAccount}
      )
    `);
    await db.execute(sql`
      insert into reconciliations(
        id,org_id,account_id,through_date,statement_balance,status,currency
      ) values (
        ${reconciliationId},${org.orgId},${hiddenAccount},'2026-07-31','1250','in_progress','CAD'
      )
    `);
    const authz = {
      user,
      permissions: new Set(['assistant.use', 'banking.read', 'banking.reconcile']),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    };
    await withOrgContext(org.orgId, async () => {
      const reconciliations = await executeAssistantTool(authz, 'list_bank_reconciliations', {});
      assert.equal(reconciliations.ok, true, JSON.stringify(reconciliations));
      assert.ok(reconciliations.ok);
      assert.deepEqual((reconciliations.data as { reconciliations: unknown[] }).reconciliations, []);

      const reconciliation = await executeAssistantTool(authz, 'get_bank_reconciliation', { reconciliationId });
      assert.deepEqual(reconciliation, { ok: false, error: 'reconciliation_not_found' });

      const unmatched = await executeAssistantTool(authz, 'list_unmatched_bank_lines', {});
      assert.equal(unmatched.ok, true, JSON.stringify(unmatched));
      assert.ok(unmatched.ok);
      assert.deepEqual((unmatched.data as { lines: unknown[] }).lines, []);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
