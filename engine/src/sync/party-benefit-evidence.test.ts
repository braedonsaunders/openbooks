import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const orgId = '00000000-0000-4000-8000-000000000001';
const absorbedId = '00000000-0000-4000-8000-000000000002';
const survivorId = '00000000-0000-4000-8000-000000000003';
const dialect = new PgDialect();
const queries: { sql: string; params: unknown[] }[] = [];
let protectedTable = 'pay_run_benefit_allocations';
const executor = {
  async execute(query: Parameters<typeof dialect.sqlToQuery>[0]) {
    const compiled = dialect.sqlToQuery(query);
    queries.push(compiled);
    if (compiled.sql.includes("current_setting('openbooks.amend'")) return { rows: [] };
    if (compiled.sql.startsWith('set local')) return { rows: [] };
    if (compiled.sql.includes('order by id for update')) return { rows: [{ id: absorbedId }, { id: survivorId }] };
    if (compiled.sql.includes('select id, display_name')) {
      const id = compiled.params[0];
      return { rows: [{ id, display_name: id === absorbedId ? 'Recorded employee' : 'Surviving employee', is_active: true, custom: {} }] };
    }
    if (compiled.sql.startsWith('select id from')) return { rows: compiled.sql.includes(`"${protectedTable}"`) ? [{ id: 'recorded-evidence' }] : [] };
    throw new Error('Unexpected query before protected payroll refusal: ' + compiled.sql);
  },
};
const stateKey = Symbol.for('openbooks.party-benefit-evidence-test');
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = executor;
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../platform/db.ts' && context.parentURL?.endsWith('/sync/party-merges.ts')) return { url: 'mock:party-evidence-db', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'mock:party-evidence-db') return { format: 'module', shortCircuit: true, source: `
      const tx = globalThis[Symbol.for('openbooks.party-benefit-evidence-test')];
      export const db = { transaction: async (fn) => fn(tx) };
      export const withTransactionSavepoint = async (tx, fn) => fn();
    ` };
    return next(url, context);
  },
});
const { applySourcePartyMerge } = await import('./party-merges.ts');
test('recorded payroll subjects and approval authors refuse party merges before any identity or history mutation', async () => {
  try {
    for (const [table, label] of [
      ['pay_run_benefit_allocations', 'native benefit payroll evidence'],
      ['payroll_compensation_assignments', 'compensation assignment history'],
      ['payroll_period_openings', 'prior-provider payroll period balances'],
      ['payroll_employee_employer_assignments', 'dated payroll employer assignments'],
      ['hrm_training_courses', 'training course authorship evidence'],
      ['hrm_shift_templates', 'shift template authorship evidence'],
      ['hrm_shift_assignments', 'shift assignment authorship evidence'],
      ['hrm_shifts', 'shift authorship evidence'],
      ['hrm_shift_requests', 'shift request authorship evidence'],
    ] as const) {
      protectedTable = table!;
      queries.length = 0;
      await assert.rejects(applySourcePartyMerge({ orgId, absorbedId, survivorId, sourceName: 'native', absorbedRef: 'employee-a', survivorRef: 'employee-b', actorId: null, runId: null }), new RegExp(label + '.*Keep the employee identities separate'));
      const evidence = queries.find(query => query.sql.includes(`"${table}"`));
      assert.ok(evidence, table);
      assert.deepEqual(evidence.params, [orgId, absorbedId]);
      assert.ok(!queries.some(query => /^\s*(update|insert|delete)\b/i.test(query.sql)), table);
    }
  } finally {
    hook.deregister();
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey];
  }
});
