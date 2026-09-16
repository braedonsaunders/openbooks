import { extensionContributionTargetErrors } from './contribution-targets'
import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/src/db.ts'
import {
  runAppEndpoint,
  type AppHostAdapters,
  type AppRequest,
  type AppRecordsAdapter,
  type AppStorageAdapter,
} from '@openbooks/engine/src/apps-runtime.ts'
import {
  executeAppInvocation,
  deriveAppInvocationKey,
  AppInvocationInFlightError,
  AppInvocationRequestMismatchError,
  type AppInvocationAuditRow,
  type AppInvocationAttempt,
} from '@openbooks/engine/src/apps-invocations.ts'
import { createScriptJournal, type ScriptJournalInput } from '@openbooks/engine/src/journal-writes.ts'
import { requestHash } from '@/lib/application/idempotency-core'
import { parseManifest, validateBundle, validateAppToolsForInstall, contentTypeFor, type AppManifest } from './manifest'
import { APP_CAPABILITIES } from './manifest'
import { projectExtensionPage } from '@openbooks/engine/src/extensions/pages.ts'
import { projectSupplementalContributions, withdrawSupplementalContributions } from '@openbooks/engine/src/extensions/projections.ts'
import { EXTENSION_CONTRIBUTION_PERMISSIONS } from './contributions'
import { actorHasPermission } from '@openbooks/engine/src/actor-permissions.ts'
import { parseNativeExtension } from './native-ui'
import { parseObjectSpecs, type ParsedObjects } from './objects'
import { createAppPlatformAdapter, AppPlatformError } from './platform'
import type { SessionUser } from '@/lib/auth'
import { permissionSetCovers } from '@/lib/permissions'
import { lockCustomFieldKeys } from '../custom-field-write-lock'
import { validateCustomFieldDefinition, type ExistingFieldDef } from '../custom-field-definition'
import { normalizeCustomFieldConfig } from '../custom-field-config'
import { isCustomFieldTargetEnabled } from '../customization/gates'
import { featureGateLockKey, isFeatureEnabled } from '../features'
import { documentRevisionSql } from '@openbooks/engine/src/document-revision.ts'
import { inTypeAudience, hasSubsidiaryField, loadRecordTypeByKey, type RecordTypeRow } from '@/lib/records'
import { lintRecordFields } from '../record-schema'
import { pgTextArrayLiteral } from '@/lib/pg-array'

/**
 * Apps server store — every function is org-scoped: the caller passes the
 * authenticated user's orgId and no row outside that org is read, written, or
 * run. Wires the real DB-backed adapters into the sandbox runtime (which itself
 * never touches the DB — see engine/src/apps-runtime.ts).
 */

export type AppRow = {
  id: string
  key: string
  name: string
  description: string | null
  iconKey: string
  status: 'installed' | 'disabled'
  activeVersionId: string | null
  grantedPermissions: string[]
  version: string | null
  manifest: AppManifest | null
};

export interface UploadBundle {
  manifest: unknown
  files: { path: string; content: string; isBinary?: boolean }[]
  /** Permissions the admin chose to grant (defaults to those requested). */
  grantedPermissions?: string[]
}

async function rows<T extends Record<string, unknown> = Record<string, unknown>>(q: ReturnType<typeof sql>) {
  const r = (await db.execute<T>(q))
  return r.rows
}

/** List installed Apps for an org (admin view). */
export async function listApps(orgId: string): Promise<AppRow[]> {
  return rows<AppRow>(sql`
    select a.id, a.key, a.name, a.description, a.icon_key as "iconKey", a.status,
           a.active_version_id as "activeVersionId", a.granted_permissions as "grantedPermissions",
           v.version, v.manifest
      from apps a
      left join app_versions v on v.id = a.active_version_id and v.org_id = a.org_id
     where a.org_id = ${orgId}
     order by a.sort_order, a.name`)
}

/** Load one App (with its active version's manifest) by slug. */
export async function getAppByKey(orgId: string, key: string): Promise<AppRow | null> {
  const r = await rows<AppRow>(sql`
    select a.id, a.key, a.name, a.description, a.icon_key as "iconKey", a.status,
           a.active_version_id as "activeVersionId", a.granted_permissions as "grantedPermissions",
           v.version, v.manifest
      from apps a
      left join app_versions v on v.id = a.active_version_id and v.org_id = a.org_id
     where a.org_id = ${orgId} and a.key = ${key}
     limit 1`)
  return r[0] ?? null
}

/**
 * Install (or upgrade) an App from an uploaded bundle. Validates the manifest
 * and that every referenced file exists, then in one transaction: upserts the
 * app row, inserts an immutable version + its files, and points the app at the
 * new active version. Returns the app key.
 */
/**
 * Canonical JSON for manifest byte-equality. jsonb reorders object keys on
 * storage, so a naive stringify mismatches identical content; sorting keys
 * recursively makes equal documents compare equal regardless of which side
 * (projector object or stored jsonb) they came from.
 */

/** The reinstall-stable subset of an absorbed manifest: everything except
 *  the row-identity provenance (appId/appVersionId), which necessarily
 *  changes across reinstalls because the apps/version rows are new. */

export async function installApp(orgId: string, userId: string, bundle: UploadBundle, draft?: { id: string; hash: string }): Promise<{ key: string }> {
  const parsed = parseManifest(bundle.manifest)
  if (!parsed.ok || !parsed.manifest) throw new AppError(`invalid manifest: ${parsed.errors.join('; ')}`)
  const manifest = parsed.manifest

  const paths = bundle.files.map((f) => f.path)
  if (new Set(paths).size !== paths.length) throw new AppError('bundle has duplicate file paths')
  const vb = validateBundle(manifest, paths)
  if (!vb.ok) throw new AppError(`invalid bundle: ${vb.errors.join('; ')}`)

  // Grant only permissions the manifest actually requested (admin may narrow).
  const requested = new Set(manifest.permissions)
  const granted = (bundle.grantedPermissions ?? manifest.permissions).filter((p) => requested.has(p))

  // App-declared assistant tools ride in the stored manifest, so their
  // contract is enforced here, before anything is written: tool permissions
  // against the ADMIN-GRANTED set, and assistant names against the built-in
  // catalogs. The static names load lazily so the store never joins the
  // assistant-registry import cycle at module load.
  const { ASSISTANT_TOOLS } = await import('../assistant/registry')
  const { APPLICATION_TOOLS } = await import('../application/tool-catalog')
  const staticNames = new Set([
    ...ASSISTANT_TOOLS.map((tool) => tool.name),
    ...APPLICATION_TOOLS.map((tool) => tool.name),
  ])
  const toolErrors = validateAppToolsForInstall(manifest, granted, staticNames)
  if (toolErrors.length) throw new AppError(`invalid app tools: ${toolErrors.join('; ')}`)

  // objects/*.json — validate BEFORE the transaction so a bad spec is a clean 400.
  const objects = parseObjectSpecs(bundle.files)
  if (objects.errors.length) throw new AppError(`invalid objects: ${objects.errors.join('; ')}`)
  for (const field of objects.customFields) {
    const error = validateCustomFieldDefinition({ ...field })
    if (error) throw new AppError(`invalid custom field "${field.key}": ${error}`)
    field.config = normalizeCustomFieldConfig(field.config)
  }

  if (manifest.frontend.renderer === 'native') {
    const entry = bundle.files.find(file => file.path === manifest.frontend.entry)
    if (!entry || entry.isBinary) throw new AppError('Native UI entry must be a JSON text file')
    try {
      const ui = parseNativeExtension(entry.content, manifest)
      if (ui.screens.some(screen => screen.kind === 'records') && !manifest.permissions.includes('records.read')) {
        throw new AppError('Native record screens require records.read')
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(`invalid native UI: ${error instanceof Error ? error.message : 'invalid JSON'}`)
    }
  }

  const targetErrors = extensionContributionTargetErrors(manifest.contributions ?? [])
  if (targetErrors.length) throw new AppError(targetErrors.join('; '))
  const manifestJson = JSON.stringify(manifest)

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`extension-projections:${orgId}`}, 0))`)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'extension-package:' + orgId + ':' + manifest.key}, 0))`)
    let draftReason: string | null = null
    if (draft) {
      const proposal = (await tx.execute<{ bundle: unknown; content_hash: string; base_version_id: string | null; status: string; reason: string }>(sql`
        select bundle, content_hash, base_version_id, status, reason from extension_drafts
        where org_id=${orgId} and id=${draft.id} and created_by=${userId} for update
      `)).rows[0]
      if (!proposal || proposal.content_hash !== draft.hash || requestHash(bundle) !== proposal.content_hash) throw new AppError('The reviewed extension draft does not match', 409)
      draftReason = proposal.reason
      if (proposal.status === 'applied') return
      if (proposal.status !== 'draft') throw new AppError('This extension draft is no longer available', 409)
      const current = (await tx.execute<{ active_version_id: string | null }>(sql`select active_version_id from apps where org_id=${orgId} and key=${manifest.key} for update`)).rows[0]
      if ((current?.active_version_id ?? null) !== proposal.base_version_id) throw new AppError('The installed extension changed after this draft was created; create and review a new draft', 409)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${featureGateLockKey(orgId)}, 0))`)
      if (!(await isFeatureEnabled(orgId, 'apps', tx))) throw new AppError('Extensions are disabled', 404)
    }

    if (objects.customFields.length) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${featureGateLockKey(orgId)}, 0))`)
      for (const field of objects.customFields) {
        if (!(await isCustomFieldTargetEnabled(orgId, field.targetTable, field.targetKind, tx))) {
          throw new AppError(`custom field "${field.key}" targets a disabled feature`, 404)
        }
      }
    }
    for (const contribution of manifest.contributions ?? []) {
      const permission = EXTENSION_CONTRIBUTION_PERMISSIONS[contribution.kind]
      if (!granted.includes(permission) || !(await actorHasPermission(tx, orgId, userId, permission))) throw new AppError(`${permission} required for ${contribution.kind}`, 403)
    }
    // Prior grants (absent on first install) become the audit "before" state.
    const prior = (await tx.execute<{ grantedPermissions: string[] | null; activeVersionId: string | null }>(sql`
      select active_version_id as "activeVersionId", granted_permissions as "grantedPermissions" from apps
       where org_id = ${orgId} and key = ${manifest.key} limit 1`))

    // Upsert the app row (create, or update presentation on reinstall/upgrade).
    const appRes = (await tx.execute<{ id: string }>(sql`
      insert into apps (org_id, key, name, description, icon_key, status, granted_permissions, created_by, updated_by)
      values (${orgId}, ${manifest.key}, ${manifest.name}, ${manifest.description ?? null},
              ${manifest.icon ?? 'box'}, 'installed', ${JSON.stringify(granted)}::jsonb,
              ${userId}, ${userId})
      on conflict (org_id, key) do update set
        name = excluded.name, description = excluded.description, icon_key = excluded.icon_key,
        granted_permissions = excluded.granted_permissions,
        status = 'installed', updated_at = now(), updated_by = ${userId}
      where apps.org_id = ${orgId}
      returning id`))
    const appId = appRes.rows[0]!.id

    // Permission grants are audited with before/after evidence. Install keeps
    // the reviewed grants from the draft, bounded by its requested permissions.
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'apps', ${appId}, 'insert',
        ${JSON.stringify({
          appKey: manifest.key,
          permissionsBefore: prior.rows[0]?.grantedPermissions ?? null,
          permissionsAfter: granted,
        })}::jsonb,
        ${userId})`)

    // Reject a duplicate version rather than silently overwriting history.
    const existing = (await tx.execute(
      sql`select 1 from app_versions where org_id = ${orgId} and app_id = ${appId} and version = ${manifest.version} limit 1`,
    ))
    if (existing.rows.length) throw new AppError(`version ${manifest.version} already exists for this app`)

    const verRes = (await tx.execute<{ id: string }>(sql`
      insert into app_versions (org_id, app_id, version, manifest, status, created_by, updated_by)
      values (${orgId}, ${appId}, ${manifest.version}, ${manifestJson}::jsonb, 'active', ${userId}, ${userId})
      returning id`))
    const versionId = verRes.rows[0]!.id

    for (const f of bundle.files) {
      const { contentType } = contentTypeFor(f.path)
      await tx.execute(sql`
        insert into app_files (org_id, app_id, version_id, path, kind, content_type, content, is_binary, size, created_by, updated_by)
        values (${orgId}, ${appId}, ${versionId}, ${f.path}, ${vb.kinds[f.path]}, ${contentType},
                ${f.content}, ${!!f.isBinary}, ${f.content.length}, ${userId}, ${userId})`)
    }

    // Provision declared objects (record types + custom fields). May create
    // new objects or upgrade ones THIS app provisioned before; a key collision
    // with a user-authored object aborts the whole install transaction.
    const prevRes = (await tx.execute<{ provisioned: { recordTypes?: string[]; customFields?: string[] } }>(sql`select provisioned from apps where id = ${appId} and org_id = ${orgId}`))
    const prev = prevRes.rows[0]?.provisioned ?? {}
    const owned = {
      recordTypes: new Set(prev.recordTypes ?? []),
      customFields: new Set(prev.customFields ?? []),
    }
    // A fresh row after an uninstall has lost its ownership map; recover it
    // from the uninstall audit evidence so the reinstall may upgrade the
    // objects it provisioned instead of colliding with them forever.
    if (!prior.rows.length) {
      await adoptUninstalledProvenance(tx, orgId, userId, appId, manifest.key, objects, owned)
    }
    const provisioned = await provisionObjects(tx, orgId, userId, objects, owned, { appKey: manifest.key, appVersionId: versionId })
    if (manifest.frontend.renderer === 'native') {
      const ui = parseNativeExtension(bundle.files.find(file => file.path === manifest.frontend.entry)!.content)
      for (const screen of ui.screens) if (screen.kind === 'records') {
        const type = (await tx.execute(sql`select id from custom_record_types where org_id=${orgId} and key=${screen.typeKey} and status='published'`)).rows[0]
        if (!type) throw new AppError(`Native screen ${screen.key} requires a published record type: ${screen.typeKey}`, 409)
      }
    }
    await tx.execute(sql`update apps set provisioned = ${JSON.stringify(provisioned)}::jsonb where id = ${appId} and org_id = ${orgId}`)

    // Supersede the previous active version, then activate the new one.
    await tx.execute(sql`update app_versions set status = 'superseded' where app_id = ${appId} and org_id = ${orgId} and id <> ${versionId} and status = 'active'`)
    await tx.execute(sql`update apps set active_version_id = ${versionId}, updated_at = now() where id = ${appId} and org_id = ${orgId}`)

    const projectionReason = draftReason ?? `Install extension ${manifest.key} ${manifest.version}`
    await withdrawExtensionPages(tx, orgId, userId, appId, projectionReason)
    for (const contribution of manifest.contributions ?? []) if (contribution.kind === 'page') {
      await projectExtensionPage(tx, { orgId, actorId: userId, extensionId: appId, extensionKey: manifest.key, version: manifest.version, versionId, contribution, reason: projectionReason })
    }
    await projectSupplementalContributions(tx, { orgId, actorId: userId, extensionId: appId, extensionKey: manifest.key, versionId, previousVersionId: prior.rows[0]?.activeVersionId,
      contributions: (manifest.contributions ?? []).filter(contribution => contribution.kind !== 'page'), reason: projectionReason })

    if (draft) {
      await tx.execute(sql`update extension_drafts set status='applied', applied_at=now() where org_id=${orgId} and id=${draft.id}`)
      await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
        values(${orgId},'extension_drafts',${draft.id},'update',${JSON.stringify({ event: 'extension_draft_applied', reason: draftReason, contentHash: draft.hash, appKey: manifest.key, before: { status: 'draft' }, after: { status: 'applied' } })}::jsonb,${userId})`)
    }

  })

  return { key: manifest.key }
}

/**
 * Reinstall provenance recovery. Uninstall deliberately preserves provisioned
 * objects (they hold living master data) but deletes the apps row that carried
 * the ownership map — the only thing that lets a later install upgrade rather
 * than 409 on them. deleteApp's audit row keeps that map verbatim
 * (`changes.before.provisioned`, keyed by app key), so a fresh install of the
 * same key consults the LATEST uninstall evidence and re-adopts an object only
 * when both hold:
 *   - that evidence lists the object (record type key / "table:key"), and
 *   - the object row predates the uninstall — a same-key object authored after
 *     the uninstall belongs to the user and still collides.
 * Every adoption is itself audited against the new apps row, so provenance
 * never changes hands silently. Mutates `owned` in place.
 */
async function adoptUninstalledProvenance(
  tx: SqlExecutor,
  orgId: string,
  userId: string,
  appId: string,
  appKey: string,
  objects: ParsedObjects,
  owned: { recordTypes: Set<string>; customFields: Set<string> },
): Promise<void> {
  if (!objects.recordTypes.length && !objects.customFields.length) return
  const evidence = (await tx.execute<{
    id: string
    at: Date
    provisioned: { recordTypes?: unknown; customFields?: unknown } | null
  }>(sql`
    select id, at, changes->'before'->'provisioned' as provisioned
      from audit_log
     where org_id = ${orgId} and table_name = 'apps' and action = 'delete'
       and changes->>'event' = 'app_uninstall'
       and changes->'before'->>'key' = ${appKey}
     order by at desc, id desc
     limit 1`)).rows[0]
  if (!evidence) return
  const listed = (value: unknown): Set<string> =>
    new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
  const recordTypes = listed(evidence.provisioned?.recordTypes)
  const customFields = listed(evidence.provisioned?.customFields)

  const adopted = { recordTypes: [] as string[], customFields: [] as string[] }
  for (const rt of objects.recordTypes) {
    if (owned.recordTypes.has(rt.key) || !recordTypes.has(rt.key)) continue
    const survived = (await tx.execute(sql`
      select 1 from custom_record_types
       where org_id = ${orgId} and key = ${rt.key} and created_at <= ${evidence.at}
       limit 1`)).rows.length > 0
    if (survived) adopted.recordTypes.push(rt.key)
  }
  for (const cf of objects.customFields) {
    const scoped = `${cf.targetTable}:${cf.key}`
    if (owned.customFields.has(scoped) || !customFields.has(scoped)) continue
    const survived = (await tx.execute(sql`
      select 1 from custom_field_defs
       where org_id = ${orgId} and target_table = ${cf.targetTable} and key = ${cf.key}
         and created_at <= ${evidence.at}
       limit 1`)).rows.length > 0
    if (survived) adopted.customFields.push(scoped)
  }
  if (!adopted.recordTypes.length && !adopted.customFields.length) return

  for (const key of adopted.recordTypes) owned.recordTypes.add(key)
  for (const key of adopted.customFields) owned.customFields.add(key)
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'apps', ${appId}, 'update',
      ${JSON.stringify({
        event: 'app_provenance_adopted',
        appKey,
        evidenceAuditId: evidence.id,
        before: { provisioned: { recordTypes: [], customFields: [] } },
        after: { provisioned: adopted },
      })}::jsonb,
      ${userId})`)
}

/** Upsert declared objects inside the install transaction. Returns provenance. */
async function provisionObjects(
  tx: SqlExecutor,
  orgId: string,
  userId: string,
  objects: ParsedObjects,
  owned: { recordTypes: Set<string>; customFields: Set<string> },
  source: { appKey: string; appVersionId: string },
): Promise<{ recordTypes: string[]; customFields: string[] }> {
  const recordTypes = new Set(owned.recordTypes)
  const customFields = new Set(owned.customFields)
  await lockCustomFieldKeys(tx, orgId, objects.customFields)

  for (const rt of objects.recordTypes) {
    const existing = (await tx.execute(
      sql`select id from custom_record_types where org_id = ${orgId} and key = ${rt.key} limit 1`,
    )) as { rows: { id: string }[] }
    if (existing.rows[0]) {
      if (!owned.recordTypes.has(rt.key)) {
        throw new AppError(`record type "${rt.key}" already exists and was not provisioned by this app`, 409)
      }
      await tx.execute(sql`
        update custom_record_types
           set name = ${rt.name}, plural_name = ${rt.pluralName}, icon_key = ${rt.iconKey},
               fields = ${JSON.stringify(rt.fields)}::jsonb, show_in_nav = ${rt.showInNav},
               updated_at = now(), updated_by = ${userId}
         where id = ${existing.rows[0].id} and org_id = ${orgId}`)
    } else {
      await tx.execute(sql`
        insert into custom_record_types (org_id, key, name, plural_name, icon_key, fields, status, show_in_nav, created_by, updated_by)
        values (${orgId}, ${rt.key}, ${rt.name}, ${rt.pluralName}, ${rt.iconKey},
                ${JSON.stringify(rt.fields)}::jsonb, 'published', ${rt.showInNav}, ${userId}, ${userId})`)
    }
    recordTypes.add(rt.key)
  }

  for (const cf of objects.customFields) {
    const scoped = `${cf.targetTable}:${cf.key}`
    const before = (await tx.execute<ExistingFieldDef>(sql`
      select custom_field_defs.*, ${documentRevisionSql(sql`created_at`)} as created_at,
             ${documentRevisionSql(sql`updated_at`)} as updated_at from custom_field_defs
       where org_id = ${orgId} and target_table = ${cf.targetTable} and key = ${cf.key} limit 1 for update`,
    )).rows[0]
    let after: ExistingFieldDef
    if (before) {
      if (!owned.customFields.has(scoped)) {
        throw new AppError(`custom field "${scoped}" already exists and was not provisioned by this app`, 409)
      }
      const error = validateCustomFieldDefinition({ ...cf }, before)
      if (error) throw new AppError(`invalid custom field "${cf.key}": ${error}`)
      after = (await tx.execute<ExistingFieldDef>(sql`
        update custom_field_defs
           set label = ${cf.label}, field_type = ${cf.fieldType}, target_kind = ${cf.targetKind},
               config = ${JSON.stringify(cf.config)}::jsonb, is_required = ${cf.isRequired},
               is_active = true, updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${userId}
         where id = ${before.id} and org_id = ${orgId}
         returning custom_field_defs.*, ${documentRevisionSql(sql`created_at`)} as created_at,
                   ${documentRevisionSql(sql`updated_at`)} as updated_at`)).rows[0]!
    } else {
      const created = await tx.execute<ExistingFieldDef>(sql`
        insert into custom_field_defs (org_id, target_table, target_kind, key, label, field_type, config, is_required, created_by, updated_by)
        values (${orgId}, ${cf.targetTable}, ${cf.targetKind}, ${cf.key}, ${cf.label}, ${cf.fieldType},
                ${JSON.stringify(cf.config)}::jsonb, ${cf.isRequired}, ${userId}, ${userId})
        on conflict do nothing returning custom_field_defs.*, ${documentRevisionSql(sql`created_at`)} as created_at,
                   ${documentRevisionSql(sql`updated_at`)} as updated_at`)
      if (!created.rows.length) throw new AppError(`custom field "${scoped}" already exists`, 409)
      after = created.rows[0]!
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'custom_field_defs', ${after.id}, ${before ? 'update' : 'insert'},
              ${JSON.stringify({ ...(before ? { before } : {}), after, source })}::jsonb, ${userId})`)
    customFields.add(scoped)
  }

  return { recordTypes: [...recordTypes], customFields: [...customFields] }
}

async function withdrawExtensionPages(tx: { execute: typeof db.execute }, orgId: string, actorId: string, appId: string, reason: string) {
  const changed = (await tx.execute<{ id: string; extension_version_id: string }>(sql`update page_specs set is_active=false,updated_at=now(),updated_by=${actorId}
    where org_id=${orgId} and is_active and extension_version_id in (select id from app_versions where org_id=${orgId} and app_id=${appId}) returning id,extension_version_id`)).rows
  for (const row of changed) await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values(${orgId},'page_specs',${row.id},'update',${JSON.stringify({ event:'extension_page_withdrawn',reason,before:{is_active:true,versionId:row.extension_version_id},after:{is_active:false,versionId:row.extension_version_id} })}::jsonb,${actorId})`)
}

export async function setAppStatus(
  orgId: string,
  userId: string,
  key: string,
  status: 'installed' | 'disabled',
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`extension-projections:${orgId}`}, 0))`)
    const existing = await tx.execute<{
      id: string
      key: string
      name: string
      status: 'installed' | 'disabled'
    }>(sql`
      select id, key, name, status
        from apps
       where org_id = ${orgId} and key = ${key}
       for update`)
    const app = existing.rows[0]
    if (!app || app.status === status) return

    const version = (await tx.execute<{ id: string; manifest: AppManifest }>(sql`select v.id,v.manifest from app_versions v join apps a on a.org_id=v.org_id and a.id=v.app_id where a.org_id=${orgId} and a.id=${app.id} and v.id=a.active_version_id`)).rows[0]
    if (status === 'disabled') {
      await withdrawExtensionPages(tx, orgId, userId, app.id, 'Disable extension')
      await withdrawSupplementalContributions(tx, { orgId, actorId:userId,extensionId:app.id,extensionKey:key,reason:'Disable extension' })
    } else if (version) {
      for (const contribution of version.manifest.contributions ?? []) if (!(await actorHasPermission(tx, orgId, userId, EXTENSION_CONTRIBUTION_PERMISSIONS[contribution.kind]))) throw new AppError('Permission required to enable these extension contributions', 403)
      for (const contribution of version.manifest.contributions ?? []) if (contribution.kind === 'page') await projectExtensionPage(tx, { orgId,actorId:userId,extensionId:app.id,extensionKey:key,version:version.manifest.version,versionId:version.id,contribution,reason:'Enable extension' })
      await projectSupplementalContributions(tx,{orgId,actorId:userId,extensionId:app.id,extensionKey:key,versionId:version.id,previousVersionId:version.id,contributions:(version.manifest.contributions ?? []).filter(item=>item.kind!=='page'),reason:'Enable extension'})
    }
    await tx.execute(sql`
      update apps
         set status = ${status}, updated_at = now(), updated_by = ${userId}
       where org_id = ${orgId} and id = ${app.id}`)
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'apps', ${app.id}, 'update',
        ${JSON.stringify({
          event: 'app_status_changed',
          before: { key: app.key, name: app.name, status: app.status },
          after: { key: app.key, name: app.name, status },
        })}::jsonb,
        ${userId})`)

  })
}

export async function deleteApp(orgId: string, userId: string, key: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`extension-projections:${orgId}`}, 0))`)
    const existing = await tx.execute<{
      id: string
      orgId: string
      key: string
      name: string
      description: string | null
      iconKey: string
      status: 'installed' | 'disabled'
      activeVersionId: string | null
      grantedPermissions: string[]
      sortOrder: number
      provisioned: unknown
      createdAt: Date
      createdBy: string | null
      updatedAt: Date
      updatedBy: string | null
      version: string | null
      manifest: AppManifest | null
    }>(sql`
      select a.id, a.org_id as "orgId", a.key, a.name, a.description,
             a.icon_key as "iconKey", a.status,
             a.active_version_id as "activeVersionId",
             a.granted_permissions as "grantedPermissions", a.sort_order as "sortOrder",
             a.provisioned, a.created_at as "createdAt", a.created_by as "createdBy",
             a.updated_at as "updatedAt", a.updated_by as "updatedBy",
             v.version, v.manifest
        from apps a
        left join app_versions v on v.id = a.active_version_id and v.org_id = a.org_id
       where a.org_id = ${orgId} and a.key = ${key}
       for update of a`)
    const app = existing.rows[0]
    if (!app) return

    // App-owned rows cascade with the app. Capture the complete execution and
    // code evidence first so the audit row remains useful after uninstall.
    const versions = await tx.execute(sql`
      select id, org_id as "orgId", app_id as "appId", version, manifest, status,
             created_at as "createdAt", created_by as "createdBy",
             updated_at as "updatedAt", updated_by as "updatedBy"
        from app_versions
       where org_id = ${orgId} and app_id = ${app.id}
       order by created_at, id`)
    const files = await tx.execute(sql`
      select id, org_id as "orgId", app_id as "appId", version_id as "versionId", path,
             kind, content_type as "contentType", content, is_binary as "isBinary", size,
             created_at as "createdAt", created_by as "createdBy",
             updated_at as "updatedAt", updated_by as "updatedBy"
        from app_files
       where org_id = ${orgId} and app_id = ${app.id}
       order by version_id, path`)
    const runs = await tx.execute(sql`
      select id, org_id as "orgId", app_id as "appId", version_id as "versionId", endpoint,
             status, units, logs, error_message as "errorMessage", duration_ms as "durationMs",
             actor_id as "actorId", at
        from app_runs
       where org_id = ${orgId} and app_id = ${app.id}
       order by at, id`)
    const storage = await tx.execute(sql`
      select id, org_id as "orgId", app_id as "appId", namespace, key, value,
             created_at as "createdAt", created_by as "createdBy",
             updated_at as "updatedAt", updated_by as "updatedBy"
        from app_storage
       where org_id = ${orgId} and app_id = ${app.id}
       order by namespace, key`)

    const preserveHistory = versions.rows.some(version => Array.isArray((version.manifest as AppManifest | null)?.contributions) && ((version.manifest as AppManifest).contributions?.length ?? 0) > 0)
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'apps', ${app.id}, ${preserveHistory ? 'update' : 'delete'},
        ${JSON.stringify({
          event: 'app_uninstall',
          // Keep associated versions/files/runs under `before`; unlike the
          // app row, these children are about to disappear via FK cascade.
          before: {
            ...app,
            versions: versions.rows,
            files: files.rows,
            runs: runs.rows,
            storage: storage.rows,
          },
          after: preserveHistory ? { status: 'disabled', historyPreserved: true } : null,
        })}::jsonb,
        ${userId})`)

    await withdrawExtensionPages(tx,orgId,userId,app.id,'Uninstall extension')
    await withdrawSupplementalContributions(tx,{orgId,actorId:userId,extensionId:app.id,extensionKey:key,reason:'Uninstall extension'})
    if (preserveHistory) {
      await tx.execute(sql`update apps set status='disabled',updated_at=now(),updated_by=${userId} where org_id=${orgId} and id=${app.id}`)
      return
    }
    await tx.execute(sql`delete from apps where org_id = ${orgId} and id = ${app.id}`)
  })
}

/** Build the inlined frontend bundle the AppFrame renders. */
export async function getFrontendBundle(
  orgId: string,
  key: string,
  expectedVersionId?: string,
): Promise<{ entry: string; entryHtml: string; replacements: Record<string, string> }> {
  const app = await getAppByKey(orgId, key)
  if (!app) throw new AppError('app not found', 404)
  if (app.status !== 'installed') throw new AppError('app is disabled', 403)
  if (!app.activeVersionId || !app.manifest) throw new AppError('app has no active version', 409)

  const files = await rows<{ path: string; contentType: string; content: string; isBinary: boolean }>(sql`
    select path, content_type as "contentType", content, is_binary as "isBinary"
      from app_files
     where org_id = ${orgId} and version_id = ${app.activeVersionId} and kind in ('frontend', 'asset')`)

  if (expectedVersionId && expectedVersionId !== app.activeVersionId) throw new AppError('This app version changed. Reload the app before continuing.',409)
  const entry = app.manifest.frontend.entry
  const entryFile = files.find((f) => f.path === entry)
  if (!entryFile) throw new AppError('frontend entry missing from bundle', 500)

  const replacements: Record<string, string> = {}
  for (const f of files) {
    if (f.path === entry) continue
    const mediatype = f.contentType.replace(/;\s*/g, ';') // data URLs can't contain spaces
    const b64 = f.isBinary ? f.content : Buffer.from(f.content, 'utf8').toString('base64')
    replacements[f.path] = `data:${mediatype};base64,${b64}`
  }

  return { entry, entryHtml: entryFile.content, replacements }
}

// ---------------------------------------------------------------------------
// Adapters — the DB-backed capabilities handed to the sandbox runtime.
// ---------------------------------------------------------------------------

function storageAdapter(orgId: string, appId: string): AppStorageAdapter {
  return {
    async get(key, namespace) {
      const r = await rows<{ value: unknown }>(
        sql`select value from app_storage where org_id = ${orgId} and app_id = ${appId} and namespace = ${namespace} and key = ${key} limit 1`,
      )
      return r[0]?.value ?? null
    },
    async set(key, value, namespace) {
      await db.execute(sql`
        insert into app_storage (org_id, app_id, namespace, key, value)
        values (${orgId}, ${appId}, ${namespace}, ${key}, ${JSON.stringify(value ?? null)}::jsonb)
        on conflict (app_id, namespace, key) do update set value = excluded.value, updated_at = now()
        where app_storage.org_id = ${orgId}`)
    },
    async list(prefix, namespace) {
      const like = prefix.replace(/[%_\\]/g, (m) => '\\' + m) + '%'
      return rows<{ key: string; value: unknown }>(sql`
        select key, value from app_storage
         where org_id = ${orgId} and app_id = ${appId} and namespace = ${namespace} and key like ${like}
         order by key limit 500`)
    },
    async delete(key, namespace) {
      await db.execute(sql`delete from app_storage where org_id = ${orgId} and app_id = ${appId} and namespace = ${namespace} and key = ${key}`)
    },
  }
}

function recordsAdapter(
  orgId: string,
  user: SessionUser,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): AppRecordsAdapter {
  /**
   * The bridge caller's subsidiary fence for one custom-record type. Types
   * declaring the conventional subsidiary_id field are filtered to the
   * caller's visible entities (fail-closed on an empty fence); types without
   * the field stay org-visible — the same predicate platform.ts enforces.
   */
  function scopeFor(type: RecordTypeRow): SQL {
    if (allowedSubsidiaryIds === null) return sql``
    const lint = lintRecordFields(type.fields, type.name)
    if (!lint.success || !hasSubsidiaryField(lint.sections)) return sql``
    const ids = [...allowedSubsidiaryIds]
    return ids.length > 0
      ? sql`and data ->> ${'subsidiary_id'} = any(${pgTextArrayLiteral(ids)}::text[])`
      : sql`and false`
  }
  return {
    async list(typeKey, filters) {
      const type = await loadRecordTypeByKey(orgId, typeKey)
      if (
        !type ||
        type.status !== 'published' ||
        !inTypeAudience(user.roles.map(({ key }) => key), type.allowed_roles)
      ) return []
      const status = typeof filters?.status === 'string' ? (filters.status as string) : null
      const scope = scopeFor(type)
      return rows(sql`
        select id, record_number as "recordNumber", status, data
          from custom_records
         where org_id = ${orgId} and type_key = ${typeKey}
           ${status ? sql`and status = ${status}` : sql``}
           ${scope}
         order by created_at desc limit 200`)
    },
    async get(typeKey, id) {
      const type = await loadRecordTypeByKey(orgId, typeKey)
      if (
        !type ||
        type.status !== 'published' ||
        !inTypeAudience(user.roles.map(({ key }) => key), type.allowed_roles)
      ) return null
      const scope = scopeFor(type)
      const r = await rows(sql`
        select id, record_number as "recordNumber", status, data
          from custom_records
         where org_id = ${orgId} and type_key = ${typeKey} and id = ${id}
           ${scope}
         limit 1`)
      return r[0] ?? null
    },
  }
}

/**
 * Run one bridge method for an installed App on behalf of a user. `userCan` is
 * the caller's effective-permission predicate — records access requires BOTH
 * the App's granted `records.read` AND the user's own records.read (app ∩ user).
 */
export async function runBridgeMethod(opts: {
  orgId: string
  user: SessionUser
  key: string
  method: string
  payload: any
  expectedVersionId?: string
  userCan: (perm: string) => boolean
  allowedSubsidiaryIds: ReadonlySet<string> | null
}): Promise<{ ok: true; result: unknown } | { ok: false; error: string; status: number }> {
  const app = await getAppByKey(opts.orgId, opts.key)
  if (!app || !app.manifest) return { ok: false, error: 'app not found', status: 404 }
  if (app.status !== 'installed') return { ok: false, error: 'app is disabled', status: 403 }
  if (opts.expectedVersionId && opts.expectedVersionId !== app.activeVersionId) return { ok:false,error:'This app version changed. Reload the app before continuing.',status:409 }

  const recordsGranted =
    permissionSetCovers(new Set(app.grantedPermissions), APP_CAPABILITIES.RECORDS_READ) &&
    opts.userCan(APP_CAPABILITIES.RECORDS_READ)
  const glGranted =
    permissionSetCovers(new Set(app.grantedPermissions), APP_CAPABILITIES.GL_POST) && opts.userCan(APP_CAPABILITIES.GL_POST)

  const platform = createAppPlatformAdapter({
    orgId: opts.orgId,
    user: opts.user,
    grantedPermissions: app.grantedPermissions,
    userCan: opts.userCan,
    allowedSubsidiaryIds: opts.allowedSubsidiaryIds,
  })

  if (opts.method.startsWith('platform.')) {
    const typeKey = String(opts.payload?.typeKey ?? '')
    const id = String(opts.payload?.id ?? '')
    const units = platformBridgeUnits(opts.method)
    const started = Date.now()
    // The dispatch itself decides the terminal outcome; infrastructure faults
    // REJECT and are recorded as refusal evidence by the envelope.
    async function attemptDispatch(): Promise<AppInvocationAttempt> {
      try {
        let result: unknown
        switch (opts.method) {
          case 'platform.query':
            result = await platform.query!(opts.payload?.plan)
            break
          case 'platform.schema':
            result = await platform.schema()
            break
          case 'platform.list':
            result = await platform.list(typeKey, opts.payload?.options ?? {})
            break
          case 'platform.get':
            result = await platform.get(typeKey, id)
            break
          case 'platform.create':
            result = await platform.create(typeKey, opts.payload?.body ?? {})
            break
          case 'platform.update':
            result = await platform.update(typeKey, id, opts.payload?.body ?? {})
            break
          case 'platform.delete':
            result = await platform.delete(typeKey, id)
            break
          default:
            return {
              status: 'error',
              error: `unknown method: ${opts.method}`,
              logs: [],
              units,
              durationMs: Date.now() - started,
            }
        }
        return { status: 'ok', response: result, logs: [], units, durationMs: Date.now() - started }
      } catch (error) {
        return {
          status:
            error instanceof AppPlatformError && error.status === 403 ? 'forbidden' : 'error',
          error: (error as Error).message,
          logs: [],
          units,
          durationMs: Date.now() - started,
        }
      }
    }
    try {
      const outcome = await executeAppInvocation({
        orgId: opts.orgId,
        actorId: opts.user.id,
        appId: app.id,
        versionId: app.activeVersionId,
        endpoint: opts.method,
        operation: `apps.${opts.method.replaceAll('.', '_')}`,
        idempotencyKey: deriveAppInvocationKey({
          method: opts.method,
          typeKey,
          id,
          payload: opts.payload?.body ?? opts.payload?.options ?? opts.payload?.plan ?? null,
          ...(opts.method === 'platform.query' ? { readInvocation: crypto.randomUUID() } : {}),
        }),
        requestHash: requestHash({ method: opts.method, typeKey, id, payload: opts.payload }),
        run: attemptDispatch,
        audit: insertAppRun,
      })
      if (outcome.attempt.status !== 'ok') {
        const status = outcome.attempt.status === 'forbidden' ? 403 : 400
        return { ok: false, error: outcome.attempt.error ?? outcome.attempt.status, status }
      }
      return { ok: true, result: outcome.attempt.response }
    } catch (error) {
      return invocationRefusal(error)
    }
  }

  if (opts.method === 'records.list' || opts.method === 'records.get') {
    if (!recordsGranted) return { ok: false, error: 'records.read not granted', status: 403 }
    const rec = recordsAdapter(opts.orgId, opts.user, opts.allowedSubsidiaryIds)
    const result =
      opts.method === 'records.list'
        ? await rec.list(String(opts.payload?.typeKey ?? ''), opts.payload?.filters ?? {})
        : await rec.get(String(opts.payload?.typeKey ?? ''), String(opts.payload?.id ?? ''))
    return { ok: true, result }
  }

  if (opts.method === 'callBackend') {
    const endpointName = String(opts.payload?.endpoint ?? '')
    const endpoint = app.manifest.endpoints.find((e) => e.name === endpointName)
    if (!endpoint) return { ok: false, error: `no such endpoint: ${endpointName}`, status: 404 }

    const src = await rows<{ content: string }>(
      sql`select content from app_files where org_id = ${opts.orgId} and version_id = ${app.activeVersionId} and path = ${endpoint.file} and kind = 'backend' limit 1`,
    )
    if (!src[0]) return { ok: false, error: 'endpoint source missing', status: 500 }
    const handlerSource = src[0].content

    const adapters: AppHostAdapters = { storage: storageAdapter(opts.orgId, app.id) }
    if (recordsGranted) adapters.records = recordsAdapter(opts.orgId, opts.user, opts.allowedSubsidiaryIds)
    if (glGranted) {
      // The bridge caller's subsidiary scope travels with the write, so an App
      // backend cannot journal into an entity the signed-in user may not see.
      adapters.journal = {
        create: (input, post) =>
          createScriptJournal(opts.orgId, opts.user.id, input as ScriptJournalInput, {
            post,
            allowedSubsidiaryIds: opts.allowedSubsidiaryIds,
          }),
      }
    }
    adapters.platform = platform

    const request: AppRequest = {
      method: endpoint.method === 'ANY' ? 'POST' : endpoint.method,
      endpoint: endpointName,
      query: {},
      body: opts.payload?.payload ?? null,
      user: {
        id: opts.user.id,
        name: opts.user.name,
        roles: opts.user.roles.map(({ key }) => key),
      },
    }
    // ONE invocation unit: claim an idempotency key, run the handler inside a
    // savepoint of one tenant transaction, and commit every material effect
    // (journal posts, platform CRUD, app storage) together with its app_runs
    // audit row — or roll the whole thing back. A handler failure leaves zero
    // effects; a lost-response retry replays the stored result without
    // re-executing; an audit-write failure rolls everything back. The envelope
    // lives in engine/src/apps-invocations.ts.
    try {
      const outcome = await executeAppInvocation({
        orgId: opts.orgId,
        actorId: opts.user.id,
        appId: app.id,
        versionId: app.activeVersionId,
        endpoint: endpointName,
        operation: `apps.call_backend.${endpointName}`,
        idempotencyKey: deriveAppInvocationKey({
          versionId: app.activeVersionId,
          endpoint: endpointName,
          body: opts.payload?.payload ?? null,
        }),
        requestHash: requestHash({ endpoint: endpointName, payload: opts.payload?.payload ?? null }),
        run: () => runAppEndpoint({ source: handlerSource, request, adapters }),
        audit: insertAppRun,
      })
      const run = outcome.attempt
      if (run.status !== 'ok') {
        const status = run.status === 'forbidden' ? 403 : run.status === 'timeout' ? 504 : 400
        return { ok: false, error: run.error ?? run.status, status }
      }
      return { ok: true, result: run.response }
    } catch (error) {
      return invocationRefusal(error)
    }
  }

  return { ok: false, error: `unknown method: ${opts.method}`, status: 400 }
}

function platformBridgeUnits(method: string): number {
  if (method === 'platform.query') return 80
  if (method === 'platform.schema' || method === 'platform.list') return 20
  if (method === 'platform.get') return 10
  if (method === 'platform.create' || method === 'platform.update' || method === 'platform.delete') return 50
  return 0
}

/**
 * Map envelope refusals to bridge results. A concurrent duplicate of one
 * invocation key is a 409, as is key reuse with different input. Anything else
 * (an app_runs write failure, claim-shape violation) is fail-closed: the whole
 * transaction already rolled back inside the envelope, so nothing material is
 * left behind — surface the real error instead of pretending success.
 */
function invocationRefusal(error: unknown): { ok: false; error: string; status: number } {
  if (error instanceof AppInvocationInFlightError) {
    return { ok: false, error: error.message, status: 409 }
  }
  if (error instanceof AppInvocationRequestMismatchError) {
    return { ok: false, error: error.message, status: 409 }
  }
  // Drizzle wraps driver errors; carry the cause chain so the operator sees
  // WHY the invocation refused instead of a bare "failed query" wrapper.
  const text = fullErrorMessage(error)
  return { ok: false, error: text || 'app invocation failed', status: 500 }
}

function fullErrorMessage(error: unknown): string {
  let current: unknown = error
  let text = ''
  let hops = 0
  while (current instanceof Error && hops < 5) {
    text += (hops ? ': ' : '') + current.message
    current = (current as Error & { cause?: unknown }).cause
    hops++
  }
  return text || String(error)
}

/**
 * The ONLY writer of run evidence for App invocations, and it is load-bearing:
 * it joins the invocation's own tenant transaction (db routes to the pinned
 * connection), so its failure rolls back the very effects it audits instead of
 * silently stripping them of provenance.
 */
async function insertAppRun(row: AppInvocationAuditRow): Promise<void> {
  await db.execute(sql`
    insert into app_runs (org_id, app_id, version_id, endpoint, status, units, logs, error_message, duration_ms, actor_id)
    values (${row.orgId}, ${row.appId}, ${row.versionId}, ${row.endpoint}, ${row.status}, ${Math.round(row.units)},
            ${JSON.stringify(row.logs)}::jsonb, ${row.errorMessage}, ${Math.round(row.durationMs)}, ${row.actorId})`)
}

/** Read-only source inspection for installed package versions. */
export type AppFileRow = {
  path: string
  kind: 'frontend' | 'backend' | 'asset'
  contentType: string
  isBinary: boolean
  size: number
  updatedAt: string
};

export async function listAppFiles(orgId: string, key: string): Promise<AppFileRow[]> {
  const app = await getAppByKey(orgId, key)
  if (!app || !app.activeVersionId) throw new AppError('app not found', 404)
  return rows<AppFileRow>(sql`
    select path, kind, content_type as "contentType", is_binary as "isBinary", size, updated_at as "updatedAt"
      from app_files where org_id = ${orgId} and version_id = ${app.activeVersionId} order by path`)
}

export async function readAppFile(
  orgId: string,
  key: string,
  path: string,
): Promise<{ path: string; content: string; isBinary: boolean; contentType: string }> {
  const app = await getAppByKey(orgId, key)
  if (!app || !app.activeVersionId) throw new AppError('app not found', 404)
  const r = await rows<{ path: string; content: string; isBinary: boolean; contentType: string }>(sql`
    select path, content, is_binary as "isBinary", content_type as "contentType"
      from app_files where org_id = ${orgId} and version_id = ${app.activeVersionId} and path = ${path} limit 1`)
  if (!r[0]) throw new AppError('file not found', 404)
  return r[0]
}

/** Published, immutable library snapshots. */
export type ListingRow = {
  id: string
  key: string
  name: string
  description: string | null
  iconKey: string
  version: string
  publisherOrgId: string
  updatedAt: string
};

export interface ListingPage {
  listings: ListingRow[]
  total: number
}

/** Browse active listings (any org), with server-side search and pagination. */
export async function listListings({
  query,
  page,
  perPage,
}: {
  query?: string
  page: number
  perPage: number
}): Promise<ListingPage> {
  const where = sql`is_active = true${query
    ? sql` and (name ilike ${'%' + query + '%'} or key ilike ${'%' + query + '%'} or coalesce(description, '') ilike ${'%' + query + '%'})`
    : sql``}`
  const [listings, count] = await Promise.all([
    rows<ListingRow>(sql`
      select id, key, name, description, icon_key as "iconKey", version,
             publisher_org_id as "publisherOrgId", updated_at as "updatedAt"
        from app_listings
       where ${where}
       order by name, key
       limit ${perPage} offset ${(page - 1) * perPage}`),
    rows<{ total: string }>(sql`select count(*) as total from app_listings where ${where}`),
  ])
  return { listings, total: Number(count[0]?.total ?? 0) }
}

/** Whether an active marketplace listing exists for an app key. */
export async function isAppPublished(key: string, publisherOrgId?: string): Promise<boolean> {
  const found = await rows<{ found: boolean }>(sql`
    select true as found
      from app_listings
     where key = ${key} and is_active = true ${publisherOrgId ? sql`and publisher_org_id=${publisherOrgId}` : sql``}
     limit 1`)
  return found.length > 0
}

/**
 * Publish an installed App's ACTIVE bundle to the marketplace. One listing per
 * app key deployment-wide; only the original publisher org may update it.
 */
export async function publishApp(orgId: string, userId: string, key: string): Promise<{ id: string }> {
  return db.transaction(async tx => {
  await tx.execute(sql`select id from apps where org_id=${orgId} and key=${key} for share`)
  const app = await getAppByKey(orgId, key)
  if (!app || !app.activeVersionId || !app.manifest) throw new AppError('app not found or has no active version', 404)

  const files = await rows<{ path: string; content: string; isBinary: boolean }>(sql`
    select path, content, is_binary as "isBinary"
      from app_files where org_id = ${orgId} and version_id = ${app.activeVersionId} order by path`)

  const existing = await rows<{ id: string; publisherOrgId: string; isApp: boolean }>(
    sql`select id, publisher_org_id as "publisherOrgId", manifest ? 'frontend' as "isApp" from app_listings where key = ${key} limit 1`,
  )
  if (existing[0] && existing[0].publisherOrgId !== orgId) {
    throw new AppError(`"${key}" is already published by another org`, 409)
  }

  if (existing[0] && !existing[0].isApp) throw new AppError(`"${key}" is already published as a module`, 409)
  const filesJson = JSON.stringify(files)
  const manifestJson = JSON.stringify(app.manifest)
  const before = (await tx.execute(sql`select id,version,manifest,files,is_active from app_listings where key=${key} and publisher_org_id=${orgId} for update`)).rows[0] ?? null
  const r = (await tx.execute<{ id: string }>(sql`
    insert into app_listings (publisher_org_id, key, name, description, icon_key, version, manifest, files, is_active, created_by, updated_by)
    values (${orgId}, ${key}, ${app.name}, ${app.description}, ${app.iconKey}, ${app.version},
            ${manifestJson}::jsonb, ${filesJson}::jsonb, true, ${userId}, ${userId})
    on conflict (key) do update set
      name = excluded.name, description = excluded.description, icon_key = excluded.icon_key,
      version = excluded.version, manifest = excluded.manifest, files = excluded.files,
      is_active = true, updated_at = now(), updated_by = ${userId}
    where app_listings.publisher_org_id = ${orgId}
    returning id`))
  const id = r.rows[0]?.id
  if (!id) throw new AppError(`"${key}" is already published by another organization`, 409)
  await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'app_listings',${id},${before ? 'update' : 'insert'},${JSON.stringify({ event:'app_listing_published', reason:'Publish active app version', appKey:key, versionId:app.activeVersionId, before, after:{version:app.version,manifest:app.manifest,files,is_active:true} })}::jsonb,${userId})`)
  return { id }
  })
}

/** Install a marketplace listing into the caller's org via the normal path. */
export class AppError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = 'AppError' }
}

export async function unpublishApp(orgId: string, userId: string, key: string): Promise<void> {
  await db.transaction(async tx => {
    const listing = (await tx.execute<{ id: string; is_active: boolean; version: string }>(sql`select id,is_active,version from app_listings where key=${key} and publisher_org_id=${orgId} for update`)).rows[0]
    if (!listing) throw new AppError('No app listing owned by this organization', 404)
    if (!listing.is_active) return
    await tx.execute(sql`update app_listings set is_active=false,updated_by=${userId},updated_at=now() where id=${listing.id} and publisher_org_id=${orgId}`)
    await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'app_listings',${listing.id},'update',${JSON.stringify({ event:'app_listing_withdrawn',before:{isActive:true,version:listing.version},after:{isActive:false,version:listing.version} })}::jsonb,${userId})`)
  })
}
