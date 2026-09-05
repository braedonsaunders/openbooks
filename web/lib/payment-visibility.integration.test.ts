import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import React from 'react'
import type { SessionUser } from './auth'

const root = pathToFileURL(process.cwd() + '/').href
const state: {
  user: SessionUser | null
  afterPaymentLoad?: () => Promise<void>
} = { user: null }
Object.assign(globalThis, { __paymentVisibilityState: state, React })
const moduleSource = (source: string) => ({
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent(source),
})
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === '@openbooks/engine/src/payments.ts' &&
      context.parentURL &&
      decodeURIComponent(context.parentURL).includes(
        '/api/payments/[id]/route.ts',
      )
    )
      return moduleSource(`
      export * from ${JSON.stringify(root + 'engine/src/payments.ts')};
      import { loadPaymentDocument as load } from ${JSON.stringify(root + 'engine/src/payments.ts')};
      export async function loadPaymentDocument(...args) {
        const snapshot = await load(...args);
        await globalThis.__paymentVisibilityState.afterPaymentLoad?.();
        return snapshot;
      }
    `)
    if (specifier === 'server-only') return moduleSource('export {}')
    if (specifier === 'next-intl/server')
      return moduleSource(
        'export async function getTranslations(){ const t=(key)=>key; t.rich=(key)=>key; return t }',
      )
    if (
      (specifier === './auth' || specifier.endsWith('/lib/auth')) &&
      context.parentURL?.includes('/web/')
    )
      return moduleSource(
        'export async function currentUser(){return globalThis.__paymentVisibilityState.user}',
      )
    // Only presentation adapters are replaced: the server component, SQL,
    // role resolution, subsidiary policy and payment services remain real.
    if (
      context.parentURL?.includes('/payments/RunsSection.tsx') ||
      context.parentURL?.includes('/payments/PaymentsSection.tsx')
    ) {
      if (specifier === '@/lib/money-server')
        return moduleSource(
          'export async function getMoneyFormatter(){return {money:String}}',
        )
      if (specifier === '../../../lib/customization/resolve')
        return moduleSource(
          'export async function resolveFormLayout(){return {layout:null}}',
        )
      if (specifier === 'next/link') return moduleSource('export default "a"')
      const names: Record<string, string[]> = {
        '@openbooks/ui': [
          'Alert',
          'AlertDescription',
          'AlertTitle',
          'Badge',
          'Table',
          'TableBody',
          'TableCell',
          'TableHeader',
          'TableRow',
          'UrlDrawer',
        ],
        '../../../components/search-input': ['SearchInput'],
        '../../../components/filter-bar': ['FilterChips'],
        '../../../components/pagination': ['Pagination'],
        '../../../components/sortable-th': ['SortTh'],
        './RunBuilder': ['RunBuilder'],
        './RunDrawer': ['RunDrawer'],
        '../../../components/record-list-view': ['RecordListView'],
        './PaymentDrawer': ['PaymentDrawer'],
        './NewPaymentButton': ['NewPaymentButton'],
      }
      if (names[specifier])
        return moduleSource(
          names[specifier]
            .map((name) => `export const ${name}=${JSON.stringify(name)};`)
            .join('\n'),
        )
    }
    if (specifier.startsWith('@/'))
      return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = (await import(
  root + 'engine/src/db.ts'
)) as typeof import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = (await import(
  root + 'engine/src/test-fixtures.ts'
)) as typeof import('@openbooks/engine/src/test-fixtures.ts')
const { postDocument } = (await import(
  root + 'engine/src/posting.ts'
)) as typeof import('@openbooks/engine/src/posting.ts')
const { getAuthz } = await import('./authz')
const { RunsSection } = await import('../app/(app)/payments/RunsSection')
const { GET: listRuns } = await import('../app/api/payments/runs/route')
const { guardPaymentRunPermission } = await import('../app/api/payments/lib')
const { PaymentsSection } =
  await import('../app/(app)/payments/PaymentsSection')
const { createPaymentDocument, updateDraftPayment } = (await import(
  root + 'engine/src/payments.ts'
)) as typeof import('@openbooks/engine/src/payments.ts')
const { POST: suggest } = await import('../app/api/payments/suggest/route')
const { POST: postPayment } =
  await import('../app/api/payments/post-with-applications/route')
const { GET: getPayment, PATCH: patchPayment } =
  await import('../app/api/payments/[id]/route')
const { GET: openItems } = await import('../app/api/payments/open-items/route')

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() =>
      createScratchUser(
        org.orgId,
        'Payment scope reader',
        'payment_scope_reader',
      ),
    )
    state.user = {
      id: actor,
      orgId: org.orgId,
      name: 'Payment scope reader',
      email: 'scope@scratch.test',
      roles: [],
      isSuperAdmin: false,
      envKind: 'production',
      productionOrgId: org.orgId,
      homeOrgId: org.orgId,
      homeUserId: actor,
    }
    const other = randomUUID()
    const docs: Record<string, string> = {}
    const runs: Record<string, string> = {}
    await withBypassContext(async () => {
      await db.execute(
        sql`insert into subsidiaries(id, org_id, parent_id, name, base_currency, country) values (${other}, ${org.orgId}, ${org.subsidiaryId}, 'Restricted entity', 'CAD', 'CA')`,
      )
      await db.execute(
        sql`update parties set subsidiary_id=null where org_id=${org.orgId} and id=${org.vendorId}`,
      )
      await db.execute(
        sql`insert into party_subsidiaries(org_id,party_id,subsidiary_id) values (${org.orgId},${org.vendorId},${other})`,
      )
      await db.execute(
        sql`update app_roles set permissions='["ap.pay"]'::jsonb, subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb where org_id=${org.orgId} and key='payment_scope_reader'`,
      )
      for (const [label, subsidiary] of [
        ['VISIBLE', org.subsidiaryId],
        ['HIDDEN', other],
      ] as const) {
        const documentId = randomUUID()
        docs[label!] = documentId
        await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,posting_date,currency,fx_rate,subtotal,tax_total,total,created_by)
        values (${documentId},${org.orgId},'vendor_bill','draft',${label + '-BILL'},${subsidiary},${org.vendorId},${org.date},${org.date},'CAD','1','100','0','100',${actor})`)
        await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount,created_by)
        values (${org.orgId},${documentId},1,${org.accounts.cogs},'1','100','100','0','0',${actor})`)
        await db.execute(
          sql`update documents set status='approved' where id=${documentId} and org_id=${org.orgId}`,
        )
        await postDocument(documentId, {
          control: {
            ar: org.accounts.ar,
            ap: org.accounts.ap,
            bank: org.accounts.bank,
          },
        })
        const runId = randomUUID()
        runs[label!] = runId
        await db.execute(sql`insert into payment_runs(id,org_id,run_number,bank_account_id,subsidiary_id,method,direction,currency,created_by)
        values (${runId},${org.orgId},${label + '-RUN'},${org.accounts.bank},${subsidiary},'wire','outbound','CAD',${actor})`)
        await db.execute(sql`insert into payment_run_items(org_id,payment_run_id,source_document_id,source_open_line_id,kind,gross_amount,payment_amount,currency,created_by)
        select ${org.orgId},${runId},${documentId},jl.id,'bill','100','100','CAD',${actor}
        from documents d join journal_lines jl on jl.entry_id=d.posted_entry_id and jl.org_id=d.org_id
        where d.id=${documentId} and d.org_id=${org.orgId} and jl.is_open_item and jl.amount<0`)
      }
      await db.execute(
        sql`insert into party_subsidiaries(org_id,party_id,subsidiary_id) values (${org.orgId},${org.customerId},${other})`,
      )
      for (const [label, subsidiary] of [
        ['AR-VISIBLE', org.subsidiaryId],
        ['AR-HIDDEN', other],
      ] as const) {
        const documentId = randomUUID()
        docs[label] = documentId
        await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,posting_date,currency,fx_rate,subtotal,tax_total,total,created_by)
        values (${documentId},${org.orgId},'customer_invoice','draft',${label + '-INVOICE'},${subsidiary},${org.customerId},${org.date},${org.date},'CAD','1','100','0','100',${actor})`)
        await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount,created_by)
        values (${org.orgId},${documentId},1,${org.accounts.revenue},'1','100','100','0','0',${actor})`)
        await db.execute(
          sql`update documents set status='approved' where id=${documentId} and org_id=${org.orgId}`,
        )
        await postDocument(documentId, {
          control: {
            ar: org.accounts.ar,
            ap: org.accounts.ap,
            bank: org.accounts.bank,
          },
        })
        const runId = randomUUID()
        runs[label] = runId
        if (label === 'AR-VISIBLE') runs.INBOUND = runId
        await db.execute(sql`insert into payment_runs(id,org_id,run_number,bank_account_id,subsidiary_id,method,direction,purpose,currency,created_by)
        values (${runId},${org.orgId},${label + '-RUN'},${org.accounts.bank},${subsidiary},'direct_debit','inbound','customer_collections','CAD',${actor})`)
        await db.execute(sql`insert into payment_run_items(org_id,payment_run_id,source_document_id,source_open_line_id,kind,gross_amount,payment_amount,currency,created_by)
        select ${org.orgId},${runId},${documentId},jl.id,'receivable','100','100','CAD',${actor}
        from documents d join journal_lines jl on jl.entry_id=d.posted_entry_id and jl.org_id=d.org_id where d.id=${documentId} and d.org_id=${org.orgId} and jl.is_open_item and jl.amount>0`)
      }
      const format = randomUUID()
      await db.execute(
        sql`insert into payment_formats(id,org_id,code,name,rail,direction,created_by) values (${format},${org.orgId},'visibility','Visibility format','cpa005_credit','credit',${actor})`,
      )
      for (const [label, sub] of [
        ['VISIBLE', org.subsidiaryId],
        ['HIDDEN', other],
        ['SHARED', null],
      ] as const) {
        await db.execute(
          sql`insert into payment_bank_profiles(org_id,name,bank_account_id,subsidiary_id,payment_format_id,currency,created_by) values (${org.orgId},${label + '-PROFILE'},${org.accounts.bank},${sub},${format},'CAD',${actor})`,
        )
      }
    })
    return { org, docs, runs, actor, other }
  } catch (error) {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
    throw error
  }
}

// Deliberately separate tests: each failed boundary must remain independently
// visible rather than stopping the review at the first disclosure.
for (const boundary of [
  'server list and picker',
  'server drawer',
  'API direction',
  'shared-party open items',
  'suggestions',
  'payment drawer',
  'allocation write',
  'empty scope',
  'retained sources',
  'read revision race',
  'collections screen',
] as const) {
  test(
    `payment visibility: ${boundary}`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      const { org, docs, runs, actor, other } = await fixture()
      try {
        await withOrgContext(org.orgId, async () => {
          const authz = await getAuthz()
          assert.ok(authz)
          assert.deepEqual([...authz.allowedSubsidiaryIds!], [org.subsidiaryId])
          if (boundary === 'server list and picker') {
            const tree = await RunsSection({
              ...{ orgId: org.orgId },
              sp: { newRun: '1', preselect: docs.HIDDEN },
              authz,
              canApprove: false,
            })
            const serialized = JSON.stringify(tree)
            assert.ok(serialized.includes('VISIBLE-RUN'))
            assert.ok(serialized.includes('VISIBLE-BILL'))
            assert.ok(
              !serialized.includes('HIDDEN-RUN'),
              'SSR run list must not disclose another subsidiary',
            )
            assert.ok(
              !serialized.includes('HIDDEN-BILL'),
              'bill picker/preselection must not disclose another subsidiary',
            )
            assert.ok(serialized.includes('VISIBLE-PROFILE'))
            assert.ok(serialized.includes('SHARED-PROFILE'))
            assert.ok(!serialized.includes('HIDDEN-PROFILE'))
          } else if (boundary === 'collections screen') {
            await db.execute(
              sql`update app_roles set permissions='["ap.pay","ar.pay"]'::jsonb where org_id=${org.orgId} and key='payment_scope_reader'`,
            )
            const collector = await getAuthz()
            assert.ok(collector)
            const tree = await RunsSection({
              ...{ orgId: org.orgId },
              sp: { newRun: '1', preselect: docs['AR-HIDDEN'] },
              authz: collector,
              canApprove: false,
              direction: 'inbound',
              basePath: '/receipts',
            })
            const content = JSON.stringify(tree)
            assert.ok(content.includes('AR-VISIBLE-RUN'))
            assert.ok(content.includes('AR-VISIBLE-INVOICE'))
            assert.ok(!content.includes('AR-HIDDEN-RUN'))
            assert.ok(!content.includes('AR-HIDDEN-INVOICE'))
          } else if (boundary === 'server drawer') {
            const denied = await guardPaymentRunPermission(runs.HIDDEN!)
            assert.equal(
              'status' in denied ? denied.status : 200,
              404,
              'API proves this run is out of scope',
            )
            const tree = await RunsSection({
              ...{ orgId: org.orgId },
              sp: { run: runs.HIDDEN },
              authz,
              canApprove: false,
            })
            assert.ok(
              !JSON.stringify(tree).includes('HIDDEN-RUN'),
              'SSR drawer must match the API denial',
            )
          } else if (boundary === 'API direction') {
            const response = await listRuns()
            assert.equal(response.status, 200)
            const rows = (await response.json()).runs as Array<{ id: string }>
            assert.ok(rows.some((row) => row.id === runs.VISIBLE))
            assert.ok(
              !rows.some((row) => row.id === runs.INBOUND),
              'AP-only reader must not receive inbound collection metadata',
            )
          } else if (boundary === 'shared-party open items') {
            const response = await openItems(
              new Request(
                `http://test.local/api/payments/open-items?side=ap&partyId=${org.vendorId}`,
              ),
            )
            assert.equal(response.status, 200)
            const rows = (await response.json()).items as Array<{
              documentId: string
            }>
            assert.ok(rows.some((row) => row.documentId === docs.VISIBLE))
            assert.ok(
              !rows.some((row) => row.documentId === docs.HIDDEN),
              'a shared party must not widen its transaction visibility',
            )
          } else if (boundary === 'suggestions') {
            const response = await suggest(
              new Request('http://test.local/api/payments/suggest', {
                method: 'POST',
                body: JSON.stringify({
                  partyId: org.vendorId,
                  side: 'ap',
                  amount: '200',
                  currency: 'CAD',
                }),
              }),
            )
            assert.equal(response.status, 200)
            const suggestion = await response.json()
            assert.equal(
              suggestion.applied,
              '100.0000',
              'suggestions must allocate only the visible bill',
            )
            assert.equal(suggestion.allocations.length, 1)
          } else if (boundary === 'empty scope') {
            await db.execute(
              sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb where org_id=${org.orgId} and key='payment_scope_reader'`,
            )
            const empty = await getAuthz()
            assert.ok(empty)
            assert.equal(empty.allowedSubsidiaryIds?.size, 0)
            assert.deepEqual((await (await listRuns()).json()).runs, [])
            const tree = await RunsSection({
              ...{ orgId: org.orgId },
              sp: { newRun: '1' },
              authz: empty,
              canApprove: false,
            })
            assert.ok(!JSON.stringify(tree).includes('VISIBLE-RUN'))
            assert.ok(!JSON.stringify(tree).includes('VISIBLE-BILL'))
          } else if (boundary === 'retained sources') {
            await db.execute(sql`insert into payment_run_items(org_id,payment_run_id,source_document_id,source_open_line_id,kind,gross_amount,payment_amount,currency,status,exclusion_reason,created_by)
            select org_id,${runs.VISIBLE},source_document_id,source_open_line_id,kind,gross_amount,payment_amount,currency,'excluded','historical selection',${actor}
            from payment_run_items where payment_run_id=${runs.HIDDEN} and org_id=${org.orgId}`)
            const denied = await guardPaymentRunPermission(runs.VISIBLE!)
            assert.equal('status' in denied ? denied.status : 200, 404)
            assert.ok(
              !(await (await listRuns()).json()).runs.some(
                (row: { id: string }) => row.id === runs.VISIBLE,
              ),
            )
            const tree = await RunsSection({
              ...{ orgId: org.orgId },
              sp: { run: runs.VISIBLE },
              authz,
              canApprove: false,
            })
            assert.ok(!JSON.stringify(tree).includes('VISIBLE-RUN'))
          } else {
            const payment = await createPaymentDocument({
              orgId: org.orgId,
              createdBy: actor,
              documentDate: org.date,
              kind: 'vendor_payment',
              partyId: org.vendorId,
              bankAccountId: org.accounts.bank,
              subsidiaryId:
                boundary === 'payment drawer' ? other : org.subsidiaryId,
            })
            if (boundary === 'payment drawer') {
              const tree = await PaymentsSection({
                sp: { payment: payment.id },
                authz,
                orgId: org.orgId,
                userId: actor,
                kind: 'vendor_payment',
                basePath: '/payments',
                canManage: false,
                userRoles: [],
              })
              assert.equal(
                tree?.props.drawer,
                null,
                'a guessed foreign payment ID must not create a drawer',
              )
            } else if (boundary === 'read revision race') {
              const exact = (
                await db.execute<{ revision: string }>(
                  sql`select to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision from documents where id=${payment.id} and org_id=${org.orgId}`,
                )
              ).rows[0]!.revision
              let interleaved = false
              state.afterPaymentLoad = async () => {
                interleaved = true
                await db.execute(
                  sql`update documents set memo='concurrent writer', updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') where id=${payment.id} and org_id=${org.orgId}`,
                )
              }
              try {
                const response = await getPayment(
                  new Request('http://test.local'),
                  { params: Promise.resolve({ id: payment.id }) },
                )
                const snapshot = await response.json()
                assert.ok(
                  interleaved,
                  'the competing write must occur after the values were loaded',
                )
                assert.notEqual(snapshot.doc.memo, 'concurrent writer')
                assert.equal(
                  snapshot.doc.updated_at,
                  exact,
                  'the old values must never carry the concurrent writer revision',
                )
              } finally {
                state.afterPaymentLoad = undefined
              }
            } else {
              const params = { params: Promise.resolve({ id: payment.id }) }
              const original = await getPayment(
                new Request('http://test.local'),
                params,
              )
              assert.equal(original.status, 200)
              const revision = (await original.json()).doc.updated_at
              assert.match(revision, /\.\d{6}Z$/)
              const choices = (
                await (
                  await openItems(
                    new Request(
                      `http://test.local/api/payments/open-items?side=ap&partyId=${org.vendorId}`,
                    ),
                  )
                ).json()
              ).items
              assert.equal(choices.length, 1)
              const body = {
                expectedUpdatedAt: revision,
                allocations: [
                  {
                    openLineId: choices[0].lineId,
                    sourceTransactionAmount: '100',
                    targetTransactionAmount: '100',
                    settlementRate: '1',
                    settlementRateSource: 'same_currency',
                    settlementRateReference: 'same currency',
                  },
                ],
              }
              const saved = await patchPayment(
                new Request('http://test.local', {
                  method: 'PATCH',
                  body: JSON.stringify(body),
                }),
                params,
              )
              const result = await saved.json()
              assert.equal(saved.status, 200, JSON.stringify(result))
              assert.equal(result.doc.total, '100.0000')
              assert.match(result.doc.updated_at, /\.\d{6}Z$/)
              assert.notEqual(result.doc.updated_at, revision)
              const stale = await patchPayment(
                new Request('http://test.local', {
                  method: 'PATCH',
                  body: JSON.stringify(body),
                }),
                params,
              )
              assert.equal(stale.status, 409)
              const posted = await postPayment(
                new Request('http://test.local', {
                  method: 'POST',
                  body: JSON.stringify({
                    documentId: payment.id,
                    allocations: body.allocations,
                  }),
                }),
              )
              const outcome = await posted.json()
              assert.equal(posted.status, 200, JSON.stringify(outcome))
              const remaining = (
                await (
                  await openItems(
                    new Request(
                      `http://test.local/api/payments/open-items?side=ap&partyId=${org.vendorId}`,
                    ),
                  )
                ).json()
              ).items
              assert.deepEqual(
                remaining,
                [],
                'the permitted bill is settled and the forbidden bill stays invisible',
              )
            }
          }
        })
      } finally {
        state.user = null
        await withBypassContext(() => dropScratchOrg(org.orgId))
      }
    },
  )
}

test(
  'payment edits preserve a concurrent committed field while waiting for the row lock',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, actor } = await fixture()
    let release = () => {}
    let acquired = () => {}
    const ready = new Promise<void>((resolve) => {
      acquired = resolve
    })
    const unlocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let blocker: Promise<unknown> | undefined
    let save: Promise<unknown> | undefined
    try {
      const payment = await withOrgContext(org.orgId, () =>
        createPaymentDocument({
          orgId: org.orgId,
          createdBy: actor,
          documentDate: org.date,
          kind: 'vendor_payment',
          partyId: org.vendorId,
          subsidiaryId: org.subsidiaryId,
        }),
      )
      blocker = withOrgContext(org.orgId, () =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`select id from documents where id=${payment.id} and org_id=${org.orgId} for update`,
          )
          acquired()
          await unlocked
          await tx.execute(
            sql`update documents set custom=custom || '{"concurrentEdit":"retained"}'::jsonb,updated_at=clock_timestamp() where id=${payment.id} and org_id=${org.orgId}`,
          )
        }),
      )
      await ready
      save = withOrgContext(org.orgId, () =>
        updateDraftPayment(
          payment.id,
          { memo: 'waiting writer' },
          actor,
          org.orgId,
        ),
      )
      let waiting = false
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = await withBypassContext(
          async () =>
            (
              await db.execute<{ waiting: boolean }>(
                sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%documents%' and query ilike '%update%') as waiting`,
              )
            ).rows[0]!.waiting,
        )
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.ok(
        waiting,
        'the saver must be parked on the real database row lock',
      )
      release()
      await blocker
      await save
      const row = await withOrgContext(
        org.orgId,
        async () =>
          (
            await db.execute<{ memo: string; custom: Record<string, unknown> }>(
              sql`select memo,custom from documents where id=${payment.id} and org_id=${org.orgId}`,
            )
          ).rows[0]!,
      )
      assert.equal(row.memo, 'waiting writer')
      assert.equal(
        row.custom.concurrentEdit,
        'retained',
        'a partial save must merge from the row locked after the concurrent commit',
      )
    } finally {
      release()
      await Promise.allSettled([blocker, save])
      state.user = null
      await withBypassContext(() => dropScratchOrg(org.orgId))
    }
  },
)
