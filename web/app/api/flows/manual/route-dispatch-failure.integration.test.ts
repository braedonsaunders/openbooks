import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

/**
 * Manual flow actions must surface failures instead of toasting success.
 *
 *   run-level failure (a flow ran and failed, e.g. zero assignees) → the
 *   action answers 200 ok:false WITH the failing flow's reason, so the
 *   surface shows the cause instead of a generic somethingWentWrong;
 *   dispatch-level failure (runRecordFlows threw before any flow ran, so
 *   runs:[] carries no verdict) → non-2xx with the dispatch reason, never
 *   200 ok:true.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __manualFlowUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__manualFlowUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, seedDraftDocument, seedFlowActors } =
  await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route')

const postRequest = (body: unknown) =>
  new Request('http://manual.local/api/flows/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

function asSuperAdmin(id: string, orgId: string): SessionUser {
  return {
    id, orgId, name: 'owner', email: 'owner@scratch.test', roles: [], isSuperAdmin: true,
    envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: id,
  }
}

async function enableFlows(orgId: string): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update orgs set settings = jsonb_set(
        settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"flows":true}'::jsonb, true)
      where id = ${orgId}`),
  )
}

/** A manual button wired to a gate that resolves to zero approvers. */
async function seedFailingManualFlow(orgId: string): Promise<void> {
  const graph = {
    schemaVersion: 1,
    nodes: [
      {
        id: 'trigger', position: { x: 0, y: 0 },
        data: { kind: 'trigger', trigger: { trigger: 'manual', buttonId: 'probe', label: 'Probe' } },
      },
      {
        id: 'gate', position: { x: 220, y: 0 },
        data: {
          kind: 'gate',
          gate: {
            title: 'Manual approval',
            assignees: [{ type: 'role', role: 'nonexistent_role' }],
            mode: 'any',
          },
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'gate', sourceHandle: 'next' }],
  }
  await withBypassContext(() =>
    db.execute(sql`
      insert into flows (id, org_id, name, subject_kind, enabled, graph)
      values (${randomUUID()}, ${orgId}, 'Manual probe flow', 'vendor_bill', true,
              ${JSON.stringify(graph)}::jsonb)`),
  )
}

test('a manual action whose flow fails answers ok:false with the flow reason', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId))
    await enableFlows(org.orgId)
    await seedFailingManualFlow(org.orgId)
    const docId = await withBypassContext(() =>
      seedDraftDocument(org.orgId, { kind: 'vendor_bill', createdBy: actors.submitterId }))
    state.user = asSuperAdmin(actors.adminId, org.orgId)

    const res = await withOrgContext(org.orgId, () =>
      POST(postRequest({ subjectKind: 'vendor_bill', subjectId: docId, buttonId: 'probe' })))
    assert.equal(res.status, 200)
    const body = (await res.json()) as { ok: boolean; error?: string }
    assert.equal(body.ok, false, 'the failed run must not read as success')
    assert.ok(body.error, 'the run-level failure carries its reason')
    assert.match(body.error, /Manual probe flow/, 'the reason names the failing flow')
    assert.match(body.error, /zero assignees/, 'the reason names the cause')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('a manual action whose dispatch fails answers non-2xx with the dispatch reason', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId))
    await enableFlows(org.orgId)
    await seedFailingManualFlow(org.orgId)
    const docId = await withBypassContext(() =>
      seedDraftDocument(org.orgId, { kind: 'vendor_bill', createdBy: actors.submitterId }))
    state.user = asSuperAdmin(actors.adminId, org.orgId)

    // Abort every flow_runs insert: the dispatch throws before any flow runs,
    // so the result carries runs:[] with failed:true — the exact shape the
    // route used to report as 200 ok:true.
    await withBypassContext(() => db.execute(sql.raw(`
      create or replace function public.manual_probe_abort() returns trigger
        language plpgsql as $$ begin raise exception 'manual-test fault'; end; $$;
      create trigger manual_probe_abort_flow_runs
        before insert on public.flow_runs for each row
        execute function public.manual_probe_abort()`)))
    try {
      const res = await withOrgContext(org.orgId, () =>
        POST(postRequest({ subjectKind: 'vendor_bill', subjectId: docId, buttonId: 'probe' })))
      assert.ok(res.status >= 500, `dispatch failure must not be 2xx, got ${res.status}`)
      const body = (await res.json()) as { error?: string }
      assert.match(body.error ?? '', /manual-test fault/, 'the dispatch reason reaches the operator')
    } finally {
      await withBypassContext(() => db.execute(sql.raw(`
        drop trigger if exists manual_probe_abort_flow_runs on public.flow_runs;
        drop function if exists public.manual_probe_abort()`)))
    }
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
