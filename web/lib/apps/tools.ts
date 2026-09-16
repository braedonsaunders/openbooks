import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { featureEnabled, type FeatureState } from '@openbooks/engine/src/feature-registry.ts'
import type { Authz } from '../authz'
import { can } from '../authz'
import type { SessionUser } from '../auth'
import { resolvedFeatureState } from '../features'
import { permissionSetCovers } from '../permissions'
import { canRunTool } from '../assistant/gate'
import { signApplicationCommand, verifyApplicationCommand } from '../assistant/application-proposals'
import type { AssistantToolDef, ToolResult } from '../assistant/types'
import { getAppByKey, invokeAppEndpointHandler, listApps } from './store'
import { appToolAssistantName } from './manifest'
import {
  jsonSchemaToZod,
  parseToolInput,
  renderAppToolViews,
  type AppToolView,
} from './tool-schema'

/**
 * App-declared assistant/MCP tools runtime. Installed, enabled apps may
 * expose their own governed capabilities (`tools` in the app manifest); each
 * tool invokes its handler endpoint through the same sandbox runtime,
 * governance budget, and app_runs evidence as callBackend
 * (`invokeAppEndpointHandler`). Visibility is app-granted ∩ user permissions
 * with the `apps` feature on and `apps.use` held; every execute() re-checks
 * that intersection defensively against the stored manifest.
 */

/** Hard cap on an app tool's response body so one call cannot blow the turn. */
const MAX_TOOL_RESPONSE_BYTES = 64 * 1024

export type AppToolInvoker = typeof invokeAppEndpointHandler

/** Rendered assistant definitions for every app tool the actor may see. */
export async function listAppToolViews(
  orgId: string,
  authz: Authz,
  features?: FeatureState | null,
  deps?: { listApps?: typeof listApps },
): Promise<AppToolView[]> {
  const appsFeatureOn = !features || featureEnabled(features, 'apps')
  if (!appsFeatureOn) return []
  const rows = await (deps?.listApps ?? listApps)(orgId)
  return renderAppToolViews(
    rows,
    { permissions: authz.permissions, appsUse: can(authz, 'apps.use') },
    appsFeatureOn,
  )
}

export interface RunAppToolOptions {
  orgId: string
  user: SessionUser
  appKey: string
  toolKey: string
  input: unknown
  userCan: (perm: string) => boolean
  allowedSubsidiaryIds: ReadonlySet<string> | null
  /** Fresh caller key; generated per call when omitted. */
  idempotencyKey?: string
}

/**
 * Validate tool input against the stored JSON schema and invoke the handler
 * endpoint inside the governed envelope. Returns the endpoint body, or a
 * bridge-shaped refusal. Mutating tools must go through the confirmation
 * path (toAssistantToolDef) — this entry point executes unconditionally and
 * is for read tools, the commit route, and MCP.
 */
export async function runAppTool(
  opts: RunAppToolOptions,
  deps?: { getApp?: typeof getAppByKey; invoke?: AppToolInvoker },
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; status: number }> {
  if (!opts.userCan('apps.use')) return { ok: false, error: 'forbidden', status: 403 }
  const app = await (deps?.getApp ?? getAppByKey)(opts.orgId, opts.appKey)
  if (!app || !app.manifest) return { ok: false, error: 'app not found', status: 404 }
  if (app.status !== 'installed') return { ok: false, error: 'app is disabled', status: 403 }
  const spec = app.manifest.tools?.find((t) => t.key === opts.toolKey)
  if (!spec) return { ok: false, error: `no such tool: ${opts.toolKey}`, status: 404 }
  const granted = new Set(app.grantedPermissions)
  for (const permission of spec.requiredPermissions ?? []) {
    if (!permissionSetCovers(granted, permission) || !opts.userCan(permission)) {
      return { ok: false, error: 'forbidden', status: 403 }
    }
  }
  let zodSchema
  try {
    zodSchema = jsonSchemaToZod(spec.inputSchema)
  } catch {
    return { ok: false, error: 'tool schema unavailable', status: 500 }
  }
  const parsed = parseToolInput(zodSchema, opts.input)
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 422 }
  return (deps?.invoke ?? invokeAppEndpointHandler)({
    orgId: opts.orgId,
    user: opts.user,
    key: opts.appKey,
    endpoint: spec.handler,
    body: parsed.value,
    userCan: opts.userCan,
    allowedSubsidiaryIds: opts.allowedSubsidiaryIds,
    operation: `apps.assistant_tool.${appToolAssistantName(opts.appKey, opts.toolKey)}`,
    auditEndpoint: `tool/${opts.toolKey}`,
    idempotencyKey: opts.idempotencyKey ?? randomUUID(),
  })
}

/**
 * Render one installed app-tool view as an AssistantToolDef. Read tools
 * execute through runAppTool; mutating tools return the SAME proposed-command
 * card application mutations use (assistantConfirmation "always") — the model
 * receives a signed review card and nothing changes until the user Applies it
 * on the application-command commit path.
 */
export function toAssistantToolDef(view: AppToolView): AssistantToolDef {
  return {
    name: view.name,
    description: `${view.description} ${view.readOnly ? 'Read-only.' : 'Requires the user to confirm before anything changes.'}`,
    category: view.readOnly ? 'read' : 'write',
    inputSchema: view.zodSchema,
    gate: view.requiredPermissions.length > 0
      ? { mode: 'allOf', perms: view.requiredPermissions }
      : { mode: 'public' },
    feature: 'apps',
    requiresConfirmation: view.readOnly ? undefined : true,
    execute: async (args, authz): Promise<ToolResult> => {
      const features = await resolvedFeatureState(authz.user.orgId)
      if (!featureEnabled(features, 'apps')) return { ok: false, error: 'forbidden' }
      for (const permission of view.requiredPermissions) {
        if (!can(authz, permission)) return { ok: false, error: 'forbidden' }
      }
      const parsed = parseToolInput(view.zodSchema, args)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      if (!view.readOnly) {
        return {
          ok: true,
          data: {
            proposedApplicationCommand: {
              toolName: view.name,
              title: view.title,
              destructive: view.destructive,
              input: parsed.value,
              confirmToken: signApplicationCommand(view.name, parsed.value, authz),
            },
          },
          note: 'Awaiting explicit user confirmation. Nothing has been changed.',
        }
      }
      const outcome = await runAppTool({
        orgId: authz.user.orgId,
        user: authz.user,
        appKey: view.appKey,
        toolKey: view.toolKey,
        input: parsed.value,
        userCan: (perm) => can(authz, perm),
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      })
      if (!outcome.ok) return { ok: false, error: outcome.error }
      const encoded = JSON.stringify(outcome.result)
      if (encoded.length > MAX_TOOL_RESPONSE_BYTES) {
        return { ok: false, error: 'tool response too large; narrow the request' }
      }
      return { ok: true, data: outcome.result }
    },
  }
}

/**
 * Commit a confirmed mutating app tool — the Apply half of the propose→
 * confirm→commit path. Uses the SAME HMAC confirmation scheme as application
 * mutations (sign/verifyApplicationCommand): the token binds actor, tenant,
 * tool, input, and expiry, and its sha256 becomes the invocation idempotency
 * key, so a retried Apply replays the stored outcome instead of re-running
 * the handler. Read tools are rejected (they execute directly, no commit).
 */
export async function commitAppToolCommand(
  authz: Authz,
  toolName: string,
  input: unknown,
  confirmToken: string,
  features?: FeatureState | null,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string; status: number }> {
  const resolved = features ?? await resolvedFeatureState(authz.user.orgId)
  const views = await listAppToolViews(authz.user.orgId, authz, resolved)
  const view = views.find((v) => v.name === toolName)
  if (!view || view.readOnly) return { ok: false, error: 'unsupported_command', status: 400 }
  const def = toAssistantToolDef(view)
  if (!canRunTool(authz, def, resolved)) return { ok: false, error: 'forbidden', status: 403 }
  const parsed = parseToolInput(view.zodSchema, input)
  if (!parsed.ok) return { ok: false, error: 'invalid_input', status: 422 }
  if (!verifyApplicationCommand(view.name, parsed.value, confirmToken, authz)) {
    return { ok: false, error: 'confirmation_expired_or_modified', status: 422 }
  }
  // The token is the durable identity of this proposed write; committing
  // through it makes Apply idempotent across retries and double-clicks.
  const commitKey = createHash('sha256').update(confirmToken).digest('hex')
  return runAppTool({
    orgId: authz.user.orgId,
    user: authz.user,
    appKey: view.appKey,
    toolKey: view.toolKey,
    input: parsed.value,
    userCan: (perm) => can(authz, perm),
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    idempotencyKey: commitKey,
  })
}

export type { AppToolView }
