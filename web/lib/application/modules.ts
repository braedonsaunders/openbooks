import 'server-only'

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { GateError } from '@openbooks/engine/src/flows/index.ts'
import { installModule, ModuleInstallError } from '@openbooks/engine/src/modules/installer.ts'
import {
  decideModuleApproval,
  ModuleLifecycleError,
  requestModuleInstallApproval,
  requestModuleUpgradeApproval,
} from '@openbooks/engine/src/modules/lifecycle.ts'
import { rollbackModuleVersion, requestRollbackApproval, ModuleRollbackError } from '@openbooks/engine/src/modules/rollback.ts'
import { can } from '../authz'
import type { ApplicationContext } from './context'
import { ApplicationError, forbidden, invalidInput } from './errors'
import { isUuid } from '../list-params'
import {
  CONTRIBUTION_KINDS,
  MODULE_PLATFORM_PERMISSIONS,
  NOT_IMPLEMENTED_YET,
  parseModuleManifest,
  PROJECTED_KINDS,
  PROJECTION_TARGETS,
  projectionSummary,
  type ContributionKind,
  type ModuleManifest,
} from '../modules/manifest'

/**
 * Modules as an application capability.
 *
 * An agent installing a platform module is the reason the installer and the
 * lifecycle exist as engine boundaries rather than UI handlers. A manifest it
 * writes declares contributions that project into tables the whole org reads,
 * and permissions the module may exercise — so the worst a bad one can do is
 * fail validation and be refused, and a capability-bearing one can only go
 * live after a distinct approver signs the gate it staged.
 *
 * The permission is `admin.customization.manage`, the same one that governs
 * page layouts, because it is the same authority: deciding what the org
 * renders and which grants the org carries. The capability lattice narrows
 * every grant to the installer's own effective set on top, so holding this
 * permission alone never arms a module with an operation the installer could
 * not perform themselves.
 */

const MODULE_KEY_PATTERN = /^[a-z][a-z0-9-]*$/

function requireModules(context: ApplicationContext): void {
  if (!can(context.authz, 'admin.customization.manage')) {
    throw forbidden('admin.customization.manage is required to read or change modules')
  }
}

function mapModuleError(error: unknown): never {
  if (error instanceof ModuleInstallError || error instanceof ModuleLifecycleError || error instanceof ModuleRollbackError) {
    const status = error.status
    if (status === 404) throw new ApplicationError('not_found', error.message, 404)
    if (status === 409) throw new ApplicationError('conflict', error.message, 409)
    if (status === 403) throw new ApplicationError('forbidden', error.message, 403)
    throw new ApplicationError('invalid_input', error.message, 422)
  }
  if (error instanceof GateError) {
    throw new ApplicationError('invalid_input', error.message, 422)
  }
  throw error
}

/** Deterministic encoding so a live contribution compares equal to the bytes that wrote it. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/**
 * The vocabulary a manifest may use, and the rules it must obey.
 *
 * Handed over rather than documented elsewhere, because an agent that cannot
 * enumerate the contribution kinds will invent one, and an invented kind is
 * a refused install at best. The names are read from the live manifest
 * contract, so this answer cannot drift from what the installer accepts.
 */
export async function describeModuleVocabulary(context: ApplicationContext) {
  requireModules(context)
  return {
    contributionKinds: [...CONTRIBUTION_KINDS],
    projectedKinds: [...PROJECTED_KINDS],
    projectionTargets: { ...PROJECTION_TARGETS },
    permissions: [...MODULE_PLATFORM_PERMISSIONS],
    rules: [
      'A manifest names a module key, a version label, the permissions it requests, and the contributions it projects.',
      'Only projected kinds install today; every other kind validates structurally and is refused at install rather than half performed.',
      'A page contribution customizes an existing application route and its existing loader with a PageSpec. Scope is always "org"; it does not create a new route handler.',
      'A version label is immutable once installed: changing anything means appending a new version, never editing.',
      'Requested permissions must come from the list above; an admin grants a subset at approval and the grant narrows to what the installer holds.',
      'An install carrying permissions stages an approval a distinct approver must sign; a zero-permission page-only install applies directly with audit.',
      'The org is taken from the session. A manifest that names an org id is refused.',
    ],
    limits: {
      note: 'A module customizes the org. Tenant customization of the same route always takes precedence; the module projection remains preserved underneath it.',
    },
  }
}

type ModuleListRow = {
  id: string
  key: string
  name: string
  description: string | null
  status: string
  granted_permissions: string[]
  version_id: string | null
  version: string | null
  version_status: string | null
}

/** Every module this org has installed, with its live version. */
export async function listModules(context: ApplicationContext) {
  requireModules(context)
  const rows = (
    await db.execute<ModuleListRow>(sql`
      select m.id, m.key, m.name, m.description, m.status, m.granted_permissions,
             v.id as version_id, v.version, v.status as version_status
        from modules m
        left join module_versions v on v.org_id = m.org_id and v.id = m.active_version_id
       where m.org_id = ${context.authz.user.orgId}
       order by m.key`)
  ).rows
  return {
    modules: rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      status: row.status,
      grantedPermissions: row.granted_permissions,
      activeVersion: row.version_id
        ? { id: row.version_id, version: row.version!, status: row.version_status! }
        : null,
    })),
  }
}

/**
 * Check a draft manifest without storing it.
 *
 * The affordance that makes the write tools usable: an agent iterates against
 * real errors instead of guessing, and a rejected draft costs nothing. Errors
 * name the offending contribution or permission rather than saying "invalid".
 */
export async function validateModule(context: ApplicationContext, input: { manifest: unknown }) {
  requireModules(context)
  const parsed = parseModuleManifest(input.manifest)
  if (!parsed.ok) return { valid: false as const, errors: parsed.errors }
  const manifest = parsed.manifest!
  const summary = projectionSummary(manifest)
  return {
    valid: true as const,
    errors: [] as string[],
    key: manifest.key,
    version: manifest.version,
    requestedPermissions: manifest.permissions,
    contributions: manifest.contributions.map((c) => ({
      kind: c.kind,
      identity: contributionIdentity(c),
      status: PROJECTED_KINDS.includes(c.kind) ? ('projected' as const) : NOT_IMPLEMENTED_YET,
      target: PROJECTION_TARGETS[c.kind],
    })),
    projectionSummary: summary,
  }
}

/**
 * Normalize installer-canonical bytes before re-parsing.
 *
 * The installer persists description: null for an absent description while
 * the contract validator declares it optional (undefined-only), so stored
 * bytes from a description-less install would otherwise refuse to parse
 * (reported as fnd_mtxuy0jf_y658ki for the owning slice to close at the
 * boundary). Normalizing at the read edge keeps a live version diffable
 * without forking the contract.
 */
function normalizeStoredManifest(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const out = { ...(raw as Record<string, unknown>) }
  if (out.description === null) delete out.description
  return out
}

/** Stable identity per kind — the same namespaces the manifest validator dedupes on. */
function contributionIdentity(contribution: ModuleManifest['contributions'][number]): string {
  switch (contribution.kind) {
    case 'nav':
      return contribution.href
    case 'page':
      return contribution.route
    case 'panel':
      return `${contribution.route}#${contribution.slot}`
    case 'record-type':
      return contribution.key
    case 'field':
      return `${contribution.targetTable}/${contribution.targetKind ?? ''}#${contribution.key}`
    case 'report':
      return contribution.slug
    case 'card':
      return contribution.name
    case 'job':
      return contribution.name
    case 'endpoint':
      return contribution.path
    case 'hook':
      return `${contribution.trigger}#${contribution.path}`
    case 'flow':
      return contribution.name
    case 'agent':
      return contribution.key
    case 'permission':
      return contribution.key
    case 'setting':
      return contribution.key
  }
}

type StagedAssignee = { type: 'user'; userId: string } | { type: 'role'; role: string }

function stageAssignees(approverUserId?: string): StagedAssignee[] {
  if (approverUserId !== undefined) {
    if (!isUuid(approverUserId)) throw invalidInput('approverUserId must be a UUID')
    return [{ type: 'user', userId: approverUserId }]
  }
  return [{ type: 'role', role: 'admin' }]
}

/**
 * Stage a module install, or self-apply it when no approval could add anything.
 *
 * A manifest that requests zero permissions and carries only projected kinds
 * applies immediately through the installer — validation, projection, and
 * audit in one transaction, with the caller as actor. Anything requesting a
 * permission stages a signed approval instead: a pending gate a distinct
 * approver applies with apply_module, and zero projected rows until then.
 * A manifest carrying a kind with no projection yet is returned with its
 * errors rather than stored — a silent partial install would be a fake
 * success path.
 */
export async function installModuleStaged(
  context: ApplicationContext,
  input: { manifest: unknown; reason?: string | null; approverUserId?: string },
) {
  requireModules(context)
  const parsed = parseModuleManifest(input.manifest)
  if (!parsed.ok) return { staged: false as const, applied: false as const, errors: parsed.errors }
  const manifest = parsed.manifest!
  const pending = manifest.contributions.filter((c) => !PROJECTED_KINDS.includes(c.kind))
  if (pending.length > 0) {
    return {
      staged: false as const,
      applied: false as const,
      errors: pending.map(
        (c) =>
          `contribution kind "${c.kind}" (${contributionIdentity(c)}) is not projectable yet; ` +
          `refusing the install rather than pretending it happened`,
      ),
    }
  }
  const reason = input.reason?.trim() || 'agent install'
  const effective = [...context.authz.permissions]
  const orgId = context.authz.user.orgId
  const actorId = context.authz.user.id

  if (manifest.permissions.length === 0 && manifest.contributions.every((c) => c.kind === 'page')) {
    try {
      const installed = await installModule({
        orgId,
        actorId,
        manifest: input.manifest,
        installerEffectivePermissions: effective,
        reason,
      })
      return {
        staged: false as const,
        applied: true as const,
        errors: [] as string[],
        moduleId: installed.moduleId,
        versionId: installed.versionId,
        outcome: installed.outcome,
        granted: [] as string[],
        withheld: [] as string[],
      }
    } catch (error) {
      mapModuleError(error)
    }
  }

  try {
    const live = (
      await db.execute<{ id: string; active_version_id: string | null; version: string | null; granted_permissions: string[] }>(sql`
        select m.id, m.active_version_id, v.version, m.granted_permissions from modules m
        left join module_versions v on v.org_id = m.org_id and v.id = m.active_version_id
         where m.org_id = ${orgId} and m.key = ${manifest.key} limit 1`)
    ).rows[0]
    if (live?.version === manifest.version) {
      const installed = await installModule({ orgId, actorId, manifest: input.manifest,
        grantedPermissions: live.granted_permissions, installerEffectivePermissions: effective, reason })
      return { staged: false as const, applied: true as const, errors: [] as string[],
        moduleId: installed.moduleId, versionId: installed.versionId, outcome: installed.outcome,
        granted: live.granted_permissions, withheld: manifest.permissions.filter((p) => !live.granted_permissions.includes(p)) }
    }
    const assignees = stageAssignees(input.approverUserId)
    const request =
      live && live.active_version_id !== null
        ? await requestModuleUpgradeApproval({
            orgId,
            requesterId: actorId,
            key: manifest.key,
            manifest: input.manifest,
            installerEffectivePermissions: effective,
            assignees,
            signatureRequired: true,
            reason,
          })
        : await requestModuleInstallApproval({
            orgId,
            requesterId: actorId,
            manifest: input.manifest,
            installerEffectivePermissions: effective,
            assignees,
            signatureRequired: true,
            reason,
          })
    return {
      staged: true as const,
      applied: false as const,
      errors: [] as string[],
      moduleId: request.moduleId,
      runId: request.runId,
      flowId: request.flowId,
      gateIds: request.gateIds,
      granted: request.granted,
      withheld: request.withheld,
      addsCapabilities: request.addsCapabilities,
      signatureRequired: true as const,
      replayed: request.replayed,
    }
  } catch (error) {
    mapModuleError(error)
  }
}

export interface ModuleDiffChange {
  kind: ContributionKind
  identity: string
  change: 'added' | 'removed' | 'changed'
  target: string
}

/**
 * What installing a manifest would change, per contribution kind.
 *
 * The affordance the apply tools were missing: an author sees added, changed,
 * and removed projections before anything is staged, plus the permission
 * delta and whether the upgrade needs re-approval. Nothing is stored.
 */
export async function diffModule(
  context: ApplicationContext,
  input: { key?: string; manifest: unknown },
) {
  requireModules(context)
  const parsed = parseModuleManifest(input.manifest)
  if (!parsed.ok) return { compared: false as const, errors: parsed.errors }
  const manifest = parsed.manifest!
  const moduleKey = input.key ?? manifest.key
  if (!MODULE_KEY_PATTERN.test(moduleKey)) throw invalidInput('key must be a module slug (a-z, 0-9, -)')

  const live = (
    await db.execute<{ id: string; version: string; manifest: unknown }>(sql`
      select m.id, v.version, v.manifest
        from modules m
        join module_versions v on v.org_id = m.org_id and v.id = m.active_version_id
       where m.org_id = ${context.authz.user.orgId} and m.key = ${moduleKey} limit 1`)
  ).rows[0]

  const proposed = manifest.contributions.map((c) => ({
    kind: c.kind as ContributionKind,
    identity: contributionIdentity(c),
    body: stableStringify(c),
  }))
  const livePermissions: string[] = []
  let liveVersion: string | null = null
  const liveByIdentity = new Map<string, string>()
  if (live) {
    liveVersion = live.version
    const liveParsed = parseModuleManifest(normalizeStoredManifest(live.manifest))
    // The stored manifest is the installer's canonicalization of bytes this
    // same validator once accepted; a row that no longer parses is corrupt
    // data, not a diff input problem, so it fails loudly.
    if (!liveParsed.ok) {
      throw new ApplicationError(
        'internal_error',
        `the live version of module "${moduleKey}" carries a manifest that no longer parses`,
        500,
      )
    }
    for (const permission of liveParsed.manifest!.permissions) livePermissions.push(permission)
    for (const c of liveParsed.manifest!.contributions) {
      liveByIdentity.set(`${c.kind}#${contributionIdentity(c)}`, stableStringify(c))
    }
  }

  const changes: ModuleDiffChange[] = []
  const seenLive = new Set<string>()
  for (const item of proposed) {
    const namespaced = `${item.kind}#${item.identity}`
    const liveBody = liveByIdentity.get(namespaced)
    if (liveBody === undefined) {
      changes.push({ kind: item.kind, identity: item.identity, change: 'added', target: PROJECTION_TARGETS[item.kind] })
    } else {
      seenLive.add(namespaced)
      if (liveBody !== item.body) {
        changes.push({ kind: item.kind, identity: item.identity, change: 'changed', target: PROJECTION_TARGETS[item.kind] })
      }
    }
  }
  for (const [namespaced] of liveByIdentity) {
    if (seenLive.has(namespaced)) continue
    const hash = namespaced.indexOf('#')
    const kind = namespaced.slice(0, hash) as ContributionKind
    changes.push({ kind, identity: namespaced.slice(hash + 1), change: 'removed', target: PROJECTION_TARGETS[kind] })
  }
  changes.sort((a, b) => a.identity.localeCompare(b.identity) || a.kind.localeCompare(b.kind))
  const changed = changes.filter((c) => c.change === 'changed').length
  const unchanged = seenLive.size - changed

  const proposedPermissions = [...manifest.permissions].sort()
  const sortedLive = [...livePermissions].sort()
  const added = proposedPermissions.filter((p) => !sortedLive.includes(p))
  const removed = sortedLive.filter((p) => !proposedPermissions.includes(p))
  return {
    compared: true as const,
    errors: [] as string[],
    key: moduleKey,
    liveVersion,
    proposedVersion: manifest.version,
    changes,
    unchanged,
    permissions: { live: sortedLive, proposed: proposedPermissions, added, removed },
    requiresReapproval:
      proposedPermissions.length > 0 || manifest.contributions.some((contribution) => contribution.kind !== 'page'),
  }
}

/**
 * Apply a staged module proposal by approving its gate.
 *
 * This is the decision half of install_module's stage: the same conditional
 * decide, authz, quorum, delegation, and signature enforcement every approval
 * rides. Capability-bearing stages require the approver's explicit signature;
 * separation of duties refuses the requester's own approval before the gate
 * is touched, so a refused self-approval leaves the gate pending.
 */
export async function applyModule(
  context: ApplicationContext,
  input: { gateId: string; comment?: string | null; signature?: string | null },
) {
  requireModules(context)
  if (!isUuid(input.gateId)) throw invalidInput('gateId must be a UUID')
  try {
    const decided = await decideModuleApproval({
      gateId: input.gateId,
      decision: 'approved',
      userId: context.authz.user.id,
      ...(input.comment != null ? { comment: input.comment } : {}),
      ...(input.signature != null ? { signature: input.signature } : {}),
      approverEffectivePermissions: [...context.authz.permissions],
    })
    return {
      applied: decided.resumed === 'approve' && decided.versionId !== null,
      errors: [] as string[],
      moduleId: decided.moduleId,
      versionId: decided.versionId,
      versionStatus: decided.versionStatus,
      runStatus: decided.runStatus,
    }
  } catch (error) {
    mapModuleError(error)
  }
}

type ModuleVersionRow = {
  id: string
  version: string
  status: string
  manifest: unknown
}

/**
 * Publish a previous version of a module again.
 *
 * The undo that outlives the session: the target version's recorded manifest
 * is reinstalled (re-projected, previous active superseded), and the version
 * it replaces is marked rolled back — history is appended, never rewritten.
 * Rolling back the version that is already live, or a module with no earlier
 * version, is refused with its reason rather than stored.
 */
export async function rollbackModule(
  context: ApplicationContext,
  input: { key: string; versionId?: string | null; reason?: string | null },
) {
  requireModules(context)
  const orgId = context.authz.user.orgId
  const actorId = context.authz.user.id
  const reason = input.reason?.trim() || 'agent rollback'

  const moduleRow = (
    await db.execute<{
      id: string
      status: string
      active_version_id: string | null
      granted_permissions: string[]
    }>(sql`
      select id, status, active_version_id, granted_permissions from modules
       where org_id = ${orgId} and key = ${input.key} limit 1`)
  ).rows[0]
  if (!moduleRow) {
    return { rolledBack: false as const, errors: [`module "${input.key}" is not installed`] }
  }
  if (moduleRow.status === 'disabled') {
    return {
      rolledBack: false as const,
      errors: [`module "${input.key}" is disabled; reactivate it before rolling back`],
    }
  }
  if (!moduleRow.active_version_id) {
    return {
      rolledBack: false as const,
      errors: [`module "${input.key}" has no live version to roll back from`],
    }
  }

  const versions = (
    await db.execute<ModuleVersionRow>(sql`
      select id, version, status, manifest from module_versions
       where org_id = ${orgId} and module_id = ${moduleRow.id}
       order by created_at desc`)
  ).rows
  const target = input.versionId
    ? versions.find((v) => v.id === input.versionId)
    : versions.find((v) => v.id !== moduleRow.active_version_id && v.status === 'superseded')
  if (!target) {
    return {
      rolledBack: false as const,
      errors: input.versionId
        ? [`version ${input.versionId} is not a version of module "${input.key}"`]
        : [`module "${input.key}" has no earlier version to roll back to`],
    }
  }
  if (target.id === moduleRow.active_version_id) {
    return {
      rolledBack: false as const,
      errors: [`version ${target.version} is already the live version of module "${input.key}"`],
    }
  }
  if (target.status === 'rolled_back') {
    return {
      rolledBack: false as const,
      errors: [`version ${target.version} was already rolled back`],
    }
  }
  if (target.status !== 'superseded') {
    return {
      rolledBack: false as const,
      errors: [`version ${target.version} is ${target.status}; only a superseded version can be rolled back to`],
    }
  }

  try {
    const restoringVersion = `0.0.0-restore-${randomUUID().replaceAll('-', '').slice(0, 16)}`
    const parsed = parseModuleManifest(normalizeStoredManifest(target.manifest))
    if (!parsed.ok) return { rolledBack: false as const, errors: parsed.errors }
    const requiresApproval = parsed.manifest!.permissions.length > 0 ||
      parsed.manifest!.contributions.some((contribution) => contribution.kind !== 'page')
    if (requiresApproval) {
      const request = await requestRollbackApproval({
        orgId, requesterId: actorId, key: input.key, targetVersionId: target.id,
        restoringVersion, installerEffectivePermissions: [...context.authz.permissions],
        assignees: stageAssignees(), reason,
      })
      return { rolledBack: false as const, staged: true as const, errors: [] as string[],
        moduleId: request.moduleId, gateIds: request.gateIds, runId: request.runId,
        signatureRequired: request.signatureRequired }
    }
    const restored = await rollbackModuleVersion({
      orgId, actorId, key: input.key, targetVersionId: target.id, restoringVersion, reason,
    })
    return {
      rolledBack: true as const,
      staged: false as const,
      errors: [] as string[],
      moduleId: restored.moduleId,
      versionId: restored.versionId,
      version: restored.restoringVersion,
      markedRolledBack: [restored.replacedVersionId],
    }
  } catch (error) {
    mapModuleError(error)
  }
}
