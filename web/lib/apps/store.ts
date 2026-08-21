import 'server-only'
import { sql } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/src/db.ts'
import {
  runAppEndpoint,
  type AppHostAdapters,
  type AppRequest,
  type AppRecordsAdapter,
  type AppStorageAdapter,
} from '@openbooks/engine/src/apps-runtime.ts'
import { createScriptJournal, type ScriptJournalInput } from '@openbooks/engine/src/journal-writes.ts'
import { parseManifest, validateBundle, contentTypeFor, type AppManifest } from './manifest'
import { APP_CAPABILITIES } from './manifest'
import { parseObjectSpecs, type ParsedObjects } from './objects'
import { createAppPlatformAdapter, AppPlatformError } from './platform'
import type { SessionUser } from '@/lib/auth'
import { permissionSetCovers } from '@/lib/permissions'

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
      left join app_versions v on v.id = a.active_version_id
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
      left join app_versions v on v.id = a.active_version_id
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
export async function installApp(orgId: string, userId: string, bundle: UploadBundle): Promise<{ key: string }> {
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

  // objects/*.json — validate BEFORE the transaction so a bad spec is a clean 400.
  const objects = parseObjectSpecs(bundle.files)
  if (objects.errors.length) throw new AppError(`invalid objects: ${objects.errors.join('; ')}`)

  const manifestJson = JSON.stringify(manifest)

  await db.transaction(async (tx) => {
    // Prior grants (absent on first install) become the audit "before" state.
    const prior = (await tx.execute<{ grantedPermissions: string[] | null }>(sql`
      select granted_permissions as "grantedPermissions" from apps
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
      returning id`))
    const appId = appRes.rows[0]!.id

    // Permission grants are audited with before/after evidence. Install keeps
    // full-grant-at-install (the admin may narrow via bundle.grantedPermissions);
    // a dedicated narrowing UI is follow-up work.
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
      sql`select 1 from app_versions where app_id = ${appId} and version = ${manifest.version} limit 1`,
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
    const prevRes = (await tx.execute<{ provisioned: { recordTypes?: string[]; customFields?: string[] } }>(sql`select provisioned from apps where id = ${appId}`))
    const prev = prevRes.rows[0]?.provisioned ?? {}
    const provisioned = await provisionObjects(tx, orgId, userId, objects, {
      recordTypes: new Set(prev.recordTypes ?? []),
      customFields: new Set(prev.customFields ?? []),
    })
    await tx.execute(sql`update apps set provisioned = ${JSON.stringify(provisioned)}::jsonb where id = ${appId}`)

    // Supersede the previous active version, then activate the new one.
    await tx.execute(sql`update app_versions set status = 'superseded' where app_id = ${appId} and id <> ${versionId} and status = 'active'`)
    await tx.execute(sql`update apps set active_version_id = ${versionId}, updated_at = now() where id = ${appId}`)
  })

  return { key: manifest.key }
}

/** Upsert declared objects inside the install transaction. Returns provenance. */
async function provisionObjects(
  tx: SqlExecutor,
  orgId: string,
  userId: string,
  objects: ParsedObjects,
  owned: { recordTypes: Set<string>; customFields: Set<string> },
): Promise<{ recordTypes: string[]; customFields: string[] }> {
  const recordTypes = new Set(owned.recordTypes)
  const customFields = new Set(owned.customFields)

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
         where id = ${existing.rows[0].id}`)
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
    const existing = (await tx.execute(sql`
      select id from custom_field_defs
       where org_id = ${orgId} and target_table = ${cf.targetTable} and key = ${cf.key} limit 1`,
    )) as { rows: { id: string }[] }
    if (existing.rows[0]) {
      if (!owned.customFields.has(scoped)) {
        throw new AppError(`custom field "${scoped}" already exists and was not provisioned by this app`, 409)
      }
      await tx.execute(sql`
        update custom_field_defs
           set label = ${cf.label}, field_type = ${cf.fieldType}, target_kind = ${cf.targetKind},
               config = ${JSON.stringify(cf.config)}::jsonb, is_required = ${cf.isRequired},
               is_active = true, updated_at = now(), updated_by = ${userId}
         where id = ${existing.rows[0].id}`)
    } else {
      await tx.execute(sql`
        insert into custom_field_defs (org_id, target_table, target_kind, key, label, field_type, config, is_required, created_by, updated_by)
        values (${orgId}, ${cf.targetTable}, ${cf.targetKind}, ${cf.key}, ${cf.label}, ${cf.fieldType},
                ${JSON.stringify(cf.config)}::jsonb, ${cf.isRequired}, ${userId}, ${userId})`)
    }
    customFields.add(scoped)
  }

  return { recordTypes: [...recordTypes], customFields: [...customFields] }
}

export async function setAppStatus(orgId: string, key: string, status: 'installed' | 'disabled'): Promise<void> {
  await db.execute(sql`update apps set status = ${status}, updated_at = now() where org_id = ${orgId} and key = ${key}`)
}

export async function deleteApp(orgId: string, key: string): Promise<void> {
  // FK cascades drop versions, files, storage, and run log.
  await db.execute(sql`delete from apps where org_id = ${orgId} and key = ${key}`)
}

/** Build the inlined frontend bundle the AppFrame renders. */
export async function getFrontendBundle(
  orgId: string,
  key: string,
): Promise<{ entry: string; entryHtml: string; replacements: Record<string, string> }> {
  const app = await getAppByKey(orgId, key)
  if (!app) throw new AppError('app not found', 404)
  if (app.status !== 'installed') throw new AppError('app is disabled', 403)
  if (!app.activeVersionId || !app.manifest) throw new AppError('app has no active version', 409)

  const files = await rows<{ path: string; contentType: string; content: string; isBinary: boolean }>(sql`
    select path, content_type as "contentType", content, is_binary as "isBinary"
      from app_files
     where version_id = ${app.activeVersionId} and kind in ('frontend', 'asset')`)

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
        sql`select value from app_storage where app_id = ${appId} and namespace = ${namespace} and key = ${key} limit 1`,
      )
      return r[0]?.value ?? null
    },
    async set(key, value, namespace) {
      await db.execute(sql`
        insert into app_storage (org_id, app_id, namespace, key, value)
        values (${orgId}, ${appId}, ${namespace}, ${key}, ${JSON.stringify(value ?? null)}::jsonb)
        on conflict (app_id, namespace, key) do update set value = excluded.value, updated_at = now()`)
    },
    async list(prefix, namespace) {
      const like = prefix.replace(/[%_\\]/g, (m) => '\\' + m) + '%'
      return rows<{ key: string; value: unknown }>(sql`
        select key, value from app_storage
         where app_id = ${appId} and namespace = ${namespace} and key like ${like}
         order by key limit 500`)
    },
    async delete(key, namespace) {
      await db.execute(sql`delete from app_storage where app_id = ${appId} and namespace = ${namespace} and key = ${key}`)
    },
  }
}

function recordsAdapter(orgId: string): AppRecordsAdapter {
  return {
    async list(typeKey, filters) {
      const status = typeof filters?.status === 'string' ? (filters.status as string) : null
      return rows(sql`
        select id, record_number as "recordNumber", status, data
          from custom_records
         where org_id = ${orgId} and type_key = ${typeKey}
           ${status ? sql`and status = ${status}` : sql``}
         order by created_at desc limit 200`)
    },
    async get(typeKey, id) {
      const r = await rows(sql`
        select id, record_number as "recordNumber", status, data
          from custom_records
         where org_id = ${orgId} and type_key = ${typeKey} and id = ${id} limit 1`)
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
  userCan: (perm: string) => boolean
  allowedSubsidiaryIds: ReadonlySet<string> | null
}): Promise<{ ok: true; result: unknown } | { ok: false; error: string; status: number }> {
  const app = await getAppByKey(opts.orgId, opts.key)
  if (!app || !app.manifest) return { ok: false, error: 'app not found', status: 404 }
  if (app.status !== 'installed') return { ok: false, error: 'app is disabled', status: 403 }

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
    try {
      let result: unknown
      switch (opts.method) {
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
          return { ok: false, error: `unknown method: ${opts.method}`, status: 400 }
      }
      await logAppRun(app, opts, opts.method, 'ok', null, platformBridgeUnits(opts.method))
      return { ok: true, result }
    } catch (error) {
      const status = error instanceof AppPlatformError ? error.status : 400
      await logAppRun(
        app,
        opts,
        opts.method,
        status === 403 ? 'forbidden' : 'error',
        (error as Error).message,
        platformBridgeUnits(opts.method),
      )
      return { ok: false, error: (error as Error).message, status }
    }
  }

  if (opts.method === 'records.list' || opts.method === 'records.get') {
    if (!recordsGranted) return { ok: false, error: 'records.read not granted', status: 403 }
    const rec = recordsAdapter(opts.orgId)
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
      sql`select content from app_files where version_id = ${app.activeVersionId} and path = ${endpoint.file} and kind = 'backend' limit 1`,
    )
    if (!src[0]) return { ok: false, error: 'endpoint source missing', status: 500 }

    const adapters: AppHostAdapters = { storage: storageAdapter(opts.orgId, app.id) }
    if (recordsGranted) adapters.records = recordsAdapter(opts.orgId)
    if (glGranted) {
      adapters.journal = {
        create: (input, post) =>
          createScriptJournal(opts.orgId, opts.user.id, input as ScriptJournalInput, { post }),
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
    const run = await runAppEndpoint({ source: src[0].content, request, adapters })

    // Log the run (best-effort — a logging failure must not fail the call).
    try {
      await db.execute(sql`
        insert into app_runs (org_id, app_id, version_id, endpoint, status, units, logs, error_message, duration_ms, actor_id)
        values (${opts.orgId}, ${app.id}, ${app.activeVersionId}, ${endpointName}, ${run.status}, ${run.units},
                ${JSON.stringify(run.logs)}::jsonb, ${run.error ?? null}, ${run.durationMs}, ${opts.user.id})`)
    } catch {
      /* ignore */
    }

    if (run.status !== 'ok') {
      const status = run.status === 'forbidden' ? 403 : run.status === 'timeout' ? 504 : 400
      return { ok: false, error: run.error ?? run.status, status }
    }
    return { ok: true, result: run.response }
  }

  return { ok: false, error: `unknown method: ${opts.method}`, status: 400 }
}

function platformBridgeUnits(method: string): number {
  if (method === 'platform.schema' || method === 'platform.list') return 20
  if (method === 'platform.get') return 10
  if (method === 'platform.create' || method === 'platform.update' || method === 'platform.delete') return 50
  return 0
}

async function logAppRun(
  app: AppRow,
  opts: { orgId: string; user: SessionUser },
  endpoint: string,
  status: 'ok' | 'error' | 'timeout' | 'forbidden',
  error: string | null,
  units: number,
): Promise<void> {
  try {
    await db.execute(sql`
      insert into app_runs (org_id, app_id, version_id, endpoint, status, units, logs, error_message, duration_ms, actor_id)
      values (${opts.orgId}, ${app.id}, ${app.activeVersionId}, ${endpoint}, ${status}, ${units}, '[]'::jsonb,
              ${error}, 0, ${opts.user.id})`)
  } catch {
    // Run logging is best-effort and must never change the API result.
  }
}

// ---------------------------------------------------------------------------
// Authoring — the in-app "New App" scaffold, form-driven manifest updates, and
// file CRUD against the ACTIVE version. Users never see JSON: the manifest is
// edited through form fields and files through the built-in file browser.
// Marketplace publishes still snapshot immutably.
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z][a-z0-9-]*$/
const FILE_PATH_RE = /^(?!\/)(?!.*\.\.)[a-z0-9._\-/]+$/i

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return SLUG_RE.test(s) ? s : `app-${s}`.replace(/^app--/, 'app-')
}

const SCAFFOLD_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="frontend/styles.css">
</head>
<body>
  <main>
    <h1 id="title">My App</h1>
    <p id="who">Loading…</p>
    <button id="ping">Call backend</button>
    <pre id="out"></pre>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    openbooks.getContext().then((c) => {
      $('title').textContent = c.app.name;
      $('who').textContent = 'Signed in as ' + (c.user ? c.user.name : 'anonymous');
    });
    $('ping').addEventListener('click', async () => {
      try {
        const res = await openbooks.callBackend('hello', { at: new Date().toISOString() });
        $('out').textContent = JSON.stringify(res.body, null, 2);
      } catch (e) { $('out').textContent = 'error: ' + e.message; }
    });
  </script>
</body>
</html>
`

const SCAFFOLD_CSS = `body { font-family: system-ui, sans-serif; padding: 2rem; color: #111; }
h1 { margin-top: 0; }
button { padding: .5rem 1rem; border-radius: 8px; border: 1px solid #ccc; cursor: pointer; background: #fafafa; }
pre { color: #555; background: #f6f6f6; padding: .75rem; border-radius: 8px; }
`

const SCAFFOLD_BACKEND = `// Backend endpoint — runs in the governed sandbox.
// request = { method, endpoint, query, body, user }
// ob.log(...), ob.storage.get/set/list/delete(key[, ns]) are always available.
function handler(request) {
  var calls = (ob.storage.get('calls') || 0) + 1;
  ob.storage.set('calls', calls);
  ob.log('hello from', request.user && request.user.name);
  return { message: 'Hello from your app backend!', calls: calls, echo: request.body };
}
`

/** Create a ready-to-open starter app. Returns its key. */
export async function createAppScaffold(orgId: string, userId: string, name: string): Promise<{ key: string }> {
  const trimmed = name.trim()
  if (!trimmed) throw new AppError('name required')
  let key = slugify(trimmed)
  // Dedupe the slug if taken.
  const taken = await rows<{ key: string }>(
    sql`select key from apps where org_id = ${orgId} and key like ${key + '%'}`,
  )
  if (taken.some((r) => r.key === key)) {
    let n = 2
    while (taken.some((r) => r.key === `${key}-${n}`)) n++
    key = `${key}-${n}`
  }
  return installApp(orgId, userId, {
    manifest: {
      key,
      name: trimmed,
      version: '0.1.0',
      description: '',
      permissions: [],
      frontend: { entry: 'frontend/index.html' },
      endpoints: [{ name: 'hello', file: 'backend/hello.js', method: 'ANY' }],
    },
    files: [
      { path: 'frontend/index.html', content: SCAFFOLD_HTML },
      { path: 'frontend/styles.css', content: SCAFFOLD_CSS },
      { path: 'backend/hello.js', content: SCAFFOLD_BACKEND },
    ],
  })
}

export interface AppMetaUpdate {
  name?: string
  description?: string | null
  iconKey?: string
  grantedPermissions?: string[]
  endpoints?: { name: string; file: string; method?: 'GET' | 'POST' | 'ANY' }[]
}

/**
 * Form-driven manifest + app-row update. Endpoints must reference existing
 * files; file kinds are re-classified afterward so the runtime picks up
 * endpoint changes immediately.
 */
export async function updateAppMeta(orgId: string, userId: string, key: string, meta: AppMetaUpdate): Promise<void> {
  const app = await getAppByKey(orgId, key)
  if (!app || !app.activeVersionId || !app.manifest) throw new AppError('app not found', 404)

  const manifest: AppManifest = { ...app.manifest }
  if (meta.name !== undefined) {
    if (!meta.name.trim()) throw new AppError('name required')
    manifest.name = meta.name.trim().slice(0, 120)
  }
  if (meta.description !== undefined) manifest.description = meta.description?.slice(0, 2000) || undefined
  if (meta.iconKey !== undefined) manifest.icon = meta.iconKey
  if (meta.grantedPermissions !== undefined) {
    // Authoring flow: what you grant is what the manifest requests.
    manifest.permissions = [...new Set(meta.grantedPermissions.filter((p) => typeof p === 'string' && p.length <= 80))]
  }
  if (meta.endpoints !== undefined) {
    const seen = new Set<string>()
    for (const e of meta.endpoints) {
      if (!SLUG_RE.test(e.name)) throw new AppError(`endpoint name "${e.name}" must be a slug`)
      if (seen.has(e.name)) throw new AppError(`duplicate endpoint name "${e.name}"`)
      seen.add(e.name)
      if (!FILE_PATH_RE.test(e.file)) throw new AppError(`invalid endpoint file path "${e.file}"`)
    }
    manifest.endpoints = meta.endpoints.map((e) => ({ name: e.name, file: e.file, method: e.method ?? 'ANY' }))
  }

  const paths = (await rows<{ path: string }>(
    sql`select path from app_files where version_id = ${app.activeVersionId}`,
  )).map((r) => r.path)
  const vb = validateBundle(manifest, paths)
  if (!vb.ok) throw new AppError(vb.errors.join('; '))

  const granted = meta.grantedPermissions !== undefined ? manifest.permissions : app.grantedPermissions

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update apps set
        name = ${manifest.name}, description = ${manifest.description ?? null},
        icon_key = ${manifest.icon ?? app.iconKey},
        granted_permissions = ${JSON.stringify(granted)}::jsonb,
        updated_at = now(), updated_by = ${userId}
      where org_id = ${orgId} and key = ${key}`)
    // Narrowing/expanding the granted set is a material security change —
    // record before/after evidence whenever it actually changes.
    if (
      meta.grantedPermissions !== undefined &&
      JSON.stringify([...app.grantedPermissions].sort()) !== JSON.stringify([...granted].sort())
    ) {
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'apps', ${app.id}, 'update',
          ${JSON.stringify({
            appKey: key,
            permissionsBefore: app.grantedPermissions,
            permissionsAfter: granted,
          })}::jsonb,
          ${userId})`)
    }
    await tx.execute(sql`
      update app_versions set manifest = ${JSON.stringify(manifest)}::jsonb, updated_at = now(), updated_by = ${userId}
      where id = ${app.activeVersionId}`)
    // Re-classify kinds so new/changed endpoints load their backend files.
    for (const p of paths) {
      await tx.execute(sql`update app_files set kind = ${vb.kinds[p]} where version_id = ${app.activeVersionId} and path = ${p}`)
    }
  })
}

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
      from app_files where version_id = ${app.activeVersionId} order by path`)
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
      from app_files where version_id = ${app.activeVersionId} and path = ${path} limit 1`)
  if (!r[0]) throw new AppError('file not found', 404)
  return r[0]
}

const MAX_FILE_BYTES = 2 * 1024 * 1024

/** Create or overwrite a file on the active version (text or base64 binary). */
export async function writeAppFile(
  orgId: string,
  userId: string,
  key: string,
  path: string,
  content: string,
  isBinary = false,
): Promise<void> {
  if (!FILE_PATH_RE.test(path)) throw new AppError('invalid file path')
  if (path === 'manifest.json') throw new AppError('the manifest is edited through the app settings, not as a file')
  if (content.length > MAX_FILE_BYTES) throw new AppError('file too large (max 2 MB)')
  const app = await getAppByKey(orgId, key)
  if (!app || !app.activeVersionId || !app.manifest) throw new AppError('app not found', 404)

  const { contentType } = contentTypeFor(path)
  const backendFiles = new Set(app.manifest.endpoints.map((e) => e.file))
  const kind = backendFiles.has(path)
    ? 'backend'
    : path === app.manifest.frontend.entry || path.startsWith('frontend/')
      ? 'frontend'
      : 'asset'

  await db.execute(sql`
    insert into app_files (org_id, app_id, version_id, path, kind, content_type, content, is_binary, size, created_by, updated_by)
    values (${orgId}, ${app.id}, ${app.activeVersionId}, ${path}, ${kind}, ${contentType},
            ${content}, ${isBinary}, ${content.length}, ${userId}, ${userId})
    on conflict (version_id, path) do update set
      content = excluded.content, is_binary = excluded.is_binary, size = excluded.size,
      content_type = excluded.content_type, kind = excluded.kind, updated_at = now(), updated_by = ${userId}`)
}

export async function deleteAppFile(orgId: string, key: string, path: string): Promise<void> {
  const app = await getAppByKey(orgId, key)
  if (!app || !app.activeVersionId || !app.manifest) throw new AppError('app not found', 404)
  if (path === app.manifest.frontend.entry) throw new AppError('cannot delete the frontend entry file', 409)
  const endpoint = app.manifest.endpoints.find((e) => e.file === path)
  if (endpoint) throw new AppError(`cannot delete: endpoint "${endpoint.name}" uses this file`, 409)
  await db.execute(sql`delete from app_files where version_id = ${app.activeVersionId} and path = ${path}`)
}

// ---------------------------------------------------------------------------
// Marketplace — cross-org distribution. A listing is a SNAPSHOT of a published
// bundle (manifest + files), deployment-visible; installing copies the
// snapshot through the normal installApp() path, so validation, permission
// grants, and object provisioning apply identically.
// ---------------------------------------------------------------------------

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
export async function isAppPublished(key: string): Promise<boolean> {
  const found = await rows<{ found: boolean }>(sql`
    select true as found
      from app_listings
     where key = ${key} and is_active = true
     limit 1`)
  return found.length > 0
}

/**
 * Publish an installed App's ACTIVE bundle to the marketplace. One listing per
 * app key deployment-wide; only the original publisher org may update it.
 */
export async function publishApp(orgId: string, userId: string, key: string): Promise<{ id: string }> {
  const app = await getAppByKey(orgId, key)
  if (!app || !app.activeVersionId || !app.manifest) throw new AppError('app not found or has no active version', 404)

  const files = await rows<{ path: string; content: string; isBinary: boolean }>(sql`
    select path, content, is_binary as "isBinary"
      from app_files where version_id = ${app.activeVersionId} order by path`)

  const existing = await rows<{ id: string; publisherOrgId: string }>(
    sql`select id, publisher_org_id as "publisherOrgId" from app_listings where key = ${key} limit 1`,
  )
  if (existing[0] && existing[0].publisherOrgId !== orgId) {
    throw new AppError(`"${key}" is already published by another org`, 409)
  }

  const filesJson = JSON.stringify(files)
  const manifestJson = JSON.stringify(app.manifest)
  const r = (await db.execute<{ id: string }>(sql`
    insert into app_listings (publisher_org_id, key, name, description, icon_key, version, manifest, files, is_active, created_by, updated_by)
    values (${orgId}, ${key}, ${app.name}, ${app.description}, ${app.iconKey}, ${app.version},
            ${manifestJson}::jsonb, ${filesJson}::jsonb, true, ${userId}, ${userId})
    on conflict (key) do update set
      name = excluded.name, description = excluded.description, icon_key = excluded.icon_key,
      version = excluded.version, manifest = excluded.manifest, files = excluded.files,
      is_active = true, updated_at = now(), updated_by = ${userId}
    returning id`))
  return { id: r.rows[0]!.id }
}

/** Install a marketplace listing into the caller's org via the normal path. */
export async function installFromListing(orgId: string, userId: string, listingId: string): Promise<{ key: string }> {
  const r = await rows<{ manifest: unknown; files: { path: string; content: string; isBinary?: boolean }[] }>(
    sql`select manifest, files from app_listings where id = ${listingId} and is_active = true limit 1`,
  )
  if (!r[0]) throw new AppError('listing not found', 404)
  return installApp(orgId, userId, { manifest: r[0].manifest, files: r[0].files })
}

export class AppError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message)
    this.name = 'AppError'
  }
}
