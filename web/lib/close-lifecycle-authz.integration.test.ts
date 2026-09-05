import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from './auth'

const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __closeLifecycleUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__closeLifecycleUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { startCloseRun } = await import('@openbooks/engine/src/close.ts')
const { POST: create } = await import('../app/api/close/runs/route')
const { POST: action } = await import('../app/api/close/runs/[id]/route')
const { GET: binder } = await import('../app/api/close/runs/[id]/binder/route')
const { POST: task } = await import('../app/api/close/runs/[id]/tasks/[taskId]/route')
const { POST: evidence } = await import('../app/api/close/runs/[id]/evidence/route')
const { POST: setup } = await import('../app/api/admin/close/route')
const { default: page } = await import('../app/(app)/close/page')
const applicationClose = await import('./application/close')
const { getAuthz } = await import('./authz')
const { accountingHome } = await import('./module-home/accounting')
const { CloseSetupPage } = await import('../app/(app)/admin/setup/[entity]/CloseSetupPage')
const { READ_TOOLS } = await import('./assistant/tools')
const request = (body: unknown) => new Request('http://audit.local', { method: 'POST', body: JSON.stringify(body) })

for (const boundary of ['creation', 'actions', 'task', 'evidence', 'binder', 'page', 'setup', 'locks', 'application', 'cockpit', 'assistant', 'setup page'] as const) {
  test(`close lifecycle scope: ${boundary}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await withBypassContext(() => createScratchOrg())
    try {
      const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Close auditor', 'close_auditor'))
      const other = randomUUID()
      await withBypassContext(async () => {
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`)
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb) || '{"multiSubsidiary":true,"continuousClose":true,"advancedClose":true}'::jsonb) where id=${org.orgId}`)
        await db.execute(sql`update app_roles set permissions='["close.read","close.run","close.approve","close.reopen","periods.manage"]'::jsonb, subsidiary_restriction=${JSON.stringify({mode:'list',subsidiaryIds:[org.subsidiaryId]})}::jsonb where org_id=${org.orgId} and key='close_auditor'`)
      })
      state.user = { id:actor, orgId:org.orgId, name:'Close auditor', email:'close@scratch.test', roles:[], isSuperAdmin:false, envKind:'production', productionOrgId:org.orgId, homeOrgId:org.orgId, homeUserId:actor }
      // Even a declared single-entity run currently contains org-wide diagnostics.
      const runId = await withBypassContext(() => startCloseRun({orgId:org.orgId, periodId:org.periodId, bookId:org.bookId, actorId:actor, subsidiaryIds:[org.subsidiaryId]}))
      const taskId = await withBypassContext(async () => (await db.execute<{id:string}>(sql`select id from close_run_tasks where run_id=${runId} and org_id=${org.orgId} order by sort_order limit 1`)).rows[0]!.id)
      const params = { params: Promise.resolve({id:runId, taskId}) }
      const target = {periodId:org.periodId,bookId:org.bookId}
      await withOrgContext(org.orgId, async () => {
        if (boundary === 'creation') assert.equal((await create(request(target))).status,404)
        if (boundary === 'actions') {
          for (const verb of ['refresh','request_approval','attest','close','publish']) assert.equal((await action(request({action:verb}),params)).status,404,verb)
        }
        if (boundary === 'task') assert.equal((await task(request({action:'start'}),params)).status,404)
        if (boundary === 'evidence') assert.equal((await evidence(request({taskId,evidenceType:'note',label:'Unauthorized note',snapshot:{note:'test'}}),params)).status,404)
        if (boundary === 'binder') {
          await withBypassContext(() => db.execute(sql`update close_runs set status='published',binder_snapshot='{"sensitive":true}'::jsonb,binder_hash=${'a'.repeat(64)} where id=${runId} and org_id=${org.orgId}`))
          assert.equal((await binder(request({}),params)).status,404)
        }
        if (boundary === 'page') await assert.rejects(page({searchParams:Promise.resolve({run:runId})}), /NEXT_HTTP_ERROR_FALLBACK;404/)
        if (boundary === 'setup') {
          for (const verb of ['save-calendar','generate-periods','save-blueprint','save-policy','save-automation','save-package','send-package','request-reopen','decide-reopen','reclose-reopen']) {
            assert.equal((await setup(request({...target,action:verb,modules:['gl'],reason:'Audit',requestId:randomUUID()}))).status,404,verb)
          }
        }
        if (boundary === 'setup page') await assert.rejects(CloseSetupPage({orgId:org.orgId,searchParams:{},canReopen:true}), /NEXT_HTTP_ERROR_FALLBACK;404/)
        if (boundary === 'cockpit') assert.equal((await accountingHome(org.orgId,new Set([org.subsidiaryId]))).close.runId,null)
        if (boundary === 'assistant') {
          const authz = (await getAuthz())!
          const output = await READ_TOOLS.find((tool)=>tool.name === 'financial_periods')!.execute({completedOnly:false},authz)
          assert.equal(output.ok,true)
          const data = output.data as {periods:{closeStatus:string|null;readinessScore:number|null}[]}
          assert.ok(data.periods.length>0)
          assert.ok(data.periods.every((period)=>period.closeStatus === null && period.readinessScore === null))
        }
        if (boundary === 'application') {
          const context = {authz:(await getAuthz())!,source:'mcp' as const,requestId:randomUUID(),apiKeyId:null}
          assert.deepEqual(await applicationClose.listCloseRuns(context,{}),[])
          await assert.rejects(applicationClose.getCloseRun(context,runId),{status:403})
          await assert.rejects(applicationClose.startApplicationCloseRun(context,{...target,subsidiaryIds:[org.subsidiaryId],idempotencyKey:randomUUID()}),{status:403})
          await assert.rejects(applicationClose.advanceCloseRun(context,{runId,action:'refresh',idempotencyKey:randomUUID()}),{status:403})
          await assert.rejects(applicationClose.createReopenRequest(context,{...target,subsidiaryId:org.subsidiaryId,modules:['gl'],reason:'Review',idempotencyKey:randomUUID()}),{status:403})
          await assert.rejects(applicationClose.decideReopenRequest(context,{requestId:randomUUID(),approve:true,idempotencyKey:randomUUID()}),{status:403})
        }
        if (boundary === 'locks') {
          const lock = {...target,action:'set-lock',module:'gl',state:'soft_closed',reason:'Review in progress'}
          for (const subsidiaryId of [null,other]) assert.equal((await setup(request({...lock,subsidiaryId}))).status,404)
          assert.equal((await setup(request({...lock,subsidiaryId:org.subsidiaryId}))).status,200)
        }
      })
      // Current permissions are consulted again: unrestricted operators retain
      // the workflow, and subsequent scope revocation cannot replay a binder.
      await withBypassContext(() => db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and key='close_auditor'`))
      await withOrgContext(org.orgId, async () => {
        if (boundary === 'creation') assert.equal((await create(request(target))).status,200)
        if (boundary === 'actions') assert.equal((await action(request({action:'refresh'}),params)).status,200)
        if (boundary === 'application') {
          const context = {authz:(await getAuthz())!,source:'mcp' as const,requestId:randomUUID(),apiKeyId:null}
          assert.equal((await applicationClose.listCloseRuns(context,{}))[0]?.id,runId)
          assert.equal((await applicationClose.getCloseRun(context,runId)).id,runId)
        }
        if (boundary === 'binder') {
          const result = await binder(request({}),params)
          assert.equal(result.status,200)
          assert.equal(result.headers.get('cache-control'),'private, no-store')
          assert.deepEqual((await result.json()).binder,{sensitive:true})
          await withBypassContext(() => db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify({mode:'list',subsidiaryIds:[]})}::jsonb where org_id=${org.orgId} and key='close_auditor'`))
          assert.equal((await binder(request({}),params)).status,404)
        }
      })
      const persisted = await withBypassContext(() => db.execute<{n:number}>(sql`select count(*)::int as n from close_task_evidence where run_id=${runId} and org_id=${org.orgId}`))
      assert.equal(persisted.rows[0]!.n,0)
    } finally {
      state.user=null
      await withBypassContext(() => dropScratchOrg(org.orgId))
    }
  })
}
