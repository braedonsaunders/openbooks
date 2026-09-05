import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from './auth'

const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __domainBoundaryUser: state })
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent(source),
})
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server')
      return virtual(
        'export async function getTranslations(){ return (key)=>key }; export async function getLocale(){return "en"}',
      )
    if (
      (specifier === './auth' || specifier.endsWith('/lib/auth')) &&
      context.parentURL?.endsWith('/web/lib/authz.ts')
    ) {
      return virtual(
        'export async function currentUser(){ return globalThis.__domainBoundaryUser.user }',
      )
    }
    if (specifier.startsWith('@/'))
      return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } =
  await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import('@openbooks/engine/src/test-fixtures.ts')
const { computeProvisionRun, getProvisionRun } =
  await import('@openbooks/engine/src/income-tax-provision.ts')
const { createPlanVersion, publishPlanVersion, activateLifecycle } =
  await import('@openbooks/engine/src/advanced-subscriptions.ts')
const { postDocument } = await import('@openbooks/engine/src/posting.ts')
const { getAuthz } = await import('./authz')
const { POST: consolidate } = await import('../app/api/consolidation/route')
const { GET: provisions, POST: compute } =
  await import('../app/api/tax/provisions/route')
const { POST: postProvision } =
  await import('../app/api/tax/provisions/[id]/post/route')
const { GET: subscriptions, POST: amend } =
  await import('../app/api/subscriptions/advanced/route')
const { GET: forecast, POST: saveForecast } =
  await import('../app/api/crm/forecasts/route')
const { POST: depreciate } =
  await import('../app/api/assets/run-depreciation/route')
const { GET: returnPreview } =
  await import('../app/api/tax/returns/[code]/route')
const { GET: returnExport } =
  await import('../app/api/tax/returns/[code]/export/route')
const { POST: prepareFiling } = await import('../app/api/tax/filings/route')
const { GET: filingExport } =
  await import('../app/api/tax/filings/[id]/export/route')
const { addCalendarDays } =
  await import('@openbooks/engine/src/business-date.ts')
const { customersHome } = await import('./module-home/customers')
const { ensureCrmDefaults } = await import('@openbooks/engine/src/crm.ts')
const { GET: opportunityRead, PATCH: opportunityEdit } =
  await import('../app/api/crm/opportunities/[id]/route')
const { POST: estimate } =
  await import('../app/api/crm/opportunities/[id]/estimate/route')
const { GET: accountRead, PATCH: accountEdit } =
  await import('../app/api/crm/accounts/[id]/route')
const {
  GET: activityRead,
  PATCH: activityEdit,
  DELETE: activityDelete,
} = await import('../app/api/crm/activities/[id]/route')
const { POST: activityDraft } =
  await import('../app/api/crm/activities/draft/route')
const { NextRequest } = await import('next/server')
const request = (body: unknown) =>
  new Request('http://audit.local', {
    method: 'POST',
    body: JSON.stringify(body),
  })

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() =>
      createScratchUser(org.orgId, 'Domain auditor', 'domain_auditor'),
    )
    const other = randomUUID()
    await withBypassContext(async () => {
      await db.execute(
        sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`,
      )
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb) || '{"multiSubsidiary":true,"fixedAssets":true,"crm":true,"subscriptionBilling":true,"advancedSubscriptions":true,"orders":true}'::jsonb) where id=${org.orgId}`,
      )
      await db.execute(
        sql`update app_roles set permissions='["close.run","reports.read","reports.create","gl.post","ar.read","ar.create","assets.manage","crm.forecasts.read","crm.forecasts.manage","compliance.file","crm.opportunities.read","crm.opportunities.manage","crm.accounts.read","crm.accounts.manage","crm.activities.read","crm.activities.manage"]'::jsonb, subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb where org_id=${org.orgId} and key='domain_auditor'`,
      )
    })
    state.user = {
      id: actor,
      orgId: org.orgId,
      name: 'Domain auditor',
      email: 'auditor@scratch.test',
      roles: [],
      isSuperAdmin: false,
      envKind: 'production',
      productionOrgId: org.orgId,
      homeOrgId: org.orgId,
      homeUserId: actor,
    }
    return { org, actor, other }
  } catch (e) {
    await withBypassContext(() => dropScratchOrg(org.orgId))
    throw e
  }
}

for (const boundary of [
  'consolidation',
  'provision list',
  'provision compute',
  'provision post',
  'provision manual entities',
  'subscription read',
  'subscription activate',
  'subscription amend',
  'subscription allowed and replay',
  'forecast actuals',
  'forecast snapshots',
  'CRM opportunity detail and edit',
  'CRM account detail and edit',
  'CRM linked documents',
  'CRM pipeline entity',
  'CRM activity relationships',
  'depreciation date',
  'tax transports',
] as const) {
  test(
    `cross-domain authorization: ${boundary}`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      const { org, actor, other } = await fixture()
      try {
        await withOrgContext(org.orgId, async () => {
          const authz = await getAuthz()
          assert.ok(authz)
          assert.deepEqual([...authz.allowedSubsidiaryIds!], [org.subsidiaryId])
          if (boundary.startsWith('CRM')) {
            await ensureCrmDefaults(org.orgId, actor)
            const status = (
              await db.execute<{ id: string }>(
                sql`select id from crm_opportunity_statuses where org_id=${org.orgId} and is_default and is_active limit 1`,
              )
            ).rows[0]!.id
            const id = randomUUID()
            const target =
              boundary === 'CRM opportunity detail and edit'
                ? other
                : org.subsidiaryId
            await db.execute(
              sql`insert into crm_opportunities(id,org_id,opportunity_number,title,party_id,subsidiary_id,status_id,currency,projected_amount,weighted_amount,expected_close_date,created_by,updated_by) values (${id},${org.orgId},${id},'Scoped opportunity',${org.customerId},${target},${status},'CAD','100','100',${org.date},${actor},${actor})`,
            )
            const params = { params: Promise.resolve({ id }) }
            if (boundary === 'CRM activity relationships') {
              await db.execute(
                sql`update crm_opportunities set subsidiary_id=${other} where id=${id}`,
              )
              const draft = () =>
                activityDraft(
                  new NextRequest('http://audit.local', {
                    method: 'POST',
                    body: JSON.stringify({
                      subjectKind: 'opportunity',
                      subjectId: id,
                    }),
                  }),
                )
              assert.equal((await draft()).status, 404)
              await restrict(org.orgId, null)
              const created = await draft()
              assert.equal(created.status, 200)
              const activityId = (await created.json()).id
              const activityParams = {
                params: Promise.resolve({ id: activityId }),
              }
              await restrict(org.orgId, [org.subsidiaryId])
              assert.equal(
                (await activityRead(request({}), activityParams)).status,
                404,
              )
              assert.equal(
                (
                  await activityEdit(
                    request({ subject: 'Unauthorized' }),
                    activityParams,
                  )
                ).status,
                404,
              )
              assert.equal(
                (await activityDelete(request({}), activityParams)).status,
                404,
              )
              await restrict(org.orgId, null)
              assert.equal(
                (await activityRead(request({}), activityParams)).status,
                200,
              )
              assert.equal(
                (
                  await activityEdit(
                    request({ subject: 'Authorized' }),
                    activityParams,
                  )
                ).status,
                200,
              )
              assert.equal(
                (await activityDelete(request({}), activityParams)).status,
                200,
              )
            } else if (boundary === 'CRM opportunity detail and edit') {
              assert.equal(
                (await opportunityRead(request({}), params)).status,
                404,
              )
              assert.equal(
                (
                  await opportunityEdit(
                    request({ title: 'Unauthorized' }),
                    params,
                  )
                ).status,
                404,
              )
              assert.equal((await estimate(request({}), params)).status, 404)
              await restrict(org.orgId, null)
              assert.equal(
                (await opportunityRead(request({}), params)).status,
                200,
              )
              const edited = await opportunityEdit(
                request({ title: 'Authorized' }),
                params,
              )
              assert.equal(
                edited.status,
                200,
                JSON.stringify(await edited.json()),
              )
            } else if (boundary === 'CRM account detail and edit') {
              await db.execute(
                sql`insert into crm_account_profiles(org_id,party_id,lifecycle_stage,created_by,updated_by) values (${org.orgId},${org.customerId},'customer',${actor},${actor}) on conflict do nothing`,
              )
              await db.execute(
                sql`update parties set subsidiary_id=${other} where id=${org.customerId}`,
              )
              const accountParams = {
                params: Promise.resolve({ id: org.customerId }),
              }
              assert.equal(
                (await accountRead(request({}), accountParams)).status,
                404,
              )
              assert.equal(
                (
                  await accountEdit(
                    request({ qualificationScore: 10 }),
                    accountParams,
                  )
                ).status,
                404,
              )
              await restrict(org.orgId, null)
              assert.equal(
                (await accountRead(request({}), accountParams)).status,
                200,
              )
              assert.equal(
                (
                  await accountEdit(
                    request({ qualificationScore: 10 }),
                    accountParams,
                  )
                ).status,
                200,
              )
            } else if (boundary === 'CRM linked documents') {
              const doc = randomUUID()
              await db.execute(
                sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,total,created_by) values (${doc},${org.orgId},'customer_invoice','draft',${doc},${other},${org.customerId},${org.date},'CAD','900',${actor})`,
              )
              await db.execute(
                sql`insert into crm_opportunity_documents(org_id,opportunity_id,document_id,created_by,updated_by) values (${org.orgId},${id},${doc},${actor},${actor})`,
              )
              const visible = await opportunityRead(request({}), params)
              assert.equal(visible.status, 200)
              assert.deepEqual((await visible.json()).documents, [])
              await restrict(org.orgId, null)
              assert.equal(
                (await (await opportunityRead(request({}), params)).json())
                  .documents.length,
                1,
              )
            } else {
              const read = () =>
                forecast(
                  new NextRequest(
                    `http://audit.local?periodStart=${org.date}&periodEnd=${org.date}`,
                  ),
                )
              assert.equal(
                (await (await read()).json()).forecast[0].pipeline_amount,
                '100.0000',
              )
              await db.execute(
                sql`update crm_opportunities set subsidiary_id=${other} where id=${id}`,
              )
              const hidden = await (await read()).json()
              assert.ok(
                hidden.forecast.every(
                  (row: { pipeline_amount: string }) =>
                    row.pipeline_amount === '0.0000',
                ),
              )
            }
          } else if (boundary === 'consolidation') {
            assert.equal(
              (
                await consolidate(
                  request({ action: 'derive-rates', periodId: org.periodId }),
                )
              ).status,
              404,
            )
          } else if (boundary.startsWith('provision')) {
            await db.execute(
              sql`insert into income_tax_rates(org_id,jurisdiction,rate_percent,effective_from) values (${org.orgId},'Audit rate','20','2000-01-01')`,
            )
            const id = await computeProvisionRun(
              org.orgId,
              Number(org.date.slice(0, 4)),
              {
                permanentDifferences: [
                  { description: 'Root', amount: '100' },
                  ...(boundary === 'provision manual entities'
                    ? []
                    : [
                        {
                          description: 'Hidden',
                          amount: '200',
                          subsidiaryId: other,
                        },
                      ]),
                ],
                ...(boundary === 'provision manual entities'
                  ? {
                      entities: {
                        [other]: {
                          permanentDifferences: [
                            { description: 'Hidden', amount: '200' },
                          ],
                        },
                      },
                    }
                  : {}),
              },
              actor,
            )
            if (boundary === 'provision manual entities') {
              const all = await getProvisionRun(org.orgId, id)
              assert.equal(all!.totalExpense, '60.0000')
            } else if (boundary === 'provision list') {
              const own = await getProvisionRun(
                org.orgId,
                id,
                authz.allowedSubsidiaryIds,
              )
              assert.ok(own)
              assert.equal(own.totalExpense, '20.0000')
              const result = await (await provisions()).json()
              assert.equal(
                result.runs[0].totalExpense,
                own.totalExpense,
                'list must show the same scoped total as detail',
              )
              await restrict(org.orgId, [])
              assert.deepEqual((await (await provisions()).json()).runs, [])
              await restrict(org.orgId, null)
              assert.equal(
                (await (await provisions()).json()).runs[0].totalExpense,
                '60.0000',
              )
            } else if (boundary === 'provision compute') {
              assert.equal(
                (
                  await compute(
                    request({ fiscalYear: Number(org.date.slice(0, 4)) }),
                  )
                ).status,
                404,
              )
            } else {
              assert.equal(
                (
                  await postProvision(request({}), {
                    params: Promise.resolve({ id }),
                  })
                ).status,
                404,
              )
            }
          } else if (boundary.startsWith('subscription')) {
            const planId = randomUUID(),
              subscriptionId = randomUUID()
            await db.execute(
              sql`update parties set subsidiary_id=${other} where id=${org.customerId} and org_id=${org.orgId}`,
            )
            await db.execute(
              sql`insert into subscription_plans(id,org_id,name,amount,currency_code,interval,interval_count,income_account_id,created_by) values (${planId},${org.orgId},'Hidden plan','100','CAD','monthly',1,${org.accounts.revenue},${actor})`,
            )
            const versionId = await createPlanVersion(org.orgId, actor, {
              planId,
              effectiveFrom: org.date,
              components: [
                {
                  componentKey: 'base',
                  name: 'Hidden component',
                  unitPrice: '100',
                  incomeAccountId: org.accounts.revenue,
                },
              ],
            })
            await publishPlanVersion(org.orgId, actor, versionId)
            await db.execute(
              sql`insert into subscriptions(id,org_id,customer_id,plan_id,quantity,status,start_on,next_bill_on,auto_post,created_by) values (${subscriptionId},${org.orgId},${org.customerId},${planId},'1','active',${org.date},${org.date},false,${actor})`,
            )
            if (boundary === 'subscription allowed and replay') {
              await db.execute(
                sql`update parties set subsidiary_id=${org.subsidiaryId} where id=${org.customerId}`,
              )
              assert.equal(
                (
                  await amend(
                    request({
                      action: 'activateLifecycle',
                      subscriptionId,
                      planVersionId: versionId,
                      termStartsOn: org.date,
                    }),
                  )
                ).status,
                200,
              )
              const body = {
                action: 'amend',
                subscriptionId,
                type: 'change_component',
                componentKey: 'base',
                quantity: '2',
                effectiveOn: addCalendarDays(org.date, 1),
                idempotencyKey: randomUUID(),
              }
              const sameDay = await amend(
                request({ ...body, effectiveOn: org.date }),
              )
              assert.equal(sameDay.status, 422)
              assert.equal((await amend(request(body))).status, 201)
              assert.equal((await amend(request(body))).status, 200)
              assert.equal(
                (await (await subscriptions()).json()).lifecycles.length,
                1,
              )
              await restrict(org.orgId, [])
              assert.equal((await amend(request(body))).status, 404)
              assert.equal(
                (await (await subscriptions()).json()).lifecycles.length,
                0,
              )
              await restrict(org.orgId, null)
              assert.equal((await amend(request(body))).status, 200)
            } else if (boundary === 'subscription activate') {
              assert.equal(
                (
                  await amend(
                    request({
                      action: 'activateLifecycle',
                      subscriptionId,
                      planVersionId: versionId,
                      termStartsOn: org.date,
                    }),
                  )
                ).status,
                404,
              )
            } else {
              await activateLifecycle(org.orgId, actor, {
                subscriptionId,
                planVersionId: versionId,
                termStartsOn: org.date,
              })
              if (boundary === 'subscription read') {
                const result = await (await subscriptions()).json()
                assert.equal(result.lifecycles.length, 0)
              } else {
                assert.equal(
                  (
                    await amend(
                      request({
                        action: 'amend',
                        subscriptionId,
                        type: 'change_component',
                        componentKey: 'base',
                        quantity: '2',
                        effectiveOn: addCalendarDays(org.date, 1),
                        idempotencyKey: randomUUID(),
                      }),
                    )
                  ).status,
                  404,
                )
              }
            }
          } else if (boundary === 'forecast snapshots') {
            const body = { periodStart: org.date, periodEnd: org.date }
            const req = () =>
              new NextRequest('http://audit.local', {
                method: 'POST',
                body: JSON.stringify(body),
              })
            const read = () =>
              forecast(
                new NextRequest(
                  `http://audit.local?periodStart=${org.date}&periodEnd=${org.date}`,
                ),
              )
            assert.equal((await saveForecast(req())).status, 404)
            await restrict(org.orgId, null)
            assert.equal((await saveForecast(req())).status, 201)
            await db.execute(
              sql`insert into crm_forecast_snapshots(org_id,owner_user_id,period_start,period_end,snapshot_kind,currency,pipeline_amount,weighted_amount,worst_case_amount,most_likely_amount,upside_amount,closed_amount,created_by,updated_by) values (${org.orgId},${actor},${org.date},${org.date},'calculated','CAD','0','0','0','0','0','0',${actor},${actor})`,
            )
            assert.equal((await (await read()).json()).snapshots.length, 1)
            await restrict(org.orgId, [org.subsidiaryId])
            assert.deepEqual((await (await read()).json()).snapshots, [])
          } else if (boundary === 'forecast actuals') {
            await db.execute(
              sql`insert into party_subsidiaries(org_id,party_id,subsidiary_id) values (${org.orgId},${org.customerId},${other})`,
            )
            for (const [sub, amount] of [
              [org.subsidiaryId, '100'],
              [other, '900'],
            ]) {
              const id = randomUUID()
              await db.execute(
                sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,posting_date,currency,fx_rate,subtotal,tax_total,total,created_by) values (${id},${org.orgId},'customer_invoice','draft',${id},${sub},${org.customerId},${org.date},${org.date},'CAD','1',${amount},'0',${amount},${actor})`,
              )
              await db.execute(
                sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount) values (${org.orgId},${id},1,${org.accounts.revenue},'1',${amount},${amount},'0','0')`,
              )
              await db.execute(
                sql`update documents set status='approved' where id=${id} and org_id=${org.orgId}`,
              )
              await postDocument(id, {
                control: {
                  ar: org.accounts.ar,
                  ap: org.accounts.ap,
                  bank: org.accounts.bank,
                },
              })
            }
            const response = await forecast(
              new NextRequest(
                `http://audit.local?periodStart=${org.date}&periodEnd=${org.date}`,
              ),
            )
            const result = await response.json()
            assert.equal(result.forecast[0].closed_amount, '100.0000')
            await restrict(org.orgId, [])
            const empty = await (
              await forecast(
                new NextRequest(
                  `http://audit.local?periodStart=${org.date}&periodEnd=${org.date}`,
                ),
              )
            ).json()
            assert.ok(
              empty.forecast.every(
                (row: { closed_amount: string }) =>
                  row.closed_amount === '0.0000',
              ),
            )
            const home = await customersHome(org.orgId, [])
            assert.equal(home.arOutstanding, 0)
            assert.equal(home.pipeline.closed, 0)
            await restrict(org.orgId, null)
            const all = await (
              await forecast(
                new NextRequest(
                  `http://audit.local?periodStart=${org.date}&periodEnd=${org.date}`,
                ),
              )
            ).json()
            assert.equal(all.forecast[0].closed_amount, '1000.0000')
          } else if (boundary === 'depreciation date') {
            for (const asOfDate of ['garbage', '2026-02-30', '', null, 123])
              assert.equal(
                (await depreciate(request({ asOfDate }))).status,
                422,
              )
            assert.equal(
              (await depreciate(request({ asOfDate: org.date }))).status,
              200,
            )
            assert.equal((await depreciate(request({}))).status, 200)
          } else {
            await db.execute(
              sql`insert into tax_return_forms(org_id,code,name) values (${org.orgId},'AUDIT','Audit form')`,
            )
            await db.execute(
              sql`insert into tax_report_lines(org_id,report_code,line_code,label,formula) values (${org.orgId},'AUDIT','amount','Audit amount','0')`,
            )
            const id = randomUUID()
            await db.execute(
              sql`insert into tax_filings(id,org_id,form_code,form_name,period_from,period_to,version,submission_channel,boxes,snapshot_hash,created_by) values (${id},${org.orgId},'AUDIT','Audit form',${org.date},${org.date},1,'portal_manual','[]'::jsonb,${'a'.repeat(64)},${actor})`,
            )
            const url = `http://audit.local?from=${org.date}&to=${org.date}&format=csv`
            const params = { params: Promise.resolve({ code: 'AUDIT' }) }
            for (const response of [
              await returnPreview(new Request(url), params),
              await returnExport(new Request(url), params),
              await filingExport(new Request(url), {
                params: Promise.resolve({ id }),
              }),
              await prepareFiling(
                request({ code: 'AUDIT', from: org.date, to: org.date }),
              ),
            ])
              assert.equal(response.status, 404)
            await restrict(org.orgId, null)
            const allowed = await returnPreview(new Request(url), params)
            assert.equal(
              allowed.status,
              200,
              JSON.stringify(await allowed.json()),
            )
            assert.equal(
              (await returnExport(new Request(url), params)).status,
              200,
            )
            assert.equal(
              (
                await prepareFiling(
                  request({ code: 'AUDIT', from: org.date, to: org.date }),
                )
              ).status,
              201,
            )
          }
        })
      } finally {
        state.user = null
        await withBypassContext(() => dropScratchOrg(org.orgId))
      }
    },
  )
}

async function restrict(orgId: string, ids: string[] | null) {
  const value =
    ids === null ? { mode: 'all' } : { mode: 'list', subsidiaryIds: ids }
  await db.execute(
    sql`update app_roles set subsidiary_restriction=${JSON.stringify(value)}::jsonb where org_id=${orgId} and key='domain_auditor'`,
  )
}
