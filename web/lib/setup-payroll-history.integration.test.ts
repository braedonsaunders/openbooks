import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '@openbooks/engine/src/db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/test-fixtures.ts';

const state: {gate: {user: {orgId: string; id: string}} | null} = {gate: null};
Object.assign(globalThis, {__payrollPolicySetup: state});
registerHooks({resolve(specifier, context, next) {
  if (specifier === 'server-only') return {shortCircuit: true, url: 'data:text/javascript,export {}'};
  if (specifier.endsWith('/lib/authz') && context.parentURL?.includes('/api/admin/setup/')) {
    return {shortCircuit: true, url: 'data:text/javascript,export async function guardPermission(){return globalThis.__payrollPolicySetup.gate}'};
  }
  if (specifier.startsWith('@/')) return next(pathToFileURL(process.cwd()+'/web/'+specifier.slice(2)+'.ts').href, context);
  return next(specifier, context);
}});
const {PATCH, DELETE} = await import('../app/api/admin/setup/[entity]/route');
const {setupResource} = await import('./data-io/setup-resources');
const {SETUP_ENTITY_BY_KEY} = await import('./setup/registry');

for (const channel of ['PATCH', 'DELETE', 'import', 'preview'] as const) {
  test(`setup ${channel} preserves historical component policy and audit evidence`,
    {skip: !process.env.OPENBOOKS_DB_URL}, async () => {
      const org = await createScratchOrg();
      try {
        const actorId = (await seedFlowActors(org.orgId)).adminId;
        state.gate = {user: {orgId: org.orgId, id: actorId}};
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
          coalesce(settings->'features','{}'::jsonb)||'{"payroll":true}'::jsonb) where id=${org.orgId}`);
        const employeeId = randomUUID(), scheduleId = randomUUID(), documentId = randomUUID();
        const stubId = randomUUID(), componentId = randomUUID();
        await db.execute(sql`insert into parties(id,org_id,kind,display_name) values
          (${employeeId},${org.orgId},'person','Historical employee')`);
        await db.execute(sql`insert into pay_schedules(id,org_id,name,frequency,periods_per_year,anchor_period_end)
          values(${scheduleId},${org.orgId},'Historical schedule','biweekly',26,'2026-07-18')`);
        await db.execute(sql`insert into documents(id,org_id,kind,document_number,subsidiary_id,document_date,currency)
          values(${documentId},${org.orgId},'pay_run','HISTORICAL',${org.subsidiaryId},'2026-07-21','CAD')`);
        await db.execute(sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status)
          values(${documentId},${org.orgId},${scheduleId},'2026-07-05','2026-07-18','2026-07-21',2026,'committed')`);
        await db.execute(sql`insert into pay_stubs(id,org_id,pay_run_document_id,employee_party_id,province,periods_per_year,pay_date,tax_year,currency_code)
          values(${stubId},${org.orgId},${documentId},${employeeId},'ON',26,'2026-07-21',2026,'CAD')`);
        await db.execute(sql`insert into pay_components(id,org_id,code,name,kind)
          values(${componentId},${org.orgId},'HISTORY','Historical earning','earning')`);
        await db.execute(sql`insert into pay_stub_lines(org_id,stub_id,component_id,kind,description,amount)
          values(${org.orgId},${stubId},${componentId},'earning','Historical earning','240')`);
        const before = (await db.execute(sql`select * from pay_components where org_id=${org.orgId} and id=${componentId}`)).rows;
        const auditBefore = (await db.execute(sql`select * from audit_log where org_id=${org.orgId} order by id`)).rows;
        const body = {id: componentId, code: 'HISTORY', name: 'Changed earning', kind: 'earning', taxable: false};
        if (channel === 'import' || channel === 'preview') {
          const outcome = await setupResource(SETUP_ENTITY_BY_KEY.get('pay-components')!,org.orgId)
            .write([body],'upsert',{orgId: org.orgId,actorId,dryRun: channel === 'preview'});
          assert.equal(outcome.updated,0); assert.equal(outcome.failed,1);
          assert.match(outcome.errors[0]!.message,/fixed after committed payroll/);
        } else {
          const response = await (channel === 'PATCH' ? PATCH : DELETE)(new Request(
            `http://audit.local/api/admin/setup/pay-components?id=${componentId}`,
            {method: channel,headers: {'Content-Type':'application/json'},
              ...(channel === 'PATCH' ? {body: JSON.stringify(body)} : {})}),
          {params: Promise.resolve({entity: 'pay-components'})});
          assert.equal(response.status,409);
          assert.match((await response.json()).error,/fixed after committed payroll/);
        }
        assert.deepEqual((await db.execute(sql`select * from pay_components where org_id=${org.orgId} and id=${componentId}`)).rows,before);
        assert.deepEqual((await db.execute(sql`select * from audit_log where org_id=${org.orgId} order by id`)).rows,auditBefore);
        assert.equal((await db.execute(sql`select component_id from pay_stub_lines where org_id=${org.orgId} and stub_id=${stubId}`)).rows[0]?.component_id,componentId);
      } finally {state.gate=null;await dropScratchOrg(org.orgId);}
    });
}
