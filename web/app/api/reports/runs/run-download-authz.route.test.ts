import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * Recorded-run downloads: another organization's run id must not resolve,
 * and a same-org caller who cannot cover the original authorization snapshot
 * must not receive the CSV or rendered bytes.
 */
const stateKey = Symbol.for('openbooks.run-download-authz-route-test')

interface RouteState {
  orgId: string
  queries: string[]
  artifactAllowed: boolean
  csvRows: Array<Record<string, unknown>>
  artifactRows: Array<Record<string, unknown>>
}

const state: RouteState = {
  orgId: 'org-1',
  queries: [],
  artifactAllowed: false,
  csvRows: [],
  artifactRows: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & { openbooksRunDownloadSqlText?: typeof sqlText }).openbooksRunDownloadSqlText =
  sqlText

const RUN_ID = '00000000-0000-4000-8000-00000000d001'
const CONFIDENTIAL = 'CONFIDENTIAL_PAYROLL_CSV'

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.run-download-authz-route-test')]
      export async function guardPermission() {
        return {
          user: { orgId: state.orgId, id: 'user-1' },
          permissions: new Set(['reports.read']),
        }
      }
    `,
  ],
  [
    'mock:artifact',
    `
      const state = globalThis[Symbol.for('openbooks.run-download-authz-route-test')]
      export async function canAccessReportArtifact() { return state.artifactAllowed }
      export async function reportArtifactAccessDetail() {
        return { ok: state.artifactAllowed, missingPermissions: [] }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.run-download-authz-route-test')]
      const sqlText = globalThis.openbooksRunDownloadSqlText
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.queries.push(text)
          if (text.includes('result_csv')) return { rows: state.csvRows }
          if (text.includes('report_run_artifacts')) return { rows: state.artifactRows }
          return { rows: [] }
        },
      }
    `,
  ],
  [
    'mock:date',
    `export async function businessToday() { return '2026-09-20' }`,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['@openbooks/engine/src/platform/business-date.ts', 'mock:date'],
  ['../../../../../../lib/authz', 'mock:authz'],
  ['../../../../../../lib/report-execution-context', 'mock:artifact'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const run_download_csvUrl = './[id]/csv/route.ts?run-download-csv'
const { GET: csv } = (await import(run_download_csvUrl)) as typeof import('./[id]/csv/route.ts')
const run_download_artifactUrl = './[id]/artifact/route.ts?run-download-artifact'
const { GET: artifact } = (await import(run_download_artifactUrl)) as typeof import('./[id]/artifact/route.ts')
hooks.deregister()

const params = { params: Promise.resolve({ id: RUN_ID }) }

function reset(): void {
  state.orgId = 'org-1'
  state.queries = []
  state.artifactAllowed = false
  state.csvRows = []
  state.artifactRows = []
}

test('CSV and artifact downloads bind the caller organization on the run id', async () => {
  reset()

  await csv(new Request('http://openbooks.test/api/reports/runs/x/csv'), params)
  await artifact(new Request('http://openbooks.test/api/reports/runs/x/artifact'), params)

  assert.ok(
    state.queries.some((text) => text.includes('from report_runs') && text.includes('org_id')),
    'CSV lookup must constrain run.org_id',
  )
  assert.ok(
    state.queries.some((text) => text.includes('report_run_artifacts') && text.includes('org_id')),
    'artifact lookup must constrain run.org_id',
  )
})

test('a run id that does not resolve in the caller organization is 404, not the artifact', async () => {
  reset()

  const download = await csv(new Request('http://openbooks.test/api/reports/runs/x/csv'), params)
  const rendered = await artifact(new Request('http://openbooks.test/api/reports/runs/x/artifact'), params)

  assert.equal(download.status, 404)
  assert.deepEqual(await download.json(), { error: 'not found' })
  assert.equal(rendered.status, 404)
  assert.deepEqual(await rendered.json(), { error: 'not found' })
})

test('CSV download refuses when the caller cannot cover the original snapshot', async () => {
  reset()
  state.csvRows = [
    {
      result_csv: CONFIDENTIAL,
      status: 'succeeded',
      slug: 'review-payroll',
      authorization_snapshot: { version: 1, allowedSubsidiaryIds: null },
    },
  ]

  const download = await csv(new Request('http://openbooks.test/api/reports/runs/x/csv'), params)
  const body = await download.text()

  assert.equal(download.status, 403)
  assert.equal(body.includes(CONFIDENTIAL), false, 'denied artifact bytes must not leave the handler')
})

test('artifact download refuses when the caller cannot cover the original snapshot', async () => {
  reset()
  state.artifactRows = [
    {
      filename: 'scheduled-report.pdf',
      content_type: 'application/pdf',
      bytes: Buffer.from('%PDF-CONFIDENTIAL'),
      content_hash: 'hash-1',
      authorization_snapshot: { version: 1, allowedSubsidiaryIds: null },
    },
  ]

  const rendered = await artifact(new Request('http://openbooks.test/api/reports/runs/x/artifact'), params)
  const body = await rendered.text()

  assert.equal(rendered.status, 403)
  assert.equal(body.includes('%PDF-CONFIDENTIAL'), false, 'denied artifact bytes must not leave the handler')
})

test('CSV download returns the stored bytes when the snapshot is covered', async () => {
  reset()
  state.artifactAllowed = true
  state.csvRows = [
    {
      result_csv: 'document_number\nVISIBLE-ENTITY-A\n',
      status: 'succeeded',
      slug: 'review-documents',
      authorization_snapshot: { version: 1, allowedSubsidiaryIds: ['sub-a'] },
    },
  ]

  const download = await csv(new Request('http://openbooks.test/api/reports/runs/x/csv'), params)

  assert.equal(download.status, 200)
  assert.equal(await download.text(), 'document_number\nVISIBLE-ENTITY-A\n')
  assert.match(download.headers.get('content-type') ?? '', /text\/csv/)
})
