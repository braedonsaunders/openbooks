import { z, type ZodTypeAny } from 'zod'
import { permissionSetCovers } from '@openbooks/engine/src/organization/permissions.ts'
import { appToolAssistantName } from './manifest'

/**
 * Pure App-tool schema core: JSON-Schema-subset → zod conversion, input
 * validation, and the permission-intersection renderer. Deliberately free of
 * server-only imports so unit tests exercise the real logic with injected
 * rows. The repo has no JSON-Schema validator dependency, so the bounded
 * subset install validation accepts (manifest.ts `validateToolInputSchema`)
 * maps directly onto zod here — one subset, one converter, no drift.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function described<T extends ZodTypeAny>(schema: T, prop: Record<string, unknown>): T {
  return typeof prop.description === 'string' && prop.description.length > 0
    ? (schema.describe(prop.description) as T)
    : schema
}

function withEnum(base: ZodTypeAny, prop: Record<string, unknown>): ZodTypeAny {
  if (!Array.isArray(prop.enum) || prop.enum.length === 0) return base
  const values = prop.enum as unknown[]
  if (values.every((v) => typeof v === 'string')) {
    return z.enum(values as [string, ...string[]])
  }
  const literals: ZodTypeAny[] = values.map((v) =>
    v === null ? z.null() : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? z.literal(v) : z.unknown(),
  )
  if (literals.length === 1) return literals[0]!
  return z.union([literals[0]!, literals[1]!, ...literals.slice(2)])
}

function scalarToZod(prop: Record<string, unknown>): ZodTypeAny {
  const type = prop.type as string
  let base: ZodTypeAny
  if (type === 'string') {
    let s = z.string()
    if (typeof prop.maxLength === 'number') s = s.max(prop.maxLength)
    if (typeof prop.minLength === 'number') s = s.min(prop.minLength)
    if (typeof prop.pattern === 'string') s = s.regex(new RegExp(prop.pattern))
    base = withEnum(s, prop)
  } else if (type === 'integer') {
    let n = z.number().int()
    if (typeof prop.minimum === 'number') n = n.min(prop.minimum)
    if (typeof prop.maximum === 'number') n = n.max(prop.maximum)
    base = withEnum(n, prop)
  } else if (type === 'number') {
    let n = z.number()
    if (typeof prop.minimum === 'number') n = n.min(prop.minimum)
    if (typeof prop.maximum === 'number') n = n.max(prop.maximum)
    base = withEnum(n, prop)
  } else if (type === 'boolean') {
    base = withEnum(z.boolean(), prop)
  } else if (type === 'array') {
    const items = isRecord(prop.items) && typeof prop.items.type === 'string' && prop.items.type !== 'object' && prop.items.type !== 'array'
      ? scalarToZod(prop.items as Record<string, unknown>)
      : z.unknown()
    let a = z.array(items)
    if (typeof prop.maxItems === 'number') a = a.max(prop.maxItems)
    if (typeof prop.minItems === 'number') a = a.min(prop.minItems)
    base = a
  } else {
    base = z.unknown()
  }
  return described(base, prop)
}

function objectToZod(schema: Record<string, unknown>): ZodTypeAny {
  if (!isRecord(schema.properties)) throw new Error('tool input schema must declare properties')
  const properties = schema.properties as Record<string, unknown>
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).filter((r): r is string => typeof r === 'string') : [])
  const shape: Record<string, ZodTypeAny> = {}
  for (const [name, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) throw new Error(`property "${name}" must be an object schema`)
    const prop = raw as Record<string, unknown>
    const field = prop.type === 'object' ? objectToZod(prop) : scalarToZod(prop)
    shape[name] = required.has(name) ? field : field.optional()
  }
  const object = z.object(shape)
  return schema.additionalProperties === false ? object.strict() : object
}

/**
 * Convert a stored (install-validated) tool input schema to zod. Throws on
 * anything outside the bounded subset — callers skip such tools instead of
 * crashing the catalog build.
 */
export function jsonSchemaToZod(schema: unknown): ZodTypeAny {
  if (!isRecord(schema) || schema.type !== 'object') throw new Error('tool input schema must be an object schema')
  return objectToZod(schema)
}

/** Validate raw tool input without throwing; failures are model-safe. */
export function parseToolInput(
  zodSchema: ZodTypeAny,
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = zodSchema.safeParse(input)
  if (parsed.success) {
    const value: unknown = parsed.data
    return { ok: true, value: isRecord(value) ? value : {} }
  }
  const problems = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
  return { ok: false, error: `invalid_input: ${problems.join('; ')}` }
}

/** Installed-app shape the renderer needs; the store's AppRow satisfies it. */
export interface AppToolSource {
  key: string
  name: string
  status: 'installed' | 'disabled'
  grantedPermissions: string[]
  manifest: {
    tools?: {
      key: string
      title: string
      description: string
      inputSchema: unknown
      handler: string
      readOnly: boolean
      destructive: boolean
      confirmation?: 'always' | 'never'
      requiredPermissions?: string[]
    }[] | undefined
  } | null
}

export interface AppToolActor {
  permissions: ReadonlySet<string>
  appsUse: boolean
}

export interface AppToolView {
  appKey: string
  appName: string
  toolKey: string
  /** Assistant/MCP-facing snake_case name: app_<appKey>_<toolKey>. */
  name: string
  title: string
  /** Model-facing description, prefixed with the app name. */
  description: string
  readOnly: boolean
  destructive: boolean
  confirmation: 'always' | 'never'
  requiredPermissions: string[]
  inputSchema: Record<string, unknown>
  zodSchema: ZodTypeAny
}

/**
 * Render the installed, enabled apps' tool specs the ACTOR may see:
 * app-granted ∩ user permissions, with unconvertible stored schemas skipped
 * (never a catalog crash). Pure — the server wrapper supplies rows.
 */
export function renderAppToolViews(
  sources: readonly AppToolSource[],
  actor: AppToolActor,
  appsFeatureOn: boolean,
): AppToolView[] {
  if (!appsFeatureOn || !actor.appsUse) return []
  const views: AppToolView[] = []
  for (const source of sources) {
    if (source.status !== 'installed' || !source.manifest) continue
    const granted = new Set(source.grantedPermissions)
    for (const spec of source.manifest.tools ?? []) {
      const required = spec.requiredPermissions ?? []
      if (!required.every((p) => permissionSetCovers(granted, p) && permissionSetCovers(actor.permissions, p))) continue
      let zodSchema: ZodTypeAny
      try {
        zodSchema = jsonSchemaToZod(spec.inputSchema)
      } catch {
        continue
      }
      views.push({
        appKey: source.key,
        appName: source.name,
        toolKey: spec.key,
        name: appToolAssistantName(source.key, spec.key),
        title: spec.title,
        description: `${source.name}: ${spec.description}`,
        readOnly: spec.readOnly,
        destructive: spec.destructive,
        confirmation: spec.confirmation ?? (spec.readOnly ? 'never' : 'always'),
        requiredPermissions: [...required],
        inputSchema: isRecord(spec.inputSchema) ? spec.inputSchema : { type: 'object', properties: {} },
        zodSchema,
      })
    }
  }
  return views
}
