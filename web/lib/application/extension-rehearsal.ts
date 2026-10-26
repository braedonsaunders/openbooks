import 'server-only'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction, withTransactionSavepoint } from '@openbooks/engine/platform/db'
import { can } from '../authz'
import { parseManifest } from '../apps/manifest'
import { AppError, getAppByKey, installApp, invokeAppEndpointHandler } from '../apps/store'
import { ExtensionProjectionError } from '@openbooks/engine/extensions/pages'
import { getExtensionDraft, requireExtensionAuthor, validateExtensionBundle } from './extensions'
import { conflict, forbidden, invalidInput, notFound } from './errors'
import type { ApplicationContext } from './context'

/** Thrown inside the rehearsal transaction to roll back everything it did. */
class RehearsalComplete extends Error {
  constructor(readonly outcome: RehearsalOutcome) {
    super('rehearsal complete')
  }
}

export interface RehearsalOutcome {
  /** Whether the handler returned (true) or refused/failed (false). */
  succeeded: boolean
  /** The handler's normalized response when it returned. */
  response?: unknown
  /** The refusal or failure the operator would see. */
  error?: string
  status?: number
  logs: string[]
  units: number | null
  durationMs: number | null
}

type RunRow = { status: string; logs: string[]; errorMessage: string | null; units: number; durationMs: number | null }

/**
 * Run one backend endpoint exactly as an installed app would, then roll back.
 *
 * A draft is installed inside the same transaction first — its objects,
 * contributions and files — so the endpoint sees its own record types and
 * settings. The invocation runs through the production envelope (sandbox,
 * unit budget, grants intersected with the caller's permissions), its
 * evidence row is read, and the whole unit is rolled back: no record, journal,
 * storage value, installation or audit row survives. Only material that
 * leaves the database would escape a rollback, and the app host API has none.
 */
export async function rehearseExtensionEndpoint(
  context: ApplicationContext,
  input: { draftId?: string; key?: string; endpoint: string; body?: unknown },
): Promise<RehearsalOutcome & { rolledBack: true; key: string; source: 'draft' | 'installed' }> {
  await requireExtensionAuthor(context)
  if (!input.draftId === !input.key) throw invalidInput('Pass exactly one of draftId (rehearse an unpublished draft) or key (rehearse the installed app)')
  const { orgId } = context.authz.user
  let key = input.key ?? ''
  let install: (() => Promise<unknown>) | null = null
  if (input.draftId) {
    const draft = await getExtensionDraft(context, input.draftId)
    if (draft.status !== 'draft') throw conflict('Only an open draft can be rehearsed; prepare a new draft to change an activated package')
    const bundle = validateExtensionBundle(draft.bundle)
    const manifest = parseManifest(bundle.manifest).manifest!
    // The rehearsal acts with the authority activation would grant, so it
    // demands the same authority of the caller.
    for (const permission of bundle.grantedPermissions ?? manifest.permissions) {
      if (!can(context.authz, permission)) throw forbidden(permission)
    }
    key = manifest.key
    install = () => installApp(orgId, context.authz.user.id, bundle, { id: draft.id, hash: draft.content_hash })
  } else {
    const app = await getAppByKey(orgId, key)
    if (!app || !app.activeVersionId) throw notFound('app')
  }

  try {
    await withOrgTransaction(orgId, () => withTransactionSavepoint(db, async () => {
      if (install) await install()
      const result = await invokeAppEndpointHandler({
        orgId,
        user: context.authz.user,
        key,
        endpoint: input.endpoint,
        body: input.body ?? null,
        userCan: (permission) => can(context.authz, permission),
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        operation: `apps.rehearse.${input.endpoint}`,
        auditEndpoint: input.endpoint,
        idempotencyKey: `rehearsal:${randomUUID()}`,
      })
      const run = (await db.execute<RunRow>(sql`
        select r.status, r.logs, r.error_message as "errorMessage", r.units, r.duration_ms as "durationMs"
          from app_runs r join apps a on a.id = r.app_id and a.org_id = r.org_id
         where r.org_id = ${orgId} and a.key = ${key} and r.endpoint = ${input.endpoint}
         order by r.at desc limit 1`, 'objects'))[0]
      throw new RehearsalComplete({
        succeeded: result.ok,
        ...(result.ok ? { response: result.result } : { error: result.error, status: result.status }),
        logs: run?.logs ?? [],
        units: run?.units ?? null,
        durationMs: run?.durationMs ?? null,
      })
    }))
  } catch (error) {
    if (error instanceof RehearsalComplete) return { ...error.outcome, rolledBack: true, key, source: input.draftId ? 'draft' : 'installed' }
    if (error instanceof AppError || error instanceof ExtensionProjectionError) throw conflict(error.message)
    throw error
  }
  throw new Error('rehearsal ended without an outcome')
}

/** Recent backend invocations of an installed app, newest first, with their logs. */
export async function listExtensionRuns(context: ApplicationContext, input: { key: string; endpoint?: string; limit?: number }) {
  await requireExtensionAuthor(context)
  const { orgId } = context.authz.user
  const app = await getAppByKey(orgId, input.key)
  if (!app) throw notFound('app')
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
  const runs = await db.execute<RunRow & { endpoint: string; at: string; actorName: string | null }>(sql`
    select r.endpoint, r.status, r.logs, r.error_message as "errorMessage", r.units, r.duration_ms as "durationMs",
           r.at, u.name as "actorName"
      from app_runs r left join users u on u.id = r.actor_id and u.org_id = r.org_id
     where r.org_id = ${orgId} and r.app_id = ${app.id}
       ${input.endpoint ? sql`and r.endpoint = ${input.endpoint}` : sql``}
     order by r.at desc limit ${limit}`, 'objects')
  return { key: app.key, runs }
}
