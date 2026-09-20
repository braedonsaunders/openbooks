import 'server-only'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction, withTransactionSavepoint } from '@openbooks/engine/src/platform/db.ts'
import { can } from '../authz'
import { featureGateLockKey, isFeatureEnabled } from '../features'
import { getAppByKey, runBridgeMethod } from '../apps/store'
import { parseNativeExtension } from '../apps/native-ui'
import { validateRecordData, withComputedFormulas } from '../record-schema'
import { conflict, forbidden, invalidInput, notFound } from './errors'
import type { ApplicationContext } from './context'

const actionInput = z.object({
  screenKey: z.string().min(1).max(64), versionId: z.string().uuid(),
  invocationId: z.string().uuid(), input: z.record(z.string(), z.unknown()),
}).strict()

/** Native forms use the same sandbox, actor/grant intersection and atomic
 * invocation envelope as packaged HTML. They never obtain a database adapter.
 * Lock the installed version through completion so review/disable/grant changes
 * cannot race a submitted form. A stable invocation ID makes transport retries
 * replay; a new ID represents another intentional submission of the same data.
 */
export async function runExtensionAction(context: ApplicationContext, key: string, input: unknown) {
  if (!can(context.authz, 'apps.use')) throw forbidden('apps.use')
  const parsed = actionInput.safeParse(input)
  if (!parsed.success) throw invalidInput('Invalid extension action request')
  const request = parsed.data
  const { orgId } = context.authz.user
  return withOrgTransaction(orgId, () => withTransactionSavepoint(db, async () => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`extension-projections:${orgId}`}, 0))`)
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'extension-package:' + orgId + ':' + key}, 0))`)
    await db.execute(sql`select id from apps where org_id=${orgId} and key=${key} for update`)
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${featureGateLockKey(orgId)}, 0))`)
    if (!(await isFeatureEnabled(orgId, 'apps', db))) throw notFound('extension')
    const app = await getAppByKey(orgId, key)
    if (!app || app.status !== 'installed' || app.manifest?.frontend.renderer !== 'native') throw notFound('extension')
    if (app.activeVersionId !== request.versionId) throw conflict('This extension has changed. Reload the page before submitting.')
    const entry = (await db.execute<{ content: string }>(sql`select content from app_files
      where org_id=${orgId} and app_id=${app.id} and version_id=${request.versionId}
      and path=${app.manifest.frontend.entry} and not is_binary`)).rows[0]
    if (!entry) throw notFound('extension screen')
    const screen = parseNativeExtension(entry.content, app.manifest).screens.find(item => item.key === request.screenKey)
    if (!screen || screen.kind !== 'action') throw notFound('extension action')
    const values = withComputedFormulas(screen.fields, request.input)
    const errors = validateRecordData(screen.fields, values, 'submit')
    if (errors.length) throw invalidInput(errors.map(error => error.message).join('; '))
    // Return the envelope's refusal normally: its failure audit must commit.
    return runBridgeMethod({ orgId, user: context.authz.user, key, method: 'callBackend',
      payload: { endpoint: screen.endpoint, payload: { input: values, invocationId: request.invocationId } },
      userCan: permission => can(context.authz, permission), allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
    })
  }))
}
