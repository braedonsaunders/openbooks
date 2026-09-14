import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import type { ApplicationContext } from './context'

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context)
  return nextResolve(specifier, context)
} })
const { db, env, withBypassContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/test-fixtures.ts')
const { draftExtension, discardExtensionDraft, getExtensionDraft, activateExtensionDraft, describeExtensionVocabulary, getExtensionPackage } = await import('./extensions')
const { getAppByKey, installApp, writeAppFile } = await import('../apps/store')

async function fixture() {
  const org = await createScratchOrg()
  const { adminId, approver1Id } = await seedFlowActors(org.orgId)
  const context: ApplicationContext = {
    authz: { user: { id: adminId, orgId: org.orgId, email: 'extension@scratch.test', name: 'Extension author', roles: [{ key: 'admin', name: 'Admin' }], envKind: 'production', productionOrgId: org.orgId, isSuperAdmin: false, homeUserId: adminId, homeOrgId: org.orgId }, permissions: new Set(['*']), allowedSubsidiaryIds: null },
    source: 'api', requestId: randomUUID(), apiKeyId: null,
  }
  return { org, context, approver1Id }
}

test('extension draft isolation, exact review, atomic activation and immutable revisions', { skip: !env.OPENBOOKS_DB_URL }, async () => withBypassContext(async () => {
  const { org, context, approver1Id } = await fixture()
  try {
    const vocabulary = await describeExtensionVocabulary(context)
    const bundle = vocabulary.example
    const proposal = await draftExtension(context, { bundle, reason: 'Add equipment checks' })
    assert.equal(await getAppByKey(org.orgId, bundle.manifest.key), null)
    assert.equal((await db.execute(sql`select id from custom_record_types where org_id=${org.orgId} and key='equipment-check'`)).rows.length, 0)
    const otherAuthor = { ...context, authz: { ...context.authz, user: { ...context.authz.user, id: approver1Id } } }
    await assert.rejects(() => getExtensionDraft(otherAuthor, proposal.draftId), /not found/)
    const foreignOrg = { ...context, authz: { ...context.authz, user: { ...context.authz.user, orgId: randomUUID() } } }
    await assert.rejects(() => getExtensionDraft(foreignOrg, proposal.draftId), /not found/)
    await assert.rejects(() => activateExtensionDraft(context, { ...proposal, contentHash: '0'.repeat(64) }), /changed/)
    await assert.rejects(() => db.execute(sql`update extension_drafts set reason='changed' where id=${proposal.draftId}`), (error: unknown) => String((error as { cause?: Error }).cause).includes('immutable'))
    const outcomes = await Promise.all([activateExtensionDraft(context, proposal), activateExtensionDraft(context, proposal)])
    assert.ok(outcomes.every(result => result.activated))
    const app = await getAppByKey(org.orgId, bundle.manifest.key)
    assert.equal(app?.manifest?.frontend.renderer, 'native')
    assert.equal((await db.execute(sql`select id from custom_record_types where org_id=${org.orgId} and key='equipment-check' and status='published'`)).rows.length, 1)
    assert.equal((await db.execute(sql`select id from modules where org_id=${org.orgId} and key=${bundle.manifest.key}`)).rows.length, 1)
    assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='extension_drafts' and row_id=${proposal.draftId}`)).rows.length, 1)
    await assert.rejects(() => writeAppFile(org.orgId, context.authz.user.id, bundle.manifest.key, 'frontend/ui.json', '{}'), /review/)
    const read = await getExtensionPackage(context, { key: bundle.manifest.key })
    assert.equal(read.versionId, app?.activeVersionId)
    const newer = { ...bundle, manifest: { ...bundle.manifest, version: '2.0.0' } }
    const stale = await draftExtension(context, { bundle: newer, reason: 'Review next version' })
    await installApp(org.orgId, context.authz.user.id, { ...bundle, manifest: { ...bundle.manifest, version: '3.0.0' } })
    await assert.rejects(() => activateExtensionDraft(context, stale), /installed extension changed/)
    assert.equal((await getExtensionDraft(context, stale.draftId)).status, 'draft')
  } finally { await dropScratchOrg(org.orgId) }
}))

test('draft revision replaces only its author proposal and failed object install leaves no partial activation', { skip: !env.OPENBOOKS_DB_URL }, async () => withBypassContext(async () => {
  const { org, context } = await fixture()
  try {
    const { example } = await describeExtensionVocabulary(context)
    const first = await draftExtension(context, { bundle: example, reason: 'First proposal' })
    const second = await draftExtension(context, { bundle: example, reason: 'Revised proposal' })
    await assert.rejects(() => activateExtensionDraft(context, first), /no longer available/)
    await db.execute(sql`insert into custom_record_types(org_id,key,name,plural_name,fields,status,created_by,updated_by) values(${org.orgId},'equipment-check','Existing','Existing','[]'::jsonb,'draft',${context.authz.user.id},${context.authz.user.id})`)
    await assert.rejects(() => activateExtensionDraft(context, second), /already exists|owned|collision|clobber/)
    assert.equal(await getAppByKey(org.orgId, example.manifest.key), null)
    assert.equal((await getExtensionDraft(context, second.draftId)).status, 'draft')
    const denied = { ...context, authz: { ...context.authz, permissions: new Set(['apps.manage', 'admin.customization.manage']) } }
    await assert.rejects(() => activateExtensionDraft(denied, second), /forbidden/)
    await db.execute(sql`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}','{"apps":false}'::jsonb) where id=${org.orgId}`)
    await assert.rejects(() => getExtensionDraft(context, second.draftId), /not found/)
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"apps":true}'::jsonb) where id=${org.orgId}`)
    await discardExtensionDraft(context, second)
    await discardExtensionDraft(context, second)
    assert.equal((await getExtensionDraft(context, second.draftId)).status, 'discarded')
    await assert.rejects(() => activateExtensionDraft(context, second), /no longer available/)
  } finally { await dropScratchOrg(org.orgId) }
}))
