import 'server-only'

import { sql } from 'drizzle-orm'
import { actorHasPermission } from '@openbooks/engine/src/actor-permissions.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { installModule, type InstallOutcome } from '@openbooks/engine/src/modules/installer.ts'
import { parseModuleManifest } from './manifest'
import { requestModuleInstallApproval, requestModuleUpgradeApproval } from '@openbooks/engine/src/modules/lifecycle.ts'
import { permissionSetCovers } from '@openbooks/engine/src/permissions.ts'

/**
 * Module marketplace — the cross-org distribution surface for modules.
 *
 * Reuse-first: module listings live in `app_listings`, the table the apps
 * marketplace already ships — not a parallel table. A listing is a SNAPSHOT
 * of the publisher's ACTIVE module version (manifest bytes copied at publish
 * time), exactly the way publishApp snapshots an app bundle, so installs
 * from the marketplace never reach into the publisher's live tables and a
 * later publisher upgrade never moves a snapshot out from under an
 * installer. Module listings appear in /apps/library with no UI change: the
 * library reads every active `app_listings` row.
 *
 * Module vs app rows share the table AND the deployment-wide key namespace
 * (one listing per key), so the two shapes are discriminated by manifest
 * shape, in SQL and in TypeScript alike: module snapshots always declare
 * `contributions`, app snapshots always declare `frontend` (required by the
 * app manifest) and a module manifest never does. `parseModuleManifest`
 * alone cannot discriminate — zod strips unknown keys, so an app manifest
 * parses as a contribution-less module — hence the negative `frontend`
 * check. `files` is always `[]`: modules project contributions, they have
 * no app bundle to copy.
 *
 * Installing from a listing goes through installModule() untouched — the
 * same boundary validation, grant intersection against the installer's
 * honestly-resolved effective set, single-transaction projection, and audit
 * the installer applies to a directly-uploaded manifest. The snapshot is
 * re-validated at that boundary: a tampered listing row is refused there,
 * never trusted because the publisher once signed it.
 */

async function rows<T extends Record<string, unknown> = Record<string, unknown>>(q: ReturnType<typeof sql>) {
  const r = await db.execute<T>(q)
  return r.rows
}

/** SQL twin of {@link isModuleListingManifest}: module-shaped snapshot rows only. */
const MODULE_LISTING_PREDICATE = sql`manifest ? 'contributions' and not (manifest ? 'frontend')`

/**
 * Whether an `app_listings.manifest` snapshot is a module manifest.
 * Positive (`contributions` array) plus negative (no `frontend`): app
 * snapshots always carry `frontend`, module snapshots never do.
 */
export function isModuleListingManifest(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const m = raw as Record<string, unknown>
  return Array.isArray(m.contributions) && !('frontend' in m)
}

export type ModuleListingRow = {
  id: string
  key: string
  name: string
  description: string | null
  iconKey: string
  version: string
  publisherOrgId: string
  updatedAt: string
}

export interface ModuleListingPage {
  listings: ModuleListingRow[]
  total: number
}

/** Browse active MODULE listings (any org), with server-side search and pagination. */
export async function listModuleListings({
  query,
  page,
  perPage,
}: {
  query?: string
  page: number
  perPage: number
}): Promise<ModuleListingPage> {
  const where = sql`is_active = true and ${MODULE_LISTING_PREDICATE}${query
    ? sql` and (name ilike ${'%' + query + '%'} or key ilike ${'%' + query + '%'} or coalesce(description, '') ilike ${'%' + query + '%'})`
    : sql``}`
  const [listings, count] = await Promise.all([
    rows<ModuleListingRow>(sql`
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

/** Whether an active MODULE marketplace listing exists for a module key. */
export async function isModulePublished(key: string): Promise<boolean> {
  const found = await rows<{ found: boolean }>(sql`
    select true as found
      from app_listings
     where key = ${key} and is_active = true and ${MODULE_LISTING_PREDICATE}
     limit 1`)
  return found.length > 0
}

/**
 * Publish an installed module's ACTIVE version to the marketplace. One
 * listing per key deployment-wide; only the original publisher org may
 * update it. The published row is a byte copy of the version's manifest —
 * later installs, upgrades, and uninstalls in the publishing org leave the
 * snapshot frozen until someone publishes again.
 */
export async function publishModule(orgId: string, userId: string, key: string): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    if (!(await actorHasPermission(tx, orgId, userId, 'admin.customization.manage'))) throw new ModuleMarketplaceError('admin.customization.manage is required to publish modules', 403)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`app-listing:${key}`}, 0))`)
    const txRows = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) => (await tx.execute<T>(query)).rows
  const found = await txRows<{
    moduleId: string
    key: string
    name: string
    description: string | null
    iconKey: string
    version: string
    manifest: unknown
  }>(sql`
    select m.id as "moduleId", m.key, m.name, m.description, m.icon_key as "iconKey",
           v.version, v.manifest
      from modules m
      join module_versions v on v.id = m.active_version_id and v.org_id = m.org_id
     where m.org_id = ${orgId} and m.key = ${key} and m.kind = 'module'
       and m.status = 'installed' and v.status = 'active'
     limit 1`)
  const mod = found[0]
  if (!mod || !mod.manifest) throw new ModuleMarketplaceError('module not found or has no active version', 404)
  // Fail closed on a corrupt publisher row: only a manifest the canonical
  // parser accepts may become a listing other orgs will install.
  if (!isModuleListingManifest(mod.manifest) || !parseModuleManifest(mod.manifest).ok) {
    throw new ModuleMarketplaceError(`module "${key}" has no publishable active manifest`, 500)
  }

  const existing = await txRows<{ id: string; publisherOrgId: string; manifest: unknown }>(
    sql`select id, publisher_org_id as "publisherOrgId", manifest from app_listings where key = ${key} limit 1`,
  )
  if (existing[0] && existing[0].publisherOrgId !== orgId) {
    throw new ModuleMarketplaceError(`"${key}" is already published by another org`, 409)
  }
  if (existing[0] && !isModuleListingManifest(existing[0].manifest)) {
    throw new ModuleMarketplaceError(
      `"${key}" is already published as an app listing — one listing per key, and a publish never converts the other kind`,
      409,
    )
  }

  const before = existing[0] ? (await tx.execute(sql`select to_jsonb(l) as value from app_listings l where id = ${existing[0].id}`)).rows[0]?.value : null
  const manifestJson = JSON.stringify(mod.manifest)
  const r = await tx.execute<{ id: string }>(sql`
    insert into app_listings (publisher_org_id, key, name, description, icon_key, version, manifest, files, is_active, created_by, updated_by)
    values (${orgId}, ${key}, ${mod.name}, ${mod.description}, ${mod.iconKey}, ${mod.version},
            ${manifestJson}::jsonb, '[]'::jsonb, true, ${userId}, ${userId})
    on conflict (key) do update set
      name = excluded.name, description = excluded.description, icon_key = excluded.icon_key,
      version = excluded.version, manifest = excluded.manifest, files = excluded.files,
      is_active = true, updated_at = now(), updated_by = ${userId}
    where app_listings.publisher_org_id = ${orgId}
      and app_listings.manifest ? 'contributions' and not (app_listings.manifest ? 'frontend')
    returning id`)
  const id = r.rows[0]?.id
  // Unreachable past the pre-checks (the upsert's publisher guard updated
  // zero rows): someone else's key won the race. Named conflict, never a TypeError.
  if (!id) throw new ModuleMarketplaceError(`"${key}" is already published by another org`, 409)
  const after = (await tx.execute(sql`select to_jsonb(l) as value from app_listings l where id = ${id}`)).rows[0]?.value
  await tx.execute(sql`insert into audit_log (org_id, actor_id, table_name, row_id, action, changes)
    values (${orgId}, ${userId}, 'app_listings', ${id}, ${existing[0] ? 'update' : 'insert'},
      ${JSON.stringify({ event: 'module_marketplace_publish', reason: `publish module ${key}`, before, after })}::jsonb)`)
  return { id }
  })
}

/**
 * Install a marketplace MODULE listing into the caller's org via the module
 * installer. The snapshot bytes go through installModule() exactly as a
 * directly-uploaded manifest would — validation, grant intersection, and
 * approval evidence apply identically — so publisher tables are never read
 * and the installer's org isolation is the only boundary that matters.
 */
export async function installModuleFromListing(
  orgId: string,
  actorId: string,
  listingId: string,
  opts: {
    /** Admin-chosen grants, defaulting to everything the snapshot requests. Must be a subset of requested. */
    grantedPermissions?: string[]
    /**
     * The installing actor's resolved permission set. Required, no default:
     * the recorded grant is approved ∩ requested ∩ effective, and a caller
     * that cannot state its authority must not install.
     */
    installerEffectivePermissions: readonly string[]
    /** Why: recorded on every audit row this install writes (defaults to the marketplace provenance). */
    reason?: string
  },
): Promise<{ key: string; moduleId: string; versionId: string | null; outcome: InstallOutcome | 'pending-approval'; gateIds?: string[] }> {
  const found = await rows<{ key: string; version: string; manifest: unknown }>(sql`
    select key, version, manifest from app_listings where id = ${listingId} and is_active = true limit 1`)
  const listing = found[0]
  if (!listing) throw new ModuleMarketplaceError('listing not found', 404)
  if (!isModuleListingManifest(listing.manifest)) {
    throw new ModuleMarketplaceError(
      `listing "${listing.key}" is an app listing, not a module listing — install it from the app surface`,
      400,
    )
  }
  if (!permissionSetCovers(new Set(opts.installerEffectivePermissions), 'admin.customization.manage')) {
    throw new ModuleMarketplaceError('admin.customization.manage is required to install modules', 403)
  }
  const parsed = parseModuleManifest(listing.manifest)
  if (!parsed.ok) throw new ModuleMarketplaceError(parsed.errors.join('; '), 422)
  if (parsed.manifest!.key !== listing.key || parsed.manifest!.version !== listing.version) {
    throw new ModuleMarketplaceError('listing identity does not match its manifest', 409)
  }
  const reason = opts.reason?.trim() || `marketplace install of "${listing.key}" version ${listing.version}`
  if (parsed.manifest!.permissions.length > 0) {
    const current = (await db.execute<{ active_version_id: string | null; version: string | null; granted_permissions: string[] }>(sql`
      select m.active_version_id, v.version, m.granted_permissions from modules m
      left join module_versions v on v.org_id = m.org_id and v.id = m.active_version_id
      where m.org_id = ${orgId} and m.key = ${listing.key}`)).rows[0]
    if (current?.version === listing.version) {
      const installed = await installModule({ orgId, actorId, manifest: listing.manifest,
        grantedPermissions: opts.grantedPermissions ?? current.granted_permissions, installerEffectivePermissions: opts.installerEffectivePermissions, reason })
      return { key: listing.key, ...installed }
    }
    const request = {
      orgId, requesterId: actorId, manifest: listing.manifest,
      installerEffectivePermissions: opts.installerEffectivePermissions,
      grantedPermissions: opts.grantedPermissions,
      assignees: [{ type: 'role' as const, role: 'admin' }],
      signatureRequired: true, reason,
    }
    const staged = current?.active_version_id
      ? await requestModuleUpgradeApproval({ ...request, key: listing.key })
      : await requestModuleInstallApproval(request)
    return { key: listing.key, moduleId: staged.moduleId, versionId: null,
      outcome: 'pending-approval', gateIds: staged.gateIds }
  }
  const result = await installModule({
    orgId,
    actorId,
    manifest: listing.manifest,
    grantedPermissions: opts.grantedPermissions,
    installerEffectivePermissions: opts.installerEffectivePermissions,
    reason: opts.reason ?? `marketplace install of "${listing.key}" version ${listing.version}`,
  })
  return { key: listing.key, ...result }
}

export class ModuleMarketplaceError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message)
    this.name = 'ModuleMarketplaceError'
  }
}
