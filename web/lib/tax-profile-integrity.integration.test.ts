import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  return next(specifier, context);
}});
const { sql } = await import('drizzle-orm');
const { db } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { taxProfileMap, computeBillTotals } = await import('./bills');
for (const mode of ['inactive component', 'unrated component', 'lapsed component', 'complete group', 'zero component'] as const) {
  test(`tax profile validity: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const good = randomUUID(), bad = randomUUID(), group = randomUUID();
      await db.execute(sql`insert into tax_codes (id,org_id,code,name,is_active,collected_account_id,paid_account_id)
        values (${good},${org.orgId},'GOOD','Valid tax',true,${org.accounts.taxOutput},${org.accounts.taxInput}),
          (${bad},${org.orgId},'BAD','Invalid tax component',${mode !== 'inactive component'},${org.accounts.taxOutput},${org.accounts.taxInput})`);
      await db.execute(sql`insert into tax_rates (org_id,tax_code_id,rate_percent,effective_from)
        values (${org.orgId},${good},'5','2026-01-01')`);
      if (mode !== 'unrated component') await db.execute(sql`insert into tax_rates (org_id,tax_code_id,rate_percent,effective_from,effective_to)
        values (${org.orgId},${bad},${mode === 'zero component' ? '0' : '8'},'2026-01-01',${mode === 'lapsed component' ? '2026-06-30' : null})`);
      await db.execute(sql`insert into tax_groups (id,org_id,code,name) values (${group},${org.orgId},'GROUP','Incomplete tax group')`);
      await db.execute(sql`insert into tax_group_members (tax_group_id,tax_code_id,sequence)
        values (${group},${good},1),(${group},${bad},2)`);
      const profiles = await taxProfileMap(org.orgId, org.date);
      assert.equal(computeBillTotals([{ accountId: org.accounts.revenue, amount: '100', taxCodeId: good }], profiles).taxTotal, '5.0000');
      if (mode === 'complete group' || mode === 'zero component') {
        assert.equal(computeBillTotals([{ accountId: org.accounts.revenue, amount: '100', taxGroupId: group }], profiles).taxTotal,
          mode === 'zero component' ? '5.0000' : '13.0000');
        assert.equal(computeBillTotals([{ accountId: org.accounts.revenue, amount: '100', taxCodeId: bad }], profiles).taxTotal,
          mode === 'zero component' ? '0.0000' : '8.0000');
        return;
      }
      assert.throws(() => computeBillTotals([{ accountId: org.accounts.revenue, amount: '100', taxGroupId: group }], profiles), /inactive|effective rate/);
      assert.throws(() => computeBillTotals([{ accountId: org.accounts.revenue, amount: '100', taxCodeId: bad }], profiles), /inactive|effective rate/);
    } finally { await dropScratchOrg(org.orgId); }
  });
}
