import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { Authz } from '../authz'
import type { SessionUser } from '../auth'

const root = pathToFileURL(process.cwd() + '/').href
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2)
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context)
    return nextResolve(path, context)
  }
  return nextResolve(specifier, context)
} })

const { sql } = await import('drizzle-orm')
const { db, env, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { executeAssistantTool } = await import('./registry')

function authzFor(orgId: string, permissions: string[]): Authz {
  const userId = randomUUID()
  const user: SessionUser = {
    id: userId, orgId, name: 'Ops prober', email: 'ops-prober@scratch.test',
    roles: [], isSuperAdmin: false, envKind: 'production',
    productionOrgId: orgId, homeOrgId: orgId, homeUserId: userId,
  }
  return { user, permissions: new Set(permissions), allowedSubsidiaryIds: null }
}

const READER = ['assistant.use', 'data.export', 'data.import', 'gl.read', 'reports.read', 'admin.setup.manage', 'admin.sandboxes.manage', 'admin.customization.manage']

test('assistant data-io tools list resources and import runs', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    await withOrgContext(org.orgId, async () => {
      const authz = authzFor(org.orgId, READER)
      const resources = await executeAssistantTool(authz, 'list_data_resources', {})
      assert.equal(resources.ok, true, JSON.stringify(resources))
      assert.ok(resources.ok)
      const items = (resources.data as { items: { key: string; label: string; group: string }[] }).items
      assert.ok(items.length > 0, 'expected built-in resources')
      assert.ok(items.every((r) => r.key && r.label && r.group))

      const runs = await executeAssistantTool(authz, 'list_import_runs', {})
      assert.equal(runs.ok, true, JSON.stringify(runs))
      assert.ok(runs.ok)
      assert.deepEqual((runs.data as { runs: unknown[] }).runs, [])
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('assistant sync connections list runs with last-run evidence, isolated per org', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await createScratchOrg()
  const orgB = await createScratchOrg()
  try {
    const connId = randomUUID()
    await withOrgContext(orgA.orgId, async () => {
      await db.execute(sql`insert into connections (id, org_id, source, display_name, auth_kind, status)
        values (${connId}, ${orgA.orgId}, 'test-source', 'Test Connector', 'token', 'active')`)
      await db.execute(sql`insert into sync_runs (org_id, connection_id, source, kind, status, error_message, triggered_by)
        values (${orgA.orgId}, ${connId}, 'test-source', 'incremental', 'failed', 'boom', 'manual')`)
    })
    await withOrgContext(orgB.orgId, async () => {
      const other = await executeAssistantTool(authzFor(orgB.orgId, READER), 'list_sync_connections', {})
      assert.equal(other.ok, true, JSON.stringify(other))
      assert.ok(other.ok)
      assert.deepEqual((other.data as { items: unknown[] }).items, [])
    })
    await withOrgContext(orgA.orgId, async () => {
      const mine = await executeAssistantTool(authzFor(orgA.orgId, READER), 'list_sync_connections', {})
      assert.equal(mine.ok, true, JSON.stringify(mine))
      assert.ok(mine.ok)
      const items = (mine.data as { items: Record<string, unknown>[] }).items
      assert.equal(items.length, 1)
      assert.equal(items[0]!['displayName'], 'Test Connector')
      assert.equal(items[0]!['hasSecrets'], false)
      assert.ok(!('secrets' in items[0]!), 'credential blob must not leave the server')
      const lastRun = items[0]!['lastRun'] as { status: string; error: string } | null
      assert.ok(lastRun, 'expected last-run evidence')
      assert.equal(lastRun.status, 'failed')
      assert.equal(lastRun.error, 'boom')
    })
  } finally {
    await dropScratchOrg(orgA.orgId)
    await dropScratchOrg(orgB.orgId)
  }
})

test('assistant environments list sandboxes with refresh status, isolated per org', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await createScratchOrg()
  const orgB = await createScratchOrg()
  try {
    const sbId = randomUUID()
    await withOrgContext(orgA.orgId, async () => {
      await db.execute(sql`insert into sandboxes (id, org_id, production_org_id, name, status)
        values (${sbId}, ${orgA.orgId}, ${orgA.orgId}, 'Probe Sandbox', 'ready')`)
    })
    await withOrgContext(orgB.orgId, async () => {
      const other = await executeAssistantTool(authzFor(orgB.orgId, READER), 'list_environments', {})
      assert.equal(other.ok, true, JSON.stringify(other))
      assert.ok(other.ok)
      assert.deepEqual((other.data as { items: unknown[] }).items, [])
    })
    await withOrgContext(orgA.orgId, async () => {
      const mine = await executeAssistantTool(authzFor(orgA.orgId, READER), 'list_environments', {})
      assert.equal(mine.ok, true, JSON.stringify(mine))
      assert.ok(mine.ok)
      const items = (mine.data as { items: { name: string; status: string }[] }).items
      assert.equal(items.length, 1)
      assert.equal(items[0]!.name, 'Probe Sandbox')
      assert.equal(items[0]!.status, 'ready')
      const bare = await executeAssistantTool(authzFor(orgA.orgId, ['assistant.use']), 'list_environments', {})
      assert.deepEqual(bare, { ok: false, error: 'forbidden' })
    })
  } finally {
    await dropScratchOrg(orgA.orgId)
    await dropScratchOrg(orgB.orgId)
  }
})

test('assistant pdf templates list without bodies and get truncates, isolated per org', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await createScratchOrg()
  const orgB = await createScratchOrg()
  try {
    const tplId = randomUUID()
    const bigHtml = `<div>${'x'.repeat(9000)}</div>`
    await withOrgContext(orgA.orgId, async () => {
      await db.execute(sql`insert into pdf_templates (id, org_id, record_type, name, source_html, compiled_html)
        values (${tplId}, ${orgA.orgId}, 'customer_invoice', 'Probe Template', ${bigHtml}, ${bigHtml})`)
    })
    await withOrgContext(orgB.orgId, async () => {
      const other = await executeAssistantTool(authzFor(orgB.orgId, READER), 'list_pdf_templates', {})
      assert.equal(other.ok, true, JSON.stringify(other))
      assert.ok(other.ok)
      assert.deepEqual((other.data as { items: unknown[] }).items, [])
      const missing = await executeAssistantTool(authzFor(orgB.orgId, READER), 'get_pdf_template', { id: tplId })
      assert.deepEqual(missing, { ok: false, error: 'template_not_found' })
    })
    await withOrgContext(orgA.orgId, async () => {
      const listed = await executeAssistantTool(authzFor(orgA.orgId, READER), 'list_pdf_templates', {})
      assert.equal(listed.ok, true, JSON.stringify(listed))
      assert.ok(listed.ok)
      const items = (listed.data as { items: Record<string, unknown>[] }).items
      assert.equal(items.length, 1)
      assert.equal(items[0]!['name'], 'Probe Template')
      assert.ok(!('sourceHtml' in items[0]!), 'list rows must not carry HTML bodies')
      const one = await executeAssistantTool(authzFor(orgA.orgId, READER), 'get_pdf_template', { id: tplId })
      assert.equal(one.ok, true, JSON.stringify(one))
      assert.ok(one.ok)
      const data = one.data as { sourceHtml: string; sourceTruncated: boolean; sourceHtmlChars: number }
      assert.equal(data.sourceTruncated, true)
      assert.ok(data.sourceHtml.length <= 6100, `truncated body is ${data.sourceHtml.length} chars`)
      assert.equal(data.sourceHtmlChars, bigHtml.length)
      const badKind = await executeAssistantTool(authzFor(orgA.orgId, READER), 'list_pdf_templates', { recordType: 'nope' })
      assert.deepEqual(badKind, { ok: false, error: 'unknown_record_type' })
      const bare = await executeAssistantTool(authzFor(orgA.orgId, ['assistant.use']), 'get_pdf_template', { id: tplId })
      assert.deepEqual(bare, { ok: false, error: 'forbidden' })
    })
  } finally {
    await dropScratchOrg(orgA.orgId)
    await dropScratchOrg(orgB.orgId)
  }
})

test('assistant data-io tools refuse without their permission', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    await withOrgContext(org.orgId, async () => {
      const authz = authzFor(org.orgId, ['assistant.use'])
      assert.deepEqual(await executeAssistantTool(authz, 'list_data_resources', {}), { ok: false, error: 'forbidden' })
      assert.deepEqual(await executeAssistantTool(authz, 'list_import_runs', {}), { ok: false, error: 'forbidden' })
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('assistant import runs never leak across orgs', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const orgA = await createScratchOrg()
  const orgB = await createScratchOrg()
  try {
    await withOrgContext(orgA.orgId, async () => {
      await db.execute(sql`insert into import_jobs (org_id, resource_key, resource_label, format, status, total_rows, created_count, updated_count, failed_count)
        values (${orgA.orgId}, 'test-resource', 'Test Resource', 'csv', 'committed', 3, 3, 0, 0)`)
    })
    await withOrgContext(orgB.orgId, async () => {
      const runs = await executeAssistantTool(authzFor(orgB.orgId, READER), 'list_import_runs', {})
      assert.equal(runs.ok, true, JSON.stringify(runs))
      assert.ok(runs.ok)
      assert.deepEqual((runs.data as { runs: unknown[] }).runs, [])
    })
    await withOrgContext(orgA.orgId, async () => {
      const runs = await executeAssistantTool(authzFor(orgA.orgId, READER), 'list_import_runs', {})
      assert.equal(runs.ok, true, JSON.stringify(runs))
      assert.ok(runs.ok)
      const rows = (runs.data as { runs: { resourceKey: string; totalRows: number }[] }).runs
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.resourceKey, 'test-resource')
    })
  } finally {
    await dropScratchOrg(orgA.orgId)
    await dropScratchOrg(orgB.orgId)
  }
})
