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
const { draftExtension, discardExtensionDraft, getExtensionDraft, activateExtensionDraft, describeExtensionVocabulary, getExtensionPackage, previewExtensionPage } = await import('./extensions')
const { getAppByKey, installApp } = await import('../apps/store')

async function fixture() {
  const org = await createScratchOrg()
  const { adminId, approver1Id } = await seedFlowActors(org.orgId)
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`)
  const context: ApplicationContext = {
    authz: { user: { id: adminId, orgId: org.orgId, email: 'extension@scratch.test', name: 'Extension author', roles: [{ key: 'admin', name: 'Admin' }], envKind: 'production', productionOrgId: org.orgId, isSuperAdmin: false, homeUserId: adminId, homeOrgId: org.orgId }, permissions: new Set(['*']), allowedSubsidiaryIds: null },
    source: 'api', requestId: randomUUID(), apiKeyId: null,
  }
  return { org, context, approver1Id }
}

test('platform administrators author tenant drafts using their real home identity', { skip: !env.OPENBOOKS_DB_URL }, async () => withBypassContext(async () => {
  const home = await fixture()
  const target = await fixture()
  try {
    await db.execute(sql`update users set is_super_admin=true where id=${home.context.authz.user.id}`)
    const context: ApplicationContext = { ...home.context, authz: { ...home.context.authz,
      user: { ...home.context.authz.user, orgId: target.org.orgId, productionOrgId: target.org.orgId, isSuperAdmin: true },
    } }
    const { example } = await describeExtensionVocabulary(context)
    const result = await draftExtension(context, { bundle: example, reason: 'Review cross-tenant administrative authoring' })
    const draft = await getExtensionDraft(context, result.draftId)
    const stored = (await db.execute<{ created_by: string; org_id: string }>(sql`select created_by,org_id from extension_drafts where id=${result.draftId}`)).rows[0]!
    assert.equal(stored.created_by, home.context.authz.user.id)
    assert.equal(stored.org_id, target.org.orgId)
    assert.equal(draft.status, 'draft')
    assert.equal(await getAppByKey(target.org.orgId, example.manifest.key), null)
    await assert.rejects(() => getExtensionDraft(home.context, result.draftId), /not found/)
    await assert.rejects(() => getExtensionDraft(target.context, result.draftId), /not found/)
    await discardExtensionDraft(context, result)
    assert.equal((await getExtensionDraft(context, result.draftId)).status, 'discarded')
  } finally {
    await dropScratchOrg(target.org.orgId)
    await dropScratchOrg(home.org.orgId)
  }
}))

test('extension draft isolation, exact review, atomic activation and immutable revisions', { skip: !env.OPENBOOKS_DB_URL }, async () => withBypassContext(async () => {
  const { org, context, approver1Id } = await fixture()
  try {
    const vocabulary = await describeExtensionVocabulary(context)
    const bundle = { ...vocabulary.example, manifest: { ...vocabulary.example.manifest,
      permissions: [...vocabulary.example.manifest.permissions,'admin.customization.manage','admin.setup.manage','admin.roles.manage'],
      contributions: [
        {kind:'page',route:'/admin',scope:'org',spec:{specVersion:1,route:'/admin',layout:'list',header:[],body:[{kind:'text',content:'Unified page proof'}]}},
        {kind:'nav',href:'/apps/equipment-checks',label:'Equipment checks',group:'insights',requiredPermission:'inspection.read'},
        {kind:'setting',key:'caption',label:'Caption',valueType:'string',defaultValue:'Inspection'},
        {kind:'permission',key:'inspection.read',label:'Read inspection workspace'},
      ],
    }, files: [...vocabulary.example.files, {path:'objects/inspection-note.json',content:JSON.stringify({type:'custom_field',targetTable:'parties',key:'inspection_note',label:'Inspection note',fieldType:'text'})}] }
    const proposal = await draftExtension(context, { bundle, reason: 'Add equipment checks' })
    assert.equal(await getAppByKey(org.orgId, bundle.manifest.key), null)
    assert.equal((await db.execute(sql`select id from custom_record_types where org_id=${org.orgId} and key='equipment-check'`)).rows.length, 0)
    const otherAuthor = { ...context, authz: { ...context.authz, user: { ...context.authz.user, id: approver1Id } } }
    await assert.rejects(() => getExtensionDraft(otherAuthor, proposal.draftId), /not found/)
    const foreignOrg = { ...context, authz: { ...context.authz, user: { ...context.authz.user, orgId: randomUUID() } } }
    await assert.rejects(() => getExtensionDraft(foreignOrg, proposal.draftId), /not found/)
    await assert.rejects(() => activateExtensionDraft(context, { ...proposal, contentHash: '0'.repeat(64) }), /changed/)
    await assert.rejects(() => db.execute(sql`update extension_drafts set reason='changed' where id=${proposal.draftId}`), (error: unknown) => String((error as { cause?: Error }).cause).includes('immutable'))
    const preview = await previewExtensionPage(context,{draftId:proposal.draftId,route:'/admin'})
    assert.equal(preview.staged,true)
    assert.equal((await db.execute(sql`select id from page_specs where org_id=${org.orgId} and extension_version_id is not null`)).rows.length,0)
    const outcomes = await Promise.all([activateExtensionDraft(context, proposal), activateExtensionDraft(context, proposal)])
    assert.ok(outcomes.every(result => result.activated))
    const app = await getAppByKey(org.orgId, bundle.manifest.key)
    assert.equal(app?.manifest?.frontend.renderer, 'native')
    assert.equal((await db.execute(sql`select id from custom_record_types where org_id=${org.orgId} and key='equipment-check' and status='published'`)).rows.length, 1)
    assert.equal((await db.execute(sql`select id from apps where org_id=${org.orgId} and key=${bundle.manifest.key}`)).rows.length, 1)
    assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='extension_drafts' and row_id=${proposal.draftId}`)).rows.length, 1)
    await assert.rejects(() => db.execute(sql`update app_files set content='{}' where org_id=${org.orgId} and version_id=${app!.activeVersionId} and path='frontend/ui.json'`), (error:unknown)=>String((error as {cause?:Error}).cause).includes('immutable'))
    assert.equal((await db.execute(sql`select id from custom_field_defs where org_id=${org.orgId} and key='inspection_note'`)).rows.length,1)
    const {listActiveExtensionContributions,getExtensionSettings}=await import('@openbooks/engine/src/extensions/projections.ts')
    const {extensionPermissionAvailability}=await import('@openbooks/engine/src/extensions/permission-availability.ts')
    const {loadPageSpec}=await import('../page-specs')
    const activeContributions=await listActiveExtensionContributions(org.orgId)
    assert.equal(activeContributions.length,3)
    assert.ok(activeContributions.every(item=>item.extensionId===app!.id && item.versionId===app!.activeVersionId))
    assert.equal((await loadPageSpec(org.orgId,'/admin',{widgets:new Set(),frames:new Set()}))?.extensionVersionId,app!.activeVersionId)
    assert.equal((await getExtensionSettings(org.orgId))['equipment-checks']?.caption,'Inspection')
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"apps":false}'::jsonb) where id=${org.orgId}`)
    assert.deepEqual(await listActiveExtensionContributions(org.orgId),[])
    assert.ok((await extensionPermissionAvailability(org.orgId)).inactive.includes('inspection.read'))
    assert.equal(await loadPageSpec(org.orgId,'/admin',{widgets:new Set(),frames:new Set()}),null)
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"apps":true}'::jsonb) where id=${org.orgId}`)
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

test('native action shares governed records, storage and audit; retries replay and failures roll back', { skip: !env.OPENBOOKS_DB_URL }, async () => withBypassContext(async () => {
  const { org, context } = await fixture()
  const { runExtensionAction } = await import('./extension-actions')
  try {
    const { example } = await describeExtensionVocabulary(context)
    const draft = await draftExtension(context, { bundle: example, reason: 'Native form and backend workflow' })
    await assert.rejects(() => runExtensionAction(context, example.manifest.key, { screenKey: 'new-check', versionId: randomUUID(), invocationId: randomUUID(), input: { equipment: 'Pump' } }), /not found/)
    await activateExtensionDraft(context, draft)
    const app = (await getAppByKey(org.orgId, example.manifest.key))!
    const request = { screenKey: 'new-check', versionId: app.activeVersionId!, invocationId: randomUUID(), input: { equipment: 'Pump', notes: 'Inspected' } }
    const counts = async () => (await db.execute<{ records: number; storage: number }>(sql`select
      (select count(*)::int from custom_records where org_id=${org.orgId}) as records,
      (select count(*)::int from app_storage where org_id=${org.orgId} and app_id=${app.id}) as storage`)).rows[0]!
    await assert.rejects(() => runExtensionAction(context, app.key, { ...request, input: {} }), /required/i)
    await assert.rejects(() => runExtensionAction(context, app.key, { ...request, input: { ...request.input, arbitrary: 'not declared' } }), /unknown|Unknown/)
    await assert.rejects(() => runExtensionAction(context, app.key, { ...request, versionId: randomUUID() }), /changed/)
    const denied = { ...context, authz: { ...context.authz, permissions: new Set(['apps.use', 'records.read']) } }
    const refused = await runExtensionAction(denied, app.key, request)
    assert.equal(refused.ok, false)
    assert.deepEqual(await counts(), { records: 0, storage: 0 })
    const first = await runExtensionAction(context, app.key, request)
    assert.equal(first.ok, true, JSON.stringify(first))
    const replay = await runExtensionAction(context, app.key, request)
    assert.deepEqual(replay, first)
    assert.deepEqual(await counts(), { records: 1, storage: 1 })
    const record = (await db.execute<{ data: { equipment: string } }>(sql`select data from custom_records where org_id=${org.orgId}`)).rows[0]!
    assert.equal(record.data.equipment, 'Pump')
    const retained = (await db.execute<{ value: string }>(sql`select value from app_storage where org_id=${org.orgId} and app_id=${app.id} and key='last-check'`)).rows[0]!
    assert.ok((await db.execute(sql`select id from custom_records where org_id=${org.orgId} and id=${retained.value}`)).rows.length === 1)
    assert.equal((await runExtensionAction(context, app.key, { ...request, invocationId: randomUUID() })).ok, true)
    assert.deepEqual(await counts(), { records: 2, storage: 1 })
    const broken = { ...example, manifest: { ...example.manifest, version: '2.0.0' }, files: example.files.map(file => file.path === 'backend/create-check.js' ? { ...file, content: "function handler(request) { ob.platform.create('equipment-check', {data: request.body.input, status: 'active'}); ob.storage.set('forbidden-partial', true); throw new Error('workflow failed'); }" } : file) }
    const next = await draftExtension(context, { bundle: broken, reason: 'Prove atomic backend refusal' })
    await activateExtensionDraft(context, next)
    const upgraded = (await getAppByKey(org.orgId, app.key))!
    const failed = await runExtensionAction(context, app.key, { ...request, versionId: upgraded.activeVersionId, invocationId: randomUUID() })
    assert.equal(failed.ok, false)
    assert.deepEqual(await counts(), { records: 2, storage: 1 })
    assert.ok((await db.execute(sql`select id from app_runs where org_id=${org.orgId} and app_id=${app.id} and status='error'`)).rows.length > 0, 'failed backend audit survives rollback')
    await assert.rejects(() => runExtensionAction(context, app.key, request), /changed/)
    await db.execute(sql`update apps set granted_permissions='["records.read"]'::jsonb where org_id=${org.orgId} and id=${app.id}`)
    const ungranted = await runExtensionAction(context, app.key, { ...request, versionId: upgraded.activeVersionId, invocationId: randomUUID() })
    assert.equal(ungranted.ok, false)
    assert.deepEqual(await counts(), { records: 2, storage: 1 })
    await db.execute(sql`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}','{"apps":false}'::jsonb) where id=${org.orgId}`)
    await assert.rejects(() => runExtensionAction(context, app.key, { ...request, versionId: upgraded.activeVersionId }), /not found/)
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"apps":true}'::jsonb) where id=${org.orgId}`)
    await db.execute(sql`update apps set status='disabled' where org_id=${org.orgId} and id=${app.id}`)
    await assert.rejects(() => runExtensionAction(context, app.key, { ...request, versionId: upgraded.activeVersionId }), /not found/)
  } finally { await dropScratchOrg(org.orgId) }
}))

test('native action packages reject undeclared endpoints and invalid shared field definitions', { skip: !env.OPENBOOKS_DB_URL }, async () => withBypassContext(async () => {
  const { org, context } = await fixture()
  try {
    const { example } = await describeExtensionVocabulary(context)
    const missing = { ...example, manifest: { ...example.manifest, endpoints: [] } }
    await assert.rejects(() => draftExtension(context, { bundle: missing, reason: 'Invalid endpoint' }), /declared POST/)
    await assert.rejects(() => installApp(org.orgId, context.authz.user.id, missing), /declared POST/)
    const ui = JSON.parse(example.files[0]!.content)
    ui.screens[1].fields[0].fields.push({ id: 'equipment', type: 'text', label: 'Duplicate' })
    const invalid = { ...example, files: example.files.map((file, index) => index === 0 ? { ...file, content: JSON.stringify(ui) } : file) }
    await assert.rejects(() => draftExtension(context, { bundle: invalid, reason: 'Invalid fields' }), /duplicate|Duplicate/)
    assert.equal(await getAppByKey(org.orgId, example.manifest.key), null)
  } finally { await dropScratchOrg(org.orgId) }
}))

test('management editor refuses stale installed versions and replaced drafts without discarding the current proposal', { skip: !env.OPENBOOKS_DB_URL }, async () => withBypassContext(async () => {
  const { org, context } = await fixture()
  try {
    const { createAppStarter } = await import('../apps/starter')
    const bundle = createAppStarter('sandbox')
    const first = await draftExtension(context,{bundle,reason:'Initial package',expectedBaseVersionId:null})
    const next = await draftExtension(context,{bundle,reason:'Edited package',expectedBaseVersionId:null,sourceDraft:{id:first.draftId,contentHash:first.contentHash}})
    await assert.rejects(()=>draftExtension(context,{bundle,reason:'Stale editor',expectedBaseVersionId:null,sourceDraft:{id:first.draftId,contentHash:first.contentHash}}),/draft has changed/)
    assert.equal((await getExtensionDraft(context,next.draftId)).status,'draft')
    await activateExtensionDraft(context,next)
    await assert.rejects(()=>draftExtension(context,{bundle,reason:'Stale new app',expectedBaseVersionId:null}),/changed while you were editing/)
    const current=await getAppByKey(org.orgId,'my-app')
    const { getFrontendBundle, runBridgeMethod } = await import('../apps/store')
    await assert.rejects(() => getFrontendBundle(org.orgId, current!.key, randomUUID()), /version changed/)
    const staleBridge = await runBridgeMethod({ orgId: org.orgId, user: context.authz.user, key: current!.key, method: 'storage.set', payload: { key: 'stale-write', value: true }, expectedVersionId: randomUUID(), userCan: () => true, allowedSubsidiaryIds: null })
    assert.equal(staleBridge.ok, false)
    if (!staleBridge.ok) assert.equal(staleBridge.status, 409)
    assert.equal((await db.execute(sql`select id from app_storage where org_id=${org.orgId} and app_id=${current!.id}`)).rows.length, 0)
    const revision=await draftExtension(context,{bundle:{...bundle,manifest:{...current!.manifest,version:'1.0.1'}},reason:'Current editor',expectedBaseVersionId:current!.activeVersionId})
    assert.equal((await getExtensionDraft(context,revision.draftId)).status,'draft')
  } finally { await dropScratchOrg(org.orgId) }
}))

test('library publication and withdrawal preserve package evidence and reject another organization', { skip: !env.OPENBOOKS_DB_URL }, async () => withBypassContext(async () => {
  const { org, context } = await fixture()
  const foreign = await fixture()
  try {
    const { createAppStarter } = await import('../apps/starter')
    const { publishApp, unpublishApp, isAppPublished } = await import('../apps/store')
    const source=createAppStarter('sandbox')
    const key=`library-${randomUUID()}`
    const bundle={...source,manifest:{...source.manifest as Record<string,unknown>,key}}
    const draft=await draftExtension(context,{bundle,reason:'Library lifecycle verification'})
    await activateExtensionDraft(context,draft)
    const listing=await publishApp(org.orgId,context.authz.user.id,key)
    assert.equal(await isAppPublished(key,org.orgId),true)
    await assert.rejects(()=>unpublishApp(foreign.org.orgId,foreign.context.authz.user.id,key),/owned by this organization/)
    assert.equal(await isAppPublished(key,org.orgId),true)
    await unpublishApp(org.orgId,context.authz.user.id,key)
    assert.equal(await isAppPublished(key,org.orgId),false)
    assert.equal((await getAppByKey(org.orgId,key))?.status,'installed')
    const evidence=(await db.execute<{changes:Record<string,unknown>;actor_id:string}>(sql`select changes,actor_id from audit_log where org_id=${org.orgId} and table_name='app_listings' and row_id=${listing.id} order by at,id`)).rows
    assert.equal(evidence.length,2)
    assert.ok(evidence.every(row=>row.actor_id===context.authz.user.id))
    assert.equal(evidence[0]!.changes.event,'app_listing_published')
    assert.equal(evidence[1]!.changes.event,'app_listing_withdrawn')
    assert.equal(((evidence[0]!.changes.after as {files:unknown[]}).files).length,bundle.files.length)
  } finally { await dropScratchOrg(foreign.org.orgId); await dropScratchOrg(org.orgId) }
}))
