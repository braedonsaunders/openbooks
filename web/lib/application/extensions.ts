import 'server-only'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db, withTransactionSavepoint } from '@openbooks/engine/src/db.ts'
import { can } from '../authz'
import { isFeatureEnabled } from '../features'
import { parseManifest, validateBundle, APP_PLATFORM_PERMISSIONS } from '../apps/manifest'
import { parseObjectSpecs } from '../apps/objects'
import { parseNativeExtension } from '../apps/native-ui'
import { AppError, getAppByKey, installApp, type UploadBundle } from '../apps/store'
import { requestHash } from './idempotency-core'
import { conflict, forbidden, invalidInput, notFound } from './errors'
import type { ApplicationContext } from './context'

const bundleSchema = z.object({
  manifest: z.unknown(),
  files: z.array(z.object({ path: z.string().max(200), content: z.string().max(2 * 1024 * 1024), isBinary: z.boolean().optional() }).strict()).min(1).max(100),
  grantedPermissions: z.array(z.string()).max(50).optional(),
}).strict()

export async function requireExtensionAuthor(context: ApplicationContext) {
  if (!can(context.authz, 'apps.manage') || !can(context.authz, 'admin.customization.manage')) throw forbidden('apps.manage and admin.customization.manage')
  if (!(await isFeatureEnabled(context.authz.user.orgId, 'apps'))) throw notFound('extensions')
}

/** One validation path for the agent, draft store, review and activation. */
export function validateExtensionBundle(input: unknown): UploadBundle {
  const shape = bundleSchema.safeParse(input)
  if (!shape.success) throw invalidInput(shape.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  const bundle = shape.data
  if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > 10 * 1024 * 1024) throw invalidInput('Extension package exceeds 10 MB')
  const parsed = parseManifest(bundle.manifest)
  if (!parsed.ok || !parsed.manifest) throw invalidInput(parsed.errors.join('; '))
  const manifest = parsed.manifest
  const errors = validateBundle(manifest, bundle.files.map(file => file.path)).errors
  if (new Set(bundle.files.map(file => file.path)).size !== bundle.files.length) errors.push('Duplicate file path')
  const objects = parseObjectSpecs(bundle.files)
  errors.push(...objects.errors)
  if (manifest.frontend.renderer === 'native') {
    const entry = bundle.files.find(file => file.path === manifest.frontend.entry)
    if (!entry || entry.isBinary) errors.push('Native UI entry must be a JSON text file')
    else try {
      const ui = parseNativeExtension(entry.content)
      if (ui.screens.some(screen => screen.kind === 'records') && !manifest.permissions.includes('records.read')) errors.push('Native record screens require records.read')
    } catch (error) { errors.push(error instanceof Error ? error.message : 'Invalid native UI') }
  }
  if (manifest.permissions.some(permission => !APP_PLATFORM_PERMISSIONS.includes(permission))) errors.push('Unknown extension permission')
  const granted = bundle.grantedPermissions ?? manifest.permissions
  if (granted.some(permission => !manifest.permissions.includes(permission))) errors.push('Granted permissions must be requested by the package')
  if (errors.length) throw invalidInput(errors.join('; '))
  return { manifest, files: bundle.files, grantedPermissions: granted }
}

export type ExtensionDraft = { id: string; extension_key: string; bundle: UploadBundle; content_hash: string; base_version_id: string | null; reason: string; status: string; created_at: string; changes: { added: string[]; changed: string[]; removed: string[]; newPackage: boolean } }

export async function getExtensionDraft(context: ApplicationContext, id: string): Promise<ExtensionDraft> {
  await requireExtensionAuthor(context)
  const row = (await db.execute<ExtensionDraft>(sql`select id,extension_key,bundle,content_hash,base_version_id,reason,status,created_at
    from extension_drafts where org_id=${context.authz.user.orgId} and created_by=${context.authz.user.id} and id=${id}`)).rows[0]
  if (!row) throw notFound('extension draft')
  const previous = row.base_version_id ? (await db.execute<{ path: string; content: string; isBinary: boolean }>(sql`
    select path,content,is_binary as "isBinary" from app_files where org_id=${context.authz.user.orgId} and version_id=${row.base_version_id}`)).rows : []
  const previousManifest = row.base_version_id ? (await db.execute<{ manifest: unknown }>(sql`select manifest from app_versions where org_id=${context.authz.user.orgId} and id=${row.base_version_id}`)).rows[0]?.manifest : undefined
  const before = new Map(previous.map(file => [file.path, file]))
  const after = new Map(row.bundle.files.map(file => [file.path, file]))
  row.changes = {
    newPackage: !row.base_version_id,
    added: [...after.keys()].filter(path => !before.has(path)),
    changed: [...(previousManifest && requestHash(previousManifest) !== requestHash(row.bundle.manifest) ? ['manifest.json'] : []), ...[...after.keys()].filter(path => before.has(path) && (before.get(path)!.content !== after.get(path)!.content || !!before.get(path)!.isBinary !== !!after.get(path)!.isBinary))],
    removed: [...before.keys()].filter(path => !after.has(path)),
  }
  return row
}

export async function draftExtension(context: ApplicationContext, input: { bundle: unknown; reason: string }) {
  await requireExtensionAuthor(context)
  const bundle = validateExtensionBundle(input.bundle)
  const manifest = parseManifest(bundle.manifest).manifest!
  const reason = input.reason.trim()
  if (!reason || reason.length > 2000) throw invalidInput('A 1–2000 character reason is required')
  const app = await getAppByKey(context.authz.user.orgId, manifest.key)
  const nativeOwner = (await db.execute(sql`select id from modules where org_id=${context.authz.user.orgId} and key=${manifest.key} and kind <> 'app'`)).rows[0]
  if (nativeOwner) throw conflict('This key belongs to an existing page-customization extension; use its module tools')
  const hash = requestHash(bundle)
  const row = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'extension-package:' + context.authz.user.orgId + ':' + manifest.key}, 0))`)
    await tx.execute(sql`update extension_drafts set status='discarded' where org_id=${context.authz.user.orgId} and created_by=${context.authz.user.id} and extension_key=${manifest.key} and status='draft'`)
    return (await tx.execute<{ id: string }>(sql`insert into extension_drafts(org_id,created_by,extension_key,bundle,content_hash,base_version_id,reason)
      values(${context.authz.user.orgId},${context.authz.user.id},${manifest.key},${JSON.stringify(bundle)}::jsonb,${hash},${app?.activeVersionId ?? null},${reason}) returning id`)).rows[0]!
  })
  return { draftId: row.id, contentHash: hash, key: manifest.key, status: 'draft', reviewUrl: `/admin/modules?draft=${row.id}`, previewUrl: `/admin/modules/preview/${row.id}`, requestedPermissions: manifest.permissions, activated: false }
}

export async function activateExtensionDraft(context: ApplicationContext, input: { draftId: string; contentHash: string }) {
  const draft = await getExtensionDraft(context, input.draftId)
  if (input.contentHash !== draft.content_hash) throw conflict('The reviewed package changed; reopen its review')
  const bundle = validateExtensionBundle(draft.bundle)
  const manifest = parseManifest(bundle.manifest).manifest!
  for (const permission of manifest.permissions) if (!can(context.authz, permission)) throw forbidden(permission)
  try {
    const installed = await db.transaction(tx => withTransactionSavepoint(tx, () => installApp(context.authz.user.orgId, context.authz.user.id, bundle, { id: draft.id, hash: draft.content_hash })))
    return { ...installed, activated: true, reviewUrl: `/admin/modules?module=${installed.key}`, openUrl: `/apps/${installed.key}` }
  } catch (error) {
    if (error instanceof AppError) throw conflict(error.message)
    throw error
  }
}

export async function describeExtensionVocabulary(context: ApplicationContext) {
  await requireExtensionAuthor(context)
  return {
    preferredRenderer: 'native',
    workflow: ['describe_extension_vocabulary', 'draft_extension', 'get_extension_draft', 'activate_extension_draft'],
    rules: [
      'Build an extension package, not a repository patch. It runs without a deployment of OpenBooks.',
      'Prefer native UI screens composed from the host page vocabulary and records workspaces. Only link-button widgets are supported in native page screens; record screens use the native records loader, permissions, audience, filters and drawers.',
      'Native frontend entry is a JSON document with screens. Each screen has key, title and kind page (spec: PageSpec) or records (typeKey: a published custom-record key).',
      'objects/*.json files can provision owned record_type or custom_field definitions atomically with the package. Existing foreign-owned objects cannot be overwritten. Existing data is preserved during upgrades and removal.',
      'Backend endpoints run in the existing sandbox and use the governed host API; they never receive direct database credentials. Sandboxed HTML UI remains available with frontend.renderer sandbox.',
      'draft_extension stores an immutable author-owned proposal and returns review/preview URLs. It does not install objects, run backend code, or activate anything.',
      'Preview uses local form samples for proposed record types and never executes draft backend actions or changes live records. Rehearse stateful backend behavior in a configured organization sandbox.',
      'Request explicit user approval of the returned draft before activate_extension_draft. Activation binds its exact hash and base version. Never replace it with a direct install to bypass a stale-draft refusal.',
      'Version labels are unique. Read the existing package before upgrading, preserve its owned objects and fields, and append a version.',
    ],
    permissions: APP_PLATFORM_PERMISSIONS,
    example: {
      manifest: { key: 'equipment-checks', name: 'Equipment checks', version: '1.0.0', permissions: ['records.read', 'records.create'], frontend: { renderer: 'native', entry: 'frontend/ui.json' }, endpoints: [] },
      files: [
        { path: 'frontend/ui.json', content: JSON.stringify({ screens: [{ key: 'checks', title: 'Equipment checks', kind: 'records', typeKey: 'equipment-check' }] }) },
        { path: 'objects/checks.json', content: JSON.stringify({ type: 'record_type', key: 'equipment-check', name: 'Equipment check', pluralName: 'Equipment checks', fields: [{ id: 'details', title: 'Details', fields: [{ id: 'equipment', type: 'text', label: 'Equipment', required: true }, { id: 'notes', type: 'long_text', label: 'Notes' }] }] }) },
      ],
    },
    documentation: '/docs/extensions',
  }
}

export async function getExtensionPackage(context: ApplicationContext, input: { key: string; versionId?: string }) {
  await requireExtensionAuthor(context)
  const app = await getAppByKey(context.authz.user.orgId, input.key)
  if (!app) throw notFound('extension')
  const version = (await db.execute<{ id: string; manifest: unknown }>(sql`select id,manifest from app_versions
    where org_id=${context.authz.user.orgId} and app_id=${app.id} and id=${input.versionId ?? app.activeVersionId}`)).rows[0]
  if (!version) throw notFound('extension version')
  const files = (await db.execute<{ path: string; content: string; isBinary: boolean }>(sql`select path,content,is_binary as "isBinary" from app_files
    where org_id=${context.authz.user.orgId} and app_id=${app.id} and version_id=${version.id} order by path`)).rows
  return { key: input.key, versionId: version.id, bundle: { manifest: version.manifest, files, grantedPermissions: app.grantedPermissions } }
}

export async function discardExtensionDraft(context: ApplicationContext, input: { draftId: string; contentHash: string }) {
  const draft = await getExtensionDraft(context, input.draftId)
  if (draft.content_hash !== input.contentHash) throw conflict('The reviewed package changed')
  if (draft.status === 'applied') throw conflict('An activated version cannot be discarded')
  await db.transaction(async tx => {
    const changed = (await tx.execute(sql`update extension_drafts set status='discarded' where org_id=${context.authz.user.orgId} and id=${draft.id} and created_by=${context.authz.user.id} and status='draft' returning id`)).rows
    if (changed.length) await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${context.authz.user.orgId},'extension_drafts',${draft.id},'update',${JSON.stringify({ event: 'extension_draft_discarded', contentHash: draft.content_hash, before: { status: 'draft' }, after: { status: 'discarded' } })}::jsonb,${context.authz.user.id})`)
    else if ((await tx.execute<{ status: string }>(sql`select status from extension_drafts where org_id=${context.authz.user.orgId} and id=${draft.id}`)).rows[0]?.status !== 'discarded') throw conflict('An activated version cannot be discarded')
  })
  return { discarded: true }
}
