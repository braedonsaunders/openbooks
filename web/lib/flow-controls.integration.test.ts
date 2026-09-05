import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import pg from "pg";
import type { SessionUser } from "./auth";
const root = pathToFileURL(process.cwd() + "/").href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __flowControls: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "./auth" && context.parentURL?.endsWith('/authz.ts')) return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__flowControls.user}" };
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context);
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, env, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { documentRevisionSql, isDocumentRevisionToken } = await import("@openbooks/engine/src/document-revision.ts");
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { GET, PATCH, DELETE } = await import("../app/api/admin/flows/[id]/route");
const { GET: LIST } = await import("../app/api/admin/flows/route");

const scenarios = ["exact read", "missing patch revision", "truncated patch revision", "stale patch", "missing delete revision", "stale delete", "current patch", "unused delete", "execution history", "open gate", "gate race", "enable race", "string false", "numeric flag", "object flag", "array flag"] as const;
for (const scenario of scenarios) {
  test(`flow configuration controls: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    const writer = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
    let connected = false;
    let pending: Promise<Response> | undefined;
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"flows":true}'::jsonb) where id=${org.orgId}`);
      state.user = { id: actor, orgId: org.orgId, homeUserId: actor, homeOrgId: org.orgId, productionOrgId: org.orgId, envKind: 'production', name: 'Flow reviewer', email: 'flow@scratch.test', roles: [], isSuperAdmin: false };
      const id = randomUUID();
      const graph = { schemaVersion: 1, nodes: [
        { id: 'trigger', position: { x: 0, y: 0 }, data: { kind: 'trigger', trigger: { trigger: 'on_submit' } } },
        { id: 'gate', position: { x: 1, y: 0 }, data: { kind: 'gate', gate: { title: 'Approval', assignees: [{ type: 'user', userId: actor }], mode: 'any' } } },
      ], edges: [{ id: 'edge', source: 'trigger', target: 'gate', sourceHandle: 'next' }] };
      await db.execute(sql`insert into flows(id,org_id,name,subject_kind,enabled,graph,updated_at) values (${id},${org.orgId},'Reviewed flow','vendor_bill',false,${JSON.stringify(graph)}::jsonb,date_trunc('second',now()+interval '1 day')+interval '123450 microseconds')`);
      const revision = (await db.execute<{ revision: string }>(sql`select ${documentRevisionSql(sql`updated_at`)} as revision from flows where id=${id}`)).rows[0]!.revision;
      const params = { params: Promise.resolve({ id }) };
      const request = (method: string, body: unknown) => new Request(`http://audit.local/api/admin/flows/${id}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const patch = (body: unknown) => withOrgContext(org.orgId, () => PATCH(request('PATCH', body), params));
      const remove = (body: unknown) => withOrgContext(org.orgId, () => DELETE(request('DELETE', body), params));
      const snapshot = async () => (await db.execute(sql`select to_jsonb(f) as flow, (select count(*)::int from audit_log where org_id=${org.orgId} and table_name='flows' and row_id=${id}) as audits from flows f where id=${id}`)).rows;
      if (scenario === 'exact read') {
        const detail = await withOrgContext(org.orgId, () => GET(new Request('http://audit.local'), params));
        assert.equal((await detail.json()).flow.updated_at, revision);
        const list = await withOrgContext(org.orgId, () => LIST());
        assert.equal((await list.json()).flows.find((flow: { id: string }) => flow.id === id).updated_at, revision);
        return;
      }
      if (scenario.includes('stale')) await db.execute(sql`update flows set name='Concurrent editor',updated_at=updated_at+interval '1 microsecond' where id=${id}`);
      if (['execution history','open gate','gate race'].includes(scenario)) {
        const runId = randomUUID(), subjectId = randomUUID();
        await db.execute(sql`insert into flow_runs(id,org_id,flow_id,subject_kind,subject_id,trigger,status,context) values (${runId},${org.orgId},${id},'vendor_bill',${subjectId},'on_submit','completed','{"evidence":"retained"}'::jsonb)`);
        const insertGate = () => writer.query("insert into flow_gates(org_id,flow_id,run_id,node_id,subject_kind,subject_id,title,assignee_user_id,group_key,status) values ($1,$2,$3,'gate','vendor_bill',$4,'Pending approval',$5,'group','pending')", [org.orgId,id,runId,subjectId,actor]);
        await writer.connect(); connected = true;
        await writer.query('begin'); await writer.query("select set_config('app.bypass_rls','on',true)");
        if (scenario === 'gate race') {
          await writer.query('select id from flows where id=$1 for key share', [id]);
          await writer.query('lock table flow_gates in share mode');
          const pid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
          pending = remove({ expectedUpdatedAt: revision }); void pending.catch(() => {});
          let blocked = false;
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const waiting = await writer.query<{ blocked: boolean }>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked', [pid]);
            if (waiting.rows[0]!.blocked) { blocked = true; break; }
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          assert.ok(blocked);
          await insertGate();
          await writer.query('commit');
        } else {
          if (scenario === 'open gate') await insertGate();
          await writer.query('commit');
        }
        const response = pending ? await pending : await remove({ expectedUpdatedAt: revision });
        assert.equal(response.status,409);
        assert.equal((await db.execute(sql`select id from flow_runs where id=${runId}`)).rows.length,1);
        assert.equal((await db.execute(sql`select id from flows where id=${id}`)).rows.length,1);
        if (scenario !== 'execution history') assert.equal((await db.execute(sql`select id from flow_gates where run_id=${runId} and status='pending'`)).rows.length,1);
        return;
      }
      if (scenario === 'enable race') {
        const outcomes = await Promise.all([patch({ expectedUpdatedAt: revision, enabled: true }), patch({ expectedUpdatedAt: revision, graph: { schemaVersion: 1, nodes: [], edges: [] } })]);
        assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), [200,409]);
        return;
      }
      const before = await snapshot();
      if (scenario === 'unused delete') { assert.equal((await remove({ expectedUpdatedAt: revision })).status,200); return; }
      if (scenario === 'current patch') {
        const response = await patch({ expectedUpdatedAt: revision, name: 'Saved flow' });
        assert.equal(response.status,200);
        const body = await response.json(); assert.ok(isDocumentRevisionToken(body.updatedAt)); assert.ok(body.updatedAt > revision);
        assert.equal((await patch({ expectedUpdatedAt: revision, name: 'Stale replay' })).status,409);
        return;
      }
      const flags: Record<string, unknown> = { 'string false': 'false', 'numeric flag': 0, 'object flag': {}, 'array flag': [] };
      const invalidFlag = scenario in flags;
      const expectedUpdatedAt = scenario.includes('missing') ? undefined : scenario.includes('truncated') ? revision.replace(/(\.\d{3})\d{3}Z$/, '$1Z') : revision;
      const response = scenario.includes('delete') ? await remove({ expectedUpdatedAt }) : await patch({ expectedUpdatedAt, ...(invalidFlag ? { enabled: flags[scenario] } : { name: 'Unreviewed edit' }) });
      assert.equal(response.status, invalidFlag ? 400 : 409);
      assert.deepEqual(await snapshot(), before);
    } finally {
      if (connected) await writer.query('rollback').catch(() => {});
      if (pending) await pending.catch(() => {});
      if (connected) await writer.end();
      state.user = null;
      await dropScratchOrg(org.orgId);
    }
  });
}
