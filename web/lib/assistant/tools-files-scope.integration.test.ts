import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../auth'

const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __fileScope: state })
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__fileScope.user}' }
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2)
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context)
    return nextResolve(path, context)
  }
  return nextResolve(specifier, context)
} })

const { sql } = await import('drizzle-orm')
const { db, env, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { getAuthz } = await import('../authz')
const { executeAssistantTool } = await import('./registry')

test('assistant file tools hide record-folder files outside the caller fence', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  // createScratchUser seeds app_roles outside any bypass of its own; scope
  // the call (and every seed write below) explicitly now that importing the
  // assistant modules has replaced the ambient test bypass process-wide.
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'File scope prober', 'file_scope_prober'))
  const hidden = randomUUID()
  const hiddenDoc = randomUUID()
  const folderId = randomUUID()
  const fileId = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`update app_roles
      set permissions=${JSON.stringify(['documents.read', 'assistant.use'])}::jsonb,
          subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
      where org_id=${org.orgId} and key='file_scope_prober'`)
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden File Branch','CAD','CA')`)
    await db.execute(sql`insert into documents(id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate)
      values (${hiddenDoc}, ${org.orgId}, 'customer_invoice', 'draft', 'HIDDEN-FILE-1', ${hidden}, ${org.customerId}, ${org.date}, 'CAD', 1)`)
    await db.execute(sql`insert into folders (id, org_id, parent_folder_id, name, is_system, record_table, record_id)
      values (${folderId}, ${org.orgId}, null, 'documents / hidden', true, 'documents', ${hiddenDoc})`)
    await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes)
      values (${fileId}, ${org.orgId}, ${folderId}, 'hidden-file-evidence.txt', 'text/plain', 8)`)
  })
  state.user = {
    id: actor,
    orgId: org.orgId,
    name: 'File scope prober',
    email: 'file-scope@scratch.test',
    roles: [],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: actor,
  }
  try {
    await withOrgContext(org.orgId, async () => {
      const authz = await getAuthz()
      assert.ok(authz)
      const listed = await executeAssistantTool(authz, 'list_files', { query: 'hidden-file-evidence' })
      assert.equal(listed.ok, true, JSON.stringify(listed))
      assert.ok(listed.ok)
      assert.deepEqual((listed.data as { items: unknown[] }).items, [])
      const one = await executeAssistantTool(authz, 'get_file', { id: fileId })
      assert.equal(one.ok, false)
    })
  } finally {
    state.user = null
    await dropScratchOrg(org.orgId)
  }
})
