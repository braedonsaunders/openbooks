import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import type { SessionUser } from './auth';

const root = pathToFileURL(process.cwd() + '/').href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __customFieldControls: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === './auth' && context.parentURL?.endsWith('/authz.ts')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__customFieldControls.user}' };
  }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context);
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, env, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { documentRevisionSql, isDocumentRevisionToken } = await import('@openbooks/engine/src/document-revision.ts');
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { POST, PATCH } = await import('../app/api/admin/custom-fields/route');

const scenarios = ['create evidence', 'update evidence', 'missing revision', 'truncated revision', 'malformed revision', 'stale revision', 'successive saves', 'concurrent editors', 'waiting writer', 'create audit failure', 'update audit failure', 'foreign definition', 'permission denied', 'invalid id'] as const;
for (const scenario of scenarios) {
  test(`custom-field controls: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    const foreignOrg = scenario === 'foreign definition' ? await createScratchOrg() : null;
    const foreignId = randomUUID();
    const writer = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
    let connected = false;
    let pending: Promise<Response> | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await db.execute(sql`update app_roles set permissions='["admin.custom_fields.manage"]'::jsonb where org_id=${org.orgId} and key='admin'`);
      state.user = { id: actor, orgId: org.orgId, homeUserId: actor, homeOrgId: org.orgId, productionOrgId: org.orgId, envKind: 'production', name: 'Definition reviewer', email: 'definition@scratch.test', roles: [], isSuperAdmin: false };
      if (foreignOrg) await db.execute(sql`insert into custom_field_defs(id,org_id,target_table,key,label,field_type) values (${foreignId},${foreignOrg.orgId},'parties','foreign_note','Private field','text')`);
      const id = randomUUID();
      await db.execute(sql`insert into custom_field_defs(id,org_id,target_table,key,label,field_type,config,updated_at)
        values (${id},${org.orgId},'parties','review_limit','Review limit','currency','{"min":"900000000000000.1234","referenceMetadata":{"preserve":true}}'::jsonb,
        date_trunc('second',now()+interval '1 day')+interval '123450 microseconds')`);
      const row = async () => JSON.parse(JSON.stringify((await db.execute(sql`select f.*,
        ${documentRevisionSql(sql`created_at`)} as created_at,${documentRevisionSql(sql`updated_at`)} as updated_at
        from custom_field_defs f where id=${id}`)).rows[0]));
      const revision = (await row()).updated_at as string;
      const snapshot = async () => (await db.execute(sql`select
        (select jsonb_agg(to_jsonb(f) order by f.id) from custom_field_defs f where org_id=${org.orgId}) as definitions,
        (select jsonb_agg(to_jsonb(a) order by a.id) from audit_log a where org_id=${org.orgId}) as audit`)).rows;
      const request = (method: string, body: unknown) => new Request('http://audit.local/api/admin/custom-fields', {
        method, headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'custom-field-control-review' }, body: JSON.stringify(body),
      });
      const patch = (body: Record<string, unknown>) => withOrgContext(org.orgId, () => PATCH(request('PATCH', { id, expectedUpdatedAt: revision, ...body })));
      const create = () => withOrgContext(org.orgId, () => POST(request('POST', { targetTable: 'parties', key: 'review_note', label: 'Review note', fieldType: 'text', config: { helpText: 'Evidence' } })));
      if (scenario === 'create audit failure' || scenario === 'update audit failure') {
        const name = 'cf_audit_fail_' + randomUUID().replaceAll('-', '');
        await db.execute(sql.raw(`create function public."${name}"() returns trigger language plpgsql as $$ begin if new.table_name='custom_field_defs' and new.actor_id='${actor}'::uuid then raise exception 'forced custom-field audit failure'; end if; return new; end $$; create trigger "${name}" before insert on audit_log for each row execute function public."${name}"();`));
        cleanup = async () => { await db.execute(sql.raw(`drop trigger if exists "${name}" on audit_log; drop function if exists public."${name}"();`)); };
        const before = await snapshot();
        await assert.rejects(scenario === 'create audit failure' ? create() : patch({ label: 'Must roll back' }));
        assert.deepEqual(await snapshot(), before, 'definition and evidence commit together or neither does');
        return;
      }
      if (scenario === 'create evidence') {
        const response = await create(); assert.equal(response.status, 200);
        const created = await response.json();
        const definition = (await db.execute(sql`select f.*,${documentRevisionSql(sql`created_at`)} as created_at,${documentRevisionSql(sql`updated_at`)} as updated_at from custom_field_defs f where id=${created.id}`)).rows[0]!;
        const audits = (await db.execute(sql`select * from audit_log where row_id=${created.id} and org_id=${org.orgId} and table_name='custom_field_defs'`)).rows;
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.actor_id, actor); assert.equal(audits[0]!.action, 'insert');
        assert.equal(audits[0]!.request_id, 'custom-field-control-review');
        assert.deepEqual(audits[0]!.changes, { after: JSON.parse(JSON.stringify(definition)) });
        assert.equal(definition.created_by, actor); assert.equal(definition.updated_by, actor);
        assert.equal(created.updatedAt, definition.updated_at);
        return;
      }
      if (scenario === 'update evidence' || scenario === 'successive saves') {
        let token = revision;
        for (const label of scenario === 'successive saves' ? ['First edit', 'Second edit'] : ['Updated label']) {
          const before = await row();
          const response = await patch({ expectedUpdatedAt: token, label }); assert.equal(response.status, 200);
          const result = await response.json();
          const after = await row();
          assert.ok(isDocumentRevisionToken(result.updatedAt)); assert.ok(result.updatedAt > token); assert.equal(result.updatedAt, after.updated_at);
          assert.equal(after.updated_by, actor); assert.deepEqual(after.config, before.config);
          const audits = (await db.execute(sql`select * from audit_log where org_id=${org.orgId} and row_id=${id} order by at desc,id desc`)).rows;
          assert.deepEqual(audits[0]!.changes, { before, after });
          assert.equal(audits[0]!.actor_id, actor); assert.equal(audits[0]!.request_id, 'custom-field-control-review');
          token = result.updatedAt;
        }
        return;
      }
      if (scenario === 'concurrent editors') {
        const results = await Promise.all([patch({ label: 'Editor one' }), patch({ config: { min: '10.0001' } })]);
        assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
        assert.equal((await db.execute(sql`select id from audit_log where row_id=${id} and org_id=${org.orgId}`)).rows.length, 1);
        return;
      }
      if (scenario === 'waiting writer') {
        await writer.connect(); connected = true;
        await writer.query('begin'); await writer.query("select set_config('app.bypass_rls','on',true)");
        await writer.query("update custom_field_defs set label='Committed while editor waited',updated_at=updated_at+interval '1 microsecond' where id=$1", [id]);
        const pid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
        pending = patch({ label: 'Stale waiting editor' }); void pending.catch(() => {});
        let blocked = false;
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          if ((await writer.query<{ blocked: boolean }>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked', [pid])).rows[0]!.blocked) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.ok(blocked); await writer.query('commit'); assert.equal((await pending).status, 409);
        assert.equal((await row()).label, 'Committed while editor waited');
        return;
      }
      if (scenario === 'stale revision') await db.execute(sql`update custom_field_defs set updated_at=updated_at+interval '1 microsecond' where id=${id}`);
      if (scenario === 'permission denied') await db.execute(sql`update app_roles set permissions='[]'::jsonb where org_id=${org.orgId}`);
      const before = await snapshot();
      const bodies: Record<string, Record<string, unknown>> = {
        'missing revision': { expectedUpdatedAt: undefined }, 'truncated revision': { expectedUpdatedAt: revision.replace(/(\.\d{3})\d{3}Z$/, '$1Z') },
        'malformed revision': { expectedUpdatedAt: 'invalid' }, 'foreign definition': { id: foreignId }, 'invalid id': { id: 'not-a-uuid' },
      };
      const response = await patch({ label: 'Rejected change', ...bodies[scenario] });
      assert.equal(response.status, scenario === 'permission denied' ? 403 : scenario === 'foreign definition' || scenario === 'invalid id' ? 404 : 409);
      assert.deepEqual(await snapshot(), before);
    } finally {
      if (connected) await writer.query('rollback').catch(() => {});
      if (pending) await pending.catch(() => {});
      if (connected) await writer.end();
      if (cleanup) await cleanup();
      state.user = null;
      if (foreignOrg) await dropScratchOrg(foreignOrg.orgId);
      await dropScratchOrg(org.orgId);
    }
  });
}
