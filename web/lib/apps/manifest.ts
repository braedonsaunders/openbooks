import { z } from 'zod'
import { extensionContributionsSchema, EXTENSION_CONTRIBUTION_PERMISSIONS } from './contributions'
import { API_RECORD_TYPES } from '../api/registry-data'

/**
 * App manifest — the contract that describes an uploaded App bundle. Shared by
 * the upload/install API (validates it), the runtime (reads the entry point +
 * endpoint map), and the admin UI (shows requested permissions before an admin
 * grants them). Pure module: no server-only imports, so it can be reused
 * client-side for pre-upload validation.
 *
 * A bundle is `{ manifest, files }`. The manifest references files by their
 * bundle-relative path; validateBundle() checks every referenced path exists.
 */

/** Slug: lowercase, starts with a letter, [a-z0-9-]. */
const SLUG = /^[a-z][a-z0-9-]*$/
/** Loose semver: 1, 1.0, or 1.0.0 with optional -tag. */
const VERSION = /^\d+(\.\d+){0,2}(-[0-9a-z.-]+)?$/i
/** Bundle-relative path: no leading slash, no traversal. */
const BUNDLE_PATH = /^(?!\/)(?!.*\.\.)[a-z0-9._\-/]+$/i

/**
 * Capability permissions the runtime actively enforces. An App requests these
 * in its manifest; an admin grants a subset at install; the bridge/back-end
 * check every call against the granted set. `apps.storage.*` is always
 * available for the App's own KV store — it needs no grant.
 */
export const APP_CAPABILITIES = {
  /** Read custom records via ob.records / bridge records.* (org-scoped). */
  RECORDS_READ: 'records.read',
  /** Create, update, and delete published custom records via platform CRUD. */
  RECORDS_CREATE: 'records.create',
  /** Governed ledger writes via ob.journal (draft + post through the posting engine). */
  GL_POST: 'gl.post',
} as const

/** Every permission currently consumed by the governed App host API. */
export const APP_PLATFORM_PERMISSIONS = [
  ...new Set([
    APP_CAPABILITIES.RECORDS_READ,
    APP_CAPABILITIES.RECORDS_CREATE,
    APP_CAPABILITIES.GL_POST,
    ...Object.values(EXTENSION_CONTRIBUTION_PERMISSIONS),
    'ap.post',
    'ar.post',
    ...API_RECORD_TYPES.flatMap((type) => [type.readPermission, type.writePermission].filter((p): p is string => !!p)),
  ]),
].sort()

export const HTTP_METHODS = ['GET', 'POST', 'ANY'] as const

export const endpointSchema = z.object({
  /** Endpoint name — the frontend calls openbooks.callBackend(name, payload). */
  name: z.string().regex(SLUG, 'endpoint name must be a slug'),
  /** Bundle path to the backend JS file defining `function handler(req)`. */
  file: z.string().regex(BUNDLE_PATH, 'invalid endpoint file path'),
  method: z.enum(HTTP_METHODS).default('ANY'),
})

/**
 * App-declared assistant/MCP tools. An App may expose its own governed
 * capabilities to the assistant and to MCP clients by declaring them here;
 * each tool invokes one of the App's backend `endpoints` through the same
 * sandbox runtime, governance budget, and app_runs evidence as callBackend.
 * The assistant name is `app_<appKey>_<toolKey>` (snake-cased); mutating
 * tools always go through the confirmation-card path.
 */

/** Assistant-facing name for an installed App tool (always snake_case). */
export function appToolAssistantName(appKey: string, toolKey: string): string {
  const snake = (s: string) => s.toLowerCase().replace(/-/g, '_')
  return `app_${snake(appKey)}_${snake(toolKey)}`
}

const MAX_TOOL_INPUT_PROPS = 50
const MAX_TOOL_ENUM_VALUES = 64
const MAX_TOOL_STRING_LENGTH = 10_000
const MAX_TOOL_ARRAY_ITEMS = 200
const MAX_TOOL_SCHEMA_DEPTH = 3

const KNOWN_INPUT_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])
/** Composition keywords have no bounded runtime meaning here — reject them. */
const UNSUPPORTED_SCHEMA_KEYWORDS = ['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'patternProperties', 'additionalItems']

/** RE2-style pattern lint: no lookarounds (incl. named groups), no backreferences. */
function re2PatternError(pattern: string): string | null {
  try {
    void new RegExp(pattern)
  } catch {
    return 'must be a valid regular expression'
  }
  if (/\(\?[<>=!]/.test(pattern)) return 'must not use lookarounds or named groups (unsupported by RE2-style validators)'
  if (/\\[1-9]/.test(pattern)) return 'must not use backreferences (unsupported by RE2-style validators)'
  if (/\\k</.test(pattern)) return 'must not use named backreferences (unsupported by RE2-style validators)'
  if (/\[\]/.test(pattern)) return 'must not contain an empty character class (invalid under RE2 semantics)'
  return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate an App tool `inputSchema`: a plain JSON-Schema object with
 * `properties`, bounded strings/arrays/enums, and RE2-safe patterns. Returns
 * precise error strings (empty when valid). Exported so install paths and
 * tests share the exact check the manifest applies.
 */
export function validateToolInputSchema(schema: unknown, path = 'inputSchema', depth = 0): string[] {
  const errors: string[] = []
  if (!isPlainObject(schema)) return [`${path}: must be an object schema`]
  if (schema.type !== 'object') return [`${path}: type must be "object"`]
  if (!isPlainObject(schema.properties)) return [`${path}: properties is required and must be an object`]
  const properties: Record<string, unknown> = schema.properties
  for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
    if (keyword in schema) errors.push(`${path}: unsupported keyword "${keyword}"`)
  }
  const entries = Object.entries(properties)
  if (entries.length > MAX_TOOL_INPUT_PROPS) {
    errors.push(`${path}: at most ${MAX_TOOL_INPUT_PROPS} properties`)
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((r: unknown) => typeof r !== 'string' || !(r in properties))) {
      errors.push(`${path}: required must list declared property names`)
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    errors.push(`${path}: additionalProperties must be a boolean when present`)
  }
  if (depth >= MAX_TOOL_SCHEMA_DEPTH) {
    errors.push(`${path}: nesting exceeds ${MAX_TOOL_SCHEMA_DEPTH} levels`)
    return errors
  }
  for (const [name, raw] of entries) {
    const at = `${path}.properties.${name}`
    if (!isPlainObject(raw)) {
      errors.push(`${at}: must be an object schema`)
      continue
    }
    const type = raw.type as unknown
    if (typeof type !== 'string' || !KNOWN_INPUT_TYPES.has(type)) {
      errors.push(`${at}: type must be one of ${[...KNOWN_INPUT_TYPES].join(', ')}`)
      continue
    }
    if (raw.enum !== undefined) {
      const values: unknown = raw.enum
      if (!Array.isArray(values) || values.length === 0 || values.length > MAX_TOOL_ENUM_VALUES) {
        errors.push(`${at}: enum must list 1–${MAX_TOOL_ENUM_VALUES} values`)
      } else if ((values as unknown[]).some((v: unknown) => v !== null && !['string', 'number', 'boolean'].includes(typeof v))) {
        errors.push(`${at}: enum values must be strings, numbers, booleans, or null`)
      }
    }
    if (type === 'string') {
      if (typeof raw.maxLength !== 'number' || !Number.isInteger(raw.maxLength) || raw.maxLength < 1 || raw.maxLength > MAX_TOOL_STRING_LENGTH) {
        errors.push(`${at}: maxLength is required (1–${MAX_TOOL_STRING_LENGTH}) so tool input stays bounded`)
      }
      if (raw.pattern !== undefined) {
        if (typeof raw.pattern !== 'string') errors.push(`${at}: pattern must be a string`)
        else {
          const bad = re2PatternError(raw.pattern)
          if (bad) errors.push(`${at}.pattern: ${bad}`)
        }
      }
    }
    if (type === 'array') {
      if (typeof raw.maxItems !== 'number' || !Number.isInteger(raw.maxItems) || raw.maxItems < 1 || raw.maxItems > MAX_TOOL_ARRAY_ITEMS) {
        errors.push(`${at}: maxItems is required (1–${MAX_TOOL_ARRAY_ITEMS}) so tool input stays bounded`)
      }
      if (raw.items !== undefined) {
        if (!isPlainObject(raw.items)) errors.push(`${at}.items: must be an object schema`)
        else {
          const itemType = (raw.items as Record<string, unknown>).type
          if (typeof itemType !== 'string' || !KNOWN_INPUT_TYPES.has(itemType) || itemType === 'object' || itemType === 'array') {
            errors.push(`${at}.items: type must be a scalar (string, number, integer, or boolean)`)
          }
        }
      }
    }
    if (type === 'object') {
      errors.push(...validateToolInputSchema(raw, at, depth + 1))
    }
  }
  return errors
}

export const appToolConfirmationSchema = z.enum(['always', 'never'])

export const appToolSpecSchema = z.object({
  /** Tool key — slug; the assistant name is `app_<appKey>_<toolKey>` snake-cased. */
  key: z.string().regex(SLUG, 'tool key must be a slug (a-z, 0-9, -)').max(64),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  /** Plain-object JSON Schema (validated on install: bounded, RE2-safe patterns). */
  inputSchema: z.unknown(),
  /** Backend endpoint (already declared in `endpoints`) that serves this tool. */
  handler: z.string().regex(SLUG, 'handler must name a declared endpoint'),
  readOnly: z.boolean().default(true),
  destructive: z.boolean().default(false),
  /** Mutating tools are forced to "always" at parse time. */
  confirmation: appToolConfirmationSchema.optional(),
  /** Permissions the tool needs: subset of the manifest's requested permissions. */
  requiredPermissions: z.array(z.string().min(1).max(80)).max(20).default([]),
})

export type AppToolConfirmation = z.infer<typeof appToolConfirmationSchema>
export type AppToolSpec = Omit<z.infer<typeof appToolSpecSchema>, 'confirmation' | 'inputSchema'> & {
  confirmation: AppToolConfirmation
  inputSchema: Record<string, unknown>
}

/**
 * Install-time app-tool contract beyond parseManifest: every tool's
 * requiredPermissions must sit inside the ADMIN-GRANTED set (the admin may
 * narrow the requested permissions at install), and no tool's assistant name
 * (`app_<appKey>_<toolKey>`) may shadow a built-in assistant/application
 * tool. Pure — the caller supplies the static catalog names so this stays
 * import-cycle free. Returns precise error strings (empty when valid).
 */
export function validateAppToolsForInstall(
  manifest: AppManifest,
  granted: readonly string[],
  staticNames: ReadonlySet<string>,
): string[] {
  const errors: string[] = []
  const grantedSet = new Set(granted)
  for (const tool of manifest.tools ?? []) {
    for (const permission of tool.requiredPermissions) {
      if (!grantedSet.has(permission)) {
        errors.push(`tool "${tool.key}" requires "${permission}" which is not granted to this app`)
      }
    }
    const name = appToolAssistantName(manifest.key, tool.key)
    if (staticNames.has(name)) {
      errors.push(`tool "${tool.key}" collides with a built-in tool ("${name}"); rename the tool`)
    }
  }
  return errors
}

export const manifestSchema = z.object({
  key: z.string().regex(SLUG, 'key must be a slug (a-z, 0-9, -)').max(64),
  name: z.string().min(1).max(120),
  version: z.string().regex(VERSION, 'version must look like 1.0.0'),
  description: z.string().max(2000).optional(),
  /** Sidebar icon key (shared ICONS registry). */
  icon: z.string().max(40).optional(),
  /** Requested platform/capability permissions (admin grants a subset). */
  permissions: z.array(z.string().max(80)).max(50).default([]),
  frontend: z.object({
    /** Bundle path to the HTML entry point served into the sandboxed iframe. */
    entry: z.string().regex(BUNDLE_PATH, 'invalid frontend entry path'),
    /** Native JSON screens use house components; sandbox rendering isolates custom HTML and JavaScript. */
    renderer: z.enum(['native', 'sandbox']).default('sandbox'),
  }),
  endpoints: z.array(endpointSchema).max(50).default([]),
  /** Assistant/MCP tools served by the declared backend endpoints. */
  tools: z.array(appToolSpecSchema).max(20).default([]),
  contributions: extensionContributionsSchema.optional(),
  nav: z
    .object({
      label: z.string().max(120).optional(),
      icon: z.string().max(40).optional(),
    })
    .optional(),
})

export type AppManifest = z.infer<typeof manifestSchema>

export interface ManifestResult {
  ok: boolean
  manifest?: AppManifest
  errors: string[]
}

/** Parse + validate a raw manifest object. Never throws. */
export function parseManifest(raw: unknown): ManifestResult {
  const res = manifestSchema.safeParse(raw)
  if (!res.success) {
    return {
      ok: false,
      errors: res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    }
  }
  const manifest = res.data
  const errors: string[] = []
  for (const contribution of manifest.contributions ?? []) {
    const permission = EXTENSION_CONTRIBUTION_PERMISSIONS[contribution.kind]
    if (!manifest.permissions.includes(permission)) errors.push(`${contribution.kind} contribution requires ${permission}`)
  }
  // Endpoint names must be unique.
  const seen = new Set<string>()
  for (const e of manifest.endpoints) {
    if (seen.has(e.name)) errors.push(`duplicate endpoint name: ${e.name}`)
    seen.add(e.name)
  }
  const endpointNames = new Set(manifest.endpoints.map((e) => e.name))
  const requested = new Set(manifest.permissions)
  // Tool cross-checks: unique keys, a real handler endpoint, confirmation for
  // mutations, and permissions within the requested set. The tool input
  // schemas are validated here so every install path shares one gate.
  const toolKeys = new Set<string>()
  manifest.tools.forEach((tool, index) => {
    const at = `tools.${index}`
    if (toolKeys.has(tool.key)) errors.push(`duplicate tool key: ${tool.key}`)
    toolKeys.add(tool.key)
    if (!endpointNames.has(tool.handler)) {
      errors.push(`${at}: handler "${tool.handler}" is not a declared endpoint`)
    }
    if (!tool.readOnly && tool.confirmation === 'never') {
      errors.push(`${at}: mutating tools require confirmation "always"`)
    }
    if (tool.readOnly && tool.destructive) {
      errors.push(`${at}: read-only tools cannot be destructive`)
    }
    for (const permission of tool.requiredPermissions) {
      if (!requested.has(permission)) {
        errors.push(`${at}: requiredPermissions "${permission}" is not requested in manifest permissions`)
      }
    }
    for (const schemaError of validateToolInputSchema(tool.inputSchema, `${at}.inputSchema`)) {
      errors.push(schemaError)
    }
    // Normalize the effective confirmation so runtime readers see one value.
    if (tool.confirmation === undefined) {
      tool.confirmation = tool.readOnly ? 'never' : 'always'
    }
  })
  return { ok: errors.length === 0, manifest: errors.length ? undefined : manifest, errors }
}

/**
 * Validate that every path the manifest references actually exists in the
 * uploaded bundle, and classify each file. Returns errors + a per-path kind map
 * (frontend | backend | asset) the installer persists into app_files.kind.
 */
export function validateBundle(
  manifest: AppManifest,
  filePaths: string[],
): { ok: boolean; errors: string[]; kinds: Record<string, 'frontend' | 'backend' | 'asset'> } {
  const errors: string[] = []
  const set = new Set(filePaths)
  const kinds: Record<string, 'frontend' | 'backend' | 'asset'> = {}

  if (!set.has(manifest.frontend.entry)) {
    errors.push(`frontend entry not found in bundle: ${manifest.frontend.entry}`)
  }
  const backendFiles = new Set<string>()
  for (const e of manifest.endpoints) {
    if (!set.has(e.file)) errors.push(`endpoint "${e.name}" file not found: ${e.file}`)
    else backendFiles.add(e.file)
  }

  // Classify: entry + anything under frontend/ is frontend; endpoint files are
  // backend; everything else is a servable asset.
  for (const p of filePaths) {
    if (backendFiles.has(p)) kinds[p] = 'backend'
    else if (p === manifest.frontend.entry || p.startsWith('frontend/')) kinds[p] = 'frontend'
    else kinds[p] = 'asset'
  }

  return { ok: errors.length === 0, errors, kinds }
}

/** Guess a Content-Type from a bundle path (for serving to the iframe). */
export function contentTypeFor(path: string): { contentType: string; binary: boolean } {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'html': return { contentType: 'text/html; charset=utf-8', binary: false }
    case 'js': case 'mjs': return { contentType: 'text/javascript; charset=utf-8', binary: false }
    case 'css': return { contentType: 'text/css; charset=utf-8', binary: false }
    case 'json': return { contentType: 'application/json; charset=utf-8', binary: false }
    case 'svg': return { contentType: 'image/svg+xml', binary: false }
    case 'png': return { contentType: 'image/png', binary: true }
    case 'jpg': case 'jpeg': return { contentType: 'image/jpeg', binary: true }
    case 'gif': return { contentType: 'image/gif', binary: true }
    case 'webp': return { contentType: 'image/webp', binary: true }
    case 'woff': return { contentType: 'font/woff', binary: true }
    case 'woff2': return { contentType: 'font/woff2', binary: true }
    default: return { contentType: 'text/plain; charset=utf-8', binary: false }
  }
}
