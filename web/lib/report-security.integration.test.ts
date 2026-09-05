import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
const repo = process.cwd()
const root = pathToFileURL(repo + '/').href
const state: { user: import('./auth').SessionUser | null } = { user: null }
Object.assign(globalThis, { __reviewState: state })
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only')
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s === 'next-intl/server')
      return {
        shortCircuit: true,
        url:
          'data:text/javascript,' +
          encodeURIComponent(
            'export async function getTranslations(){const t=(s)=>s;t.has=()=>false;return t;}',
          ),
      }
    if (
      (s === './auth' || s.endsWith('/lib/auth')) &&
      c.parentURL?.includes('/web/')
    )
      return {
        shortCircuit: true,
        url:
          'data:text/javascript,' +
          encodeURIComponent(
            'export async function currentUser(){return globalThis.__reviewState.user;}',
          ),
      }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, withBypassContext, withOrgContext } = await import(
  root + 'engine/src/db.ts'
)
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  root + 'engine/src/test-fixtures.ts'
)
const { GET: cardGet } = await import(
  root + 'web/app/api/insights/cards/[id]/route.ts'
)
const { GET: dashboardGet } = await import(
  root + 'web/app/api/insights/dashboards/[id]/route.ts'
)
const { POST: pinDashboard } = await import(
  root + 'web/app/api/insights/dashboards/[id]/pin/route.ts'
)
const { loadCard, loadDashboardEmbed, normalizeAllowedRoles } = await import(
  root + 'web/app/api/insights/_lib.ts'
)
const { insightVisibilitySql } = await import(
  root + 'web/lib/insight-access.ts'
)
const { POST: insight } = await import(
  root + 'web/app/api/insights/query/route.ts'
)
const { POST: run } = await import(root + 'web/app/api/reports/run/route.ts')
const { GET: csv } = await import(
  root + 'web/app/api/reports/runs/[id]/csv/route.ts'
)
const { POST: schedule } = await import(
  root + 'web/app/api/reports/schedules/route.ts'
)
const { PATCH: patch } = await import(
  root + 'web/app/api/reports/definitions/[id]/route.ts'
)
const { getAuthz } = await import(root + 'web/lib/authz.ts')
const { statementDefinitionId } = await import(
  root + 'web/lib/custom-reports.ts'
)
const { snapshotReportAuthorization, scheduledReportAuthz } = await import(
  root + 'web/lib/report-execution-context.ts'
)
test(
  'report execution, artifacts and schedules enforce original permissions and subsidiary scope',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fixture = await withBypassContext(() => createScratchOrg())
    const otherFixture = await withBypassContext(() => createScratchOrg())
    const oid = fixture.orgId
    try {
      const uid = await withBypassContext(() =>
        createScratchUser(oid, 'Restricted report reader', 'review_reader'),
      )
      await withBypassContext(async () => {
        await createScratchUser(
          otherFixture.orgId,
          'Other organization administrator',
          'review_other_role',
        )
        await db.execute(
          sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${otherFixture.orgId} and key='review_other_role'`,
        )
        await db.execute(sql`insert into role_assignments(user_id,org_id,role_id)
    select ${uid},${otherFixture.orgId},id from app_roles where org_id=${otherFixture.orgId} and key='review_other_role'`)
      })
      state.user = {
        id: uid,
        orgId: oid,
        isSuperAdmin: false,
        name: 'Restricted reader',
        email: 'review@example.test',
        roles: [],
        envKind: 'production',
        productionOrgId: oid,
        homeOrgId: oid,
        homeUserId: uid,
      }
      await withBypassContext(async () => {
        await db.execute(sql`update app_roles set permissions='["reports.read","reports.create","reports.schedule","insights.read"]'::jsonb,
    subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [fixture.subsidiaryId] })}::jsonb
    where org_id=${oid} and key='review_reader'`)
        const other = randomUUID()
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
    values(${other},${oid},${fixture.subsidiaryId},'Other entity','CAD','CA')`)
        for (const [sub, number] of [
          [other, 'SECRET-ENTITY-B'],
          [fixture.subsidiaryId, 'VISIBLE-ENTITY-A'],
        ]) {
          await db.execute(sql`insert into documents (org_id,subsidiary_id,kind,status,document_number,document_date,currency,subtotal,tax_total,total,created_by)
      values (${oid},${sub},'customer_invoice','draft',${number},'2026-07-15','CAD',0,0,0,${uid})`)
        }
      })
      await withOrgContext(oid, async () => {
        assert.ok(
          await statementDefinitionId(oid, 'true-cost'),
          'a new statement materializes before scheduling',
        )
        const request = (body: unknown) =>
          new Request('http://test.local', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        const res = await run(
          request({
            query: { entity: 'documents', columns: ['document_number'] },
            preview: false,
          }),
        )
        assert.equal(res.status, 200)
        const text = await res.text()
        assert.ok(text.includes('VISIBLE-ENTITY-A'))
        assert.ok(!text.includes('SECRET-ENTITY-B'))
        const insightQuery = {
          source: 'documents',
          dimensions: [{ field: 'document_number' }],
          measures: [{ agg: 'count' }],
        }
        const insightResponse = await insight(
          request({ query: insightQuery, allowedSubsidiaryIds: null }),
        )
        assert.equal(
          insightResponse.status,
          200,
          await insightResponse.clone().text(),
        )
        const insightRows = await insightResponse.json()
        assert.deepEqual(
          insightRows.rows,
          [{ document_number: 'VISIBLE-ENTITY-A', count: '1' }],
          'request body cannot widen the server-owned subsidiary scope',
        )
        await db.execute(
          sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb where org_id=${oid} and key='review_reader'`,
        )
        const emptyInsight = await insight(request({ query: insightQuery }))
        assert.equal(
          emptyInsight.status,
          200,
          await emptyInsight.clone().text(),
        )
        assert.deepEqual((await emptyInsight.json()).rows, [])
        await db.execute(
          sql`update app_roles set subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [fixture.subsidiaryId] })}::jsonb where org_id=${oid} and key='review_reader'`,
        )
        const originalSettings = await db.execute(
          sql`select settings from orgs where id=${oid}`,
        )
        await db.execute(
          sql`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}','{"projects":false,"timeTracking":true}'::jsonb) where id=${oid}`,
        )
        for (const source of ['projects', 'timesheets']) {
          const blocked = await insight(request({ query: { source } }))
          assert.equal(blocked.status, 403, await blocked.clone().text())
          assert.match(await blocked.text(), /feature is disabled/)
        }
        await db.execute(
          sql`update orgs set settings=${JSON.stringify(originalSettings.rows[0]!.settings)}::jsonb where id=${oid}`,
        )
        const deniedPayroll = await insight(
          request({ query: { source: 'pay_stubs' } }),
        )
        assert.equal(deniedPayroll.status, 403)
        assert.match(await deniedPayroll.text(), /missing permission/)
        const publicCard = randomUUID(),
          privateCard = randomUUID(),
          draftCard = randomUUID(),
          allowedCard = randomUUID()
        const board = randomUUID(),
          privateBoard = randomUUID()
        for (const [id, status, roles] of [
          [publicCard, 'published', null],
          [privateCard, 'published', ['review_other_role']],
          [draftCard, 'draft', null],
          [allowedCard, 'published', ['review_reader']],
        ] as const) {
          await db.execute(
            sql`insert into insight_cards(id,org_id,name,query,status,allowed_roles) values(${id},${oid},${id},'{"source":"documents"}'::jsonb,${status},${JSON.stringify(roles)}::jsonb)`,
          )
        }
        // SQL NULL is the public audience; JSON null is not a valid stored list.
        await db.execute(
          sql`update insight_cards set allowed_roles=null where id in (${publicCard},${draftCard})`,
        )
        for (const [id, roles] of [
          [board, null],
          [privateBoard, ['review_other_role']],
        ] as const) {
          await db.execute(sql`insert into insight_dashboards(id,org_id,name,status,layout,allowed_roles)
      values(${id},${oid},${id},'published',${JSON.stringify([publicCard, privateCard, draftCard, allowedCard].map((cardId) => ({ cardId, x: 0, y: 0, w: 6, h: 3 })))}::jsonb,${JSON.stringify(roles)}::jsonb)`)
        }
        await db.execute(
          sql`update insight_dashboards set allowed_roles=null where id=${board}`,
        )
        const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
        assert.equal(
          (await cardGet(request({}), ctx(privateCard))).status,
          404,
          'a role in another organization cannot unlock the private library',
        )
        assert.equal(
          (await cardGet(request({}), ctx(draftCard))).status,
          404,
          'readers cannot open unpublished cards',
        )
        assert.equal(
          (await cardGet(request({}), ctx(allowedCard))).status,
          200,
          'current database assignments unlock the audience',
        )
        assert.equal(
          (await dashboardGet(request({}), ctx(privateBoard))).status,
          404,
        )
        assert.equal(
          (await pinDashboard(request({}), ctx(privateBoard))).status,
          404,
        )
        const embed = await loadDashboardEmbed(board, oid)
        assert.ok(embed)
        assert.deepEqual(
          new Set(embed.cards.map((card: { id: string }) => card.id)),
          new Set([publicCard, allowedCard]),
        )
        assert.equal(embed.layout.length, 2)
        const viewer = await getAuthz()
        assert.ok(viewer)
        const visible = await db.execute(
          sql`select id from insight_cards where ${insightVisibilitySql(viewer)}`,
        )
        assert.ok(
          !visible.rows.some(
            (row: { id: string }) =>
              row.id === privateCard || row.id === draftCard,
          ),
        )
        for (const malformed of [[7], [''], ['review_reader', null]])
          assert.throws(() => normalizeAllowedRoles(malformed))
        await db.execute(
          sql`update app_roles set permissions=permissions || '["insights.create"]'::jsonb where org_id=${oid} and key='review_reader'`,
        )
        assert.ok(await loadCard(draftCard, oid), 'editors can open drafts')
        assert.equal(
          await loadCard(privateCard, oid),
          null,
          'editing permission does not bypass an explicit audience',
        )
        const def = randomUUID(),
          rid = randomUUID(),
          legacy = randomUUID()
        const definition = {
          kind: 'custom',
          report_type: 'query' as const,
          slug: 'review-payroll',
          name: 'Payroll report',
          query: { entity: 'pay_stubs', columns: ['gross_pay'] },
          statement: null,
        }
        const authz = await getAuthz()
        assert.ok(authz)
        assert.deepEqual(
          authz.allowedSubsidiaryIds,
          new Set([fixture.subsidiaryId]),
          'another organization cannot widen this scope',
        )
        const snapshot = snapshotReportAuthorization(authz, definition)
        await db.execute(sql`insert into report_definitions (id,org_id,kind,report_type,slug,name,query,created_by)
    values(${def},${oid},'custom','query',${definition.slug},${definition.name},${JSON.stringify(definition.query)}::jsonb,${uid})`)
        for (const [id, evidence] of [
          [rid, snapshot],
          [legacy, null],
        ] as const) {
          await db.execute(sql`insert into report_runs(id,org_id,definition_id,trigger,status,result_csv,created_by,authorization_snapshot)
      values(${id},${oid},${def},'manual','succeeded','CONFIDENTIAL_PAYROLL_CSV',${uid},${JSON.stringify(evidence)}::jsonb)`)
        }
        const download = (id: string) =>
          csv(new Request('http://test.local'), {
            params: Promise.resolve({ id }),
          })
        assert.equal((await download(rid)).status, 403)
        const cadence = {
          definitionId: def,
          cadence: 'daily',
          hour: 9,
          minute: 0,
          timezone: 'UTC',
          recipientEmails: ['recipient@example.test'],
          active: false,
        }
        assert.equal((await schedule(request(cadence))).status, 403)
        const rev = await db.execute(
          sql`select to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision from report_definitions where id=${def}`,
        )
        assert.equal(
          (
            await patch(
              request({
                query: { entity: 'documents', columns: ['document_number'] },
                expectedUpdatedAt: rev.rows[0]!.revision,
              }),
              { params: Promise.resolve({ id: def }) },
            )
          ).status,
          403,
        )
        // An authorized editor can change the definition; this must not relabel old bytes.
        await db.execute(
          sql`update report_definitions set query='{"entity":"documents","columns":["document_number"]}'::jsonb where id=${def}`,
        )
        assert.equal((await download(rid)).status, 403)
        assert.equal((await download(legacy)).status, 403)
        await db.execute(
          sql`update app_roles set permissions='["reports.read","reports.create","reports.schedule","payroll.read"]'::jsonb where org_id=${oid} and key='review_reader'`,
        )
        assert.equal((await download(rid)).status, 200)
        const createdSchedule = await schedule(request(cadence))
        assert.equal(
          createdSchedule.status,
          201,
          await createdSchedule.clone().text(),
        )
        const created = await createdSchedule.json()
        const audit = await db.execute(
          sql`select changes from audit_log where org_id=${oid} and table_name='report_schedules' and row_id=${created.schedule.id}`,
        )
        assert.equal(audit.rows.length, 1)
        await assert.rejects(
          db.execute(
            sql`update report_runs set authorization_snapshot=null where id=${rid} and org_id=${oid}`,
          ),
        )
        const active = await scheduledReportAuthz(oid, snapshot)
        assert.deepEqual(
          active.allowedSubsidiaryIds,
          new Set([fixture.subsidiaryId]),
        )
        await db.execute(
          sql`update app_roles set permissions='["reports.read"]'::jsonb where org_id=${oid} and key='review_reader'`,
        )
        await assert.rejects(scheduledReportAuthz(oid, snapshot), /revoked/)
      })
    } finally {
      state.user = null
      await withBypassContext(() => dropScratchOrg(otherFixture.orgId))
      await withBypassContext(() => dropScratchOrg(oid))
    }
  },
)

test(
  'Insight lifecycle mutations retain atomic audit evidence and reject stale dashboard saves after card deletion',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { Client } = await import('pg')
    const admin = new Client({
      connectionString:
        process.env.OPENBOOKS_TEST_ADMIN_DB_URL ?? process.env.OPENBOOKS_DB_URL,
    })
    await admin.connect()
    const fixture = await withBypassContext(() => createScratchOrg())
    const oid = fixture.orgId
    const trigger = 'insight_audit_fault_' + randomUUID().replaceAll('-', '')
    const { POST: createCard } = await import(
      root + 'web/app/api/insights/cards/draft/route.ts'
    )
    const { POST: createBoard } = await import(
      root + 'web/app/api/insights/dashboards/draft/route.ts'
    )
    const { PATCH: saveCard, DELETE: deleteCard } = await import(
      root + 'web/app/api/insights/cards/[id]/route.ts'
    )
    const { PATCH: saveBoard, DELETE: deleteBoard } = await import(
      root + 'web/app/api/insights/dashboards/[id]/route.ts'
    )
    const { POST: publishCard } = await import(
      root + 'web/app/api/insights/cards/[id]/publish/route.ts'
    )
    const { POST: publishBoard } = await import(
      root + 'web/app/api/insights/dashboards/[id]/publish/route.ts'
    )
    try {
      const uid = await withBypassContext(() =>
        createScratchUser(oid, 'Insight editor', 'insight_editor'),
      )
      state.user = {
        id: uid,
        orgId: oid,
        isSuperAdmin: false,
        name: 'Editor',
        email: 'editor@example.test',
        roles: [],
        envKind: 'production',
        productionOrgId: oid,
        homeOrgId: oid,
        homeUserId: uid,
      }
      await withBypassContext(() =>
        db.execute(
          sql`update app_roles set permissions='["insights.read","insights.create","insights.publish"]'::jsonb where org_id=${oid} and key='insight_editor'`,
        ),
      )
      await withOrgContext(oid, async () => {
        const request = (body: unknown) =>
          new Request('http://test.local', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
        const cardResponse = await createCard()
        assert.equal(cardResponse.status, 200)
        const card = await cardResponse.json()
        const boardResponse = await createBoard()
        assert.equal(boardResponse.status, 200)
        const board = await boardResponse.json()
        const cardBefore = await (
          await cardGet(request({}), ctx(card.id))
        ).json()
        const savedCard = await saveCard(
          request({
            name: 'Revenue card',
            expectedUpdatedAt: cardBefore.updated_at,
          }),
          ctx(card.id),
        )
        assert.equal(savedCard.status, 200, await savedCard.clone().text())
        assert.equal(
          (
            await publishCard(
              request({
                expectedUpdatedAt: (await savedCard.clone().json()).updated_at,
              }),
              ctx(card.id),
            )
          ).status,
          200,
        )
        const boardBefore = await (
          await dashboardGet(request({}), ctx(board.id))
        ).json()
        const savedBoard = await saveBoard(
          request({
            name: 'Operations board',
            layout: [{ cardId: card.id, x: 0, y: 0, w: 6, h: 3 }],
            expectedUpdatedAt: boardBefore.updated_at,
          }),
          ctx(board.id),
        )
        assert.equal(savedBoard.status, 200, await savedBoard.clone().text())
        for (const cardId of ['invalid-id', randomUUID()]) {
          const invalidLayout = await saveBoard(
            request({
              layout: [{ cardId, x: 0, y: 0, w: 6, h: 3 }],
              expectedUpdatedAt: (await savedBoard.clone().json()).updated_at,
            }),
            ctx(board.id),
          )
          assert.equal(
            invalidLayout.status,
            422,
            'invalid or unavailable card references cannot corrupt a board',
          )
        }
        assert.equal(
          (
            await publishBoard(
              request({
                expectedUpdatedAt: (await savedBoard.clone().json()).updated_at,
              }),
              ctx(board.id),
            )
          ).status,
          200,
        )
        const boardPublished = await (
          await dashboardGet(request({}), ctx(board.id))
        ).json()
        assert.equal(
          (
            await publishBoard(
              request({
                publish: false,
                expectedUpdatedAt: boardBefore.updated_at,
              }),
              ctx(board.id),
            )
          ).status,
          409,
        )
        const cardPublished = await (
          await cardGet(request({}), ctx(card.id))
        ).json()
        // Fault only this scratch tenant. Other test owners and production data are untouched.
        await admin.query(
          `create function public.${trigger}() returns trigger language plpgsql as $$ begin if new.org_id = '${oid}'::uuid and new.table_name in ('insight_cards','insight_dashboards') then raise exception 'injected insight audit failure'; end if; return new; end $$`,
        )
        await admin.query(
          `create trigger ${trigger} before insert on audit_log for each row execute function public.${trigger}()`,
        )
        for (const attempt of [
          () => createCard(),
          () => createBoard(),
          () =>
            saveCard(
              request({
                name: 'Must roll back',
                expectedUpdatedAt: cardPublished.updated_at,
              }),
              ctx(card.id),
            ),
          () =>
            saveBoard(
              request({
                name: 'Must roll back',
                expectedUpdatedAt: boardPublished.updated_at,
              }),
              ctx(board.id),
            ),
          () =>
            publishCard(
              request({
                publish: false,
                expectedUpdatedAt: cardPublished.updated_at,
              }),
              ctx(card.id),
            ),
          () =>
            publishBoard(
              request({
                publish: false,
                expectedUpdatedAt: boardPublished.updated_at,
              }),
              ctx(board.id),
            ),
          () => deleteCard(request({}), ctx(card.id)),
          () => deleteBoard(request({}), ctx(board.id)),
        ])
          await assert.rejects(
            attempt,
            /Failed query|injected insight audit failure/,
          )
        assert.deepEqual(
          await (await cardGet(request({}), ctx(card.id))).json(),
          cardPublished,
        )
        assert.deepEqual(
          await (await dashboardGet(request({}), ctx(board.id))).json(),
          boardPublished,
        )
        const counts = await db.execute(
          sql`select (select count(*) from insight_cards where org_id=${oid}) as cards,(select count(*) from insight_dashboards where org_id=${oid}) as boards`,
        )
        assert.equal(counts.rows[0]!.cards, '1')
        assert.equal(counts.rows[0]!.boards, '1')
        await admin.query(`drop trigger ${trigger} on audit_log`)
        await admin.query(`drop function public.${trigger}()`)
        assert.equal((await deleteCard(request({}), ctx(card.id))).status, 200)
        const stale = await saveBoard(
          request({
            layout: boardPublished.layout,
            expectedUpdatedAt: boardPublished.updated_at,
          }),
          ctx(board.id),
        )
        assert.equal(
          stale.status,
          409,
          'a stale save cannot reintroduce the deleted card',
        )
        const cleaned = await (
          await dashboardGet(request({}), ctx(board.id))
        ).json()
        assert.deepEqual(cleaned.layout, [])
        assert.equal(
          (await deleteBoard(request({}), ctx(board.id))).status,
          200,
        )
        const audit = await db.execute(
          sql`select table_name,action,changes,actor_id from audit_log where org_id=${oid} and table_name in ('insight_cards','insight_dashboards') order by at,id`,
        )
        assert.equal(
          audit.rows.length,
          9,
          'only committed lifecycle changes have evidence',
        )
        for (const event of audit.rows as Array<{
          action: string
          actor_id: string
          changes: Record<string, unknown>
        }>) {
          assert.equal(event.actor_id, uid)
          if (event.action !== 'insert') assert.ok(event.changes.before)
          if (event.action !== 'delete') assert.ok(event.changes.after)
        }
      })
    } finally {
      state.user = null
      await admin.query(`drop trigger if exists ${trigger} on audit_log`)
      await admin.query(`drop function if exists public.${trigger}()`)
      await admin.end()
      await withBypassContext(() => dropScratchOrg(oid))
    }
  },
)
