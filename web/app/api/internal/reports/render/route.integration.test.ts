import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

const repo = process.cwd()
const root = pathToFileURL(repo + '/').href
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
            'export async function getTranslations(){const t=(s)=>s;t.has=()=>false;return t;}' +
              'export async function getLocale(){return "en";}',
          ),
      }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})

const { db, withBypassContext } = await import(root + 'engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  root + 'engine/src/testing/fixtures.ts'
)
const { GET } = await import(root + 'web/app/api/internal/reports/render/route.ts')

/**
 * Close-package renders through the internal render endpoint (C-50).
 * The close-delivery worker mints one report_runs row per attached report
 * (trigger 'close-package') under the send principal; the route renders it
 * under close authority — the publish path under the sender's close.run,
 * re-resolved at render time. Scheduled renders keep their own principal.
 */
const DB = Boolean(process.env.OPENBOOKS_DB_URL)
const TOKEN = 'close-route-test-token'

async function seedDefinition(orgId: string): Promise<string> {
  const definitionId = randomUUID()
  await db.execute(sql`
    insert into report_definitions (id, org_id, kind, report_type, system, slug, name, description, query, statement)
    values (${definitionId}, ${orgId}, 'built_in', 'statement', true, 'trial-balance', 'Trial Balance',
            'Debit and credit balances for every account, as of a date.', null,
            '{"kind":"trial-balance"}'::jsonb)`)
  return definitionId
}

async function mintCloseRun(
  orgId: string,
  definitionId: string,
  senderId: string,
  closeRunId: string | null,
  packageId: string,
): Promise<string> {
  const runId = randomUUID()
  await db.execute(sql`
    insert into report_runs (id, org_id, definition_id, trigger, status, recipient_emails, filters,
                             authorization_snapshot, created_by)
    values (${runId}, ${orgId}, ${definitionId}, 'close-package', 'running', '[]'::jsonb,
            ${JSON.stringify({
              statementParams: { period: 'custom', from: '2026-07-01', to: '2026-07-31' },
              closePackage: { packageId, runId: closeRunId },
            })}::jsonb,
            ${JSON.stringify({
              version: 1,
              userId: senderId,
              allowedSubsidiaryIds: null,
              definition: {
                report_type: 'statement',
                query: null,
                statement: { kind: 'trial-balance' },
                name: 'Trial Balance',
                slug: 'trial-balance',
                kind: 'built_in',
              },
            })}::jsonb, ${senderId})`)
  return runId
}

function renderRequest(orgId: string, definitionId: string, runId: string | null): Request {
  const params = new URLSearchParams({ orgId, definitionId })
  if (runId !== null) params.set('runId', runId)
  params.set('period', 'custom')
  params.set('from', '2026-07-01')
  params.set('to', '2026-07-31')
  return new Request(`http://test.local/api/internal/reports/render?${params.toString()}`, {
    headers: { 'x-internal-token': TOKEN },
  })
}

test('close-package run renders under the sender close.run grant', { skip: !DB }, async () => {
  process.env.OPENBOOKS_INTERNAL_TOKEN = TOKEN
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const sender = await withBypassContext(() => createScratchUser(org.orgId, 'Close sender', 'close_sender'))
    await db.execute(sql`
      update app_roles set permissions = '["close.run","reports.read"]'::jsonb,
                           subsidiary_restriction = '{"mode":"all"}'::jsonb
       where org_id = ${org.orgId} and key = 'close_sender'`)
    const definitionId = await seedDefinition(org.orgId)
    const packageId = randomUUID()
    const closeRunId = randomUUID()
    const runId = await mintCloseRun(org.orgId, definitionId, sender, closeRunId, packageId)

    const res = await GET(renderRequest(org.orgId, definitionId, runId))
    assert.equal(res.status, 200, 'an authorized close-package render must succeed')
    assert.match(res.headers.get('content-type') ?? '', /application\/pdf/)
    const bytes = Buffer.from(await res.arrayBuffer())
    assert.ok(bytes.length > 100, 'the render must return real PDF bytes')
    assert.ok(bytes.subarray(0, 5).toString() === '%PDF-', 'the body must be a PDF document')

    // The sender loses close.run: the same run refuses by name with the
    // remedy instead of rendering.
    await db.execute(sql`
      update app_roles set permissions = '["reports.read"]'::jsonb
       where org_id = ${org.orgId} and key = 'close_sender'`)
    const refused = await GET(renderRequest(org.orgId, definitionId, runId))
    assert.equal(refused.status, 422)
    const body = (await refused.json()) as { error: string }
    assert.match(body.error, /no longer holds close\.run — re-send the package/)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('close-package render without a run id or row refuses', { skip: !DB }, async () => {
  process.env.OPENBOOKS_INTERNAL_TOKEN = TOKEN
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const definitionId = await seedDefinition(org.orgId)
    const missing = await GET(renderRequest(org.orgId, definitionId, null))
    assert.equal(missing.status, 422)
    assert.match(((await missing.json()) as { error: string }).error, /runId is required/)
    const unknown = await GET(renderRequest(org.orgId, definitionId, randomUUID()))
    assert.equal(unknown.status, 404)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
