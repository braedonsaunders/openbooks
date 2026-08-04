import { z } from 'zod'
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
    'ap.post',
    'ar.post',
    ...API_RECORD_TYPES.flatMap((type) => [type.readPermission, type.writePermission].filter((p): p is string => !!p)),
  ]),
].sort()

export const HTTP_METHODS = ['GET', 'POST', 'ANY'] as const
export type AppHttpMethod = (typeof HTTP_METHODS)[number]

export const endpointSchema = z.object({
  /** Endpoint name — the frontend calls openbooks.callBackend(name, payload). */
  name: z.string().regex(SLUG, 'endpoint name must be a slug'),
  /** Bundle path to the backend JS file defining `function handler(req)`. */
  file: z.string().regex(BUNDLE_PATH, 'invalid endpoint file path'),
  method: z.enum(HTTP_METHODS).default('ANY'),
})

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
  }),
  endpoints: z.array(endpointSchema).max(50).default([]),
  nav: z
    .object({
      label: z.string().max(120).optional(),
      icon: z.string().max(40).optional(),
    })
    .optional(),
})

export type AppManifest = z.infer<typeof manifestSchema>
export type AppEndpoint = z.infer<typeof endpointSchema>

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
  // Endpoint names must be unique.
  const seen = new Set<string>()
  for (const e of manifest.endpoints) {
    if (seen.has(e.name)) errors.push(`duplicate endpoint name: ${e.name}`)
    seen.add(e.name)
  }
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
