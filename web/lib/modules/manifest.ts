import { z } from 'zod'
import { navContributionSchema, permissionContributionSchema, settingContributionSchema } from '@openbooks/engine/src/modules/contribution-schemas.ts'
import { blockSchema, pageSpecSchema, SPEC_VERSION, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { automationGraphSchema, formSectionSchema } from '@openbooks/forms-core'
import { API_RECORD_TYPES } from '../api/registry-data'
import { RESERVED_TYPE_KEYS } from '../record-schema'

/**
 * Module manifest — the contract that describes an installable platform
 * module version. Shared by the installer (validates it), the capability
 * lattice (reads requested permissions), and the admin UI (shows what a
 * module contributes before anyone approves it). Pure module: no server-only
 * imports, so it can be reused client-side for pre-upload validation.
 *
 * A module VERSION is immutable: its manifest declares CONTRIBUTIONS, and
 * each contribution projects into a table the app already ships (page →
 * page_specs, field → custom_field_defs, …). The projection happens at
 * install/upgrade time under approvals; this file only decides what a valid
 * manifest IS and never touches the database.
 *
 * Conventions follow web/lib/apps/manifest.ts: SLUG/VERSION regexes,
 * parseManifest never throws, capability constants. Page, nav, setting and
 * permission contributions project through the atomic installer. Other kinds
 * validate structurally and explicitly report NOT_IMPLEMENTED_YET.
 */

/** Slug: lowercase, starts with a letter, [a-z0-9-]. */
const SLUG = /^[a-z][a-z0-9-]*$/
/** Loose semver: 1, 1.0, or 1.0.0 with optional -tag. */
const VERSION = /^\d+(\.\d+){0,2}(-[0-9a-z.-]+)?$/i
/** Route PATTERN a page contribution may claim: leading slash, Next.js path shape. */
const ROUTE = /^\/[A-Za-z0-9\-_/[\]().]+$/
/** snake_case identifier, as every projection table already keys on. */
const KEY = /^[a-z][a-z0-9_]{0,63}$/
/** Permission key: hierarchical module.action[.qualifier], as authz checks. */

/** Cron expression, at least the 5-field shape; the scheduler re-parses. */
const CRON = /^[^\s]+(\s+[^\s]+){4,5}$/

/**
 * Capability permissions a module may request. Modules run outside the
 * sandboxed iframe bridge, but they ask for the same governed operations an
 * App asks for (record reads/writes through platform CRUD, ledger writes
 * through the posting engine), so the constants mirror APP_CAPABILITIES in
 * web/lib/apps/manifest.ts. An admin grants a subset at approval; the
 * installer (Phase 1c) and the capability lattice (Phase 2a) enforce
 * granted ∩ installer's-effective — never the manifest's word alone.
 */
export const MODULE_CAPABILITIES = {
  /** Read custom records via platform CRUD (org-scoped). */
  RECORDS_READ: 'records.read',
  /** Create, update, and delete published custom records via platform CRUD. */
  RECORDS_CREATE: 'records.create',
  /** Governed ledger writes via the posting engine (draft + post). */
  GL_POST: 'gl.post',
} as const

/**
 * Every permission a module manifest may request, built exactly the way
 * APP_PLATFORM_PERMISSIONS is built: the capability constants above plus the
 * posting permissions and every record API read/write surface. A requested
 * string outside this catalogue is a manifest error, not a grant the
 * approval UI can meaningfully show — the catalogue is the shared language
 * approvals, installer, and admin UI all read from.
 */
export const MODULE_PLATFORM_PERMISSIONS = [
  ...new Set([
    MODULE_CAPABILITIES.RECORDS_READ,
    MODULE_CAPABILITIES.RECORDS_CREATE,
    MODULE_CAPABILITIES.GL_POST,
    'admin.customization.manage',
    'admin.setup.manage',
    'admin.roles.manage',
    'ap.post',
    'ar.post',
    ...API_RECORD_TYPES.flatMap((type) => [type.readPermission, type.writePermission].filter((p): p is string => !!p)),
  ]),
].sort()

/** Every contribution kind a manifest may declare, in lifecycle order. */
export const CONTRIBUTION_KINDS = [
  'page',
  'nav',
  'panel',
  'record-type',
  'field',
  'report',
  'card',
  'job',
  'endpoint',
  'hook',
  'flow',
  'agent',
  'permission',
  'setting',
] as const
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number]

/** Contribution kinds whose projection into platform tables is implemented. */
export const PROJECTED_KINDS: readonly ContributionKind[] = ['page', 'nav', 'setting', 'permission']

/** Kind names that are structurally validated but not yet projected. */
export const NOT_IMPLEMENTED_YET = 'NOT_IMPLEMENTED_YET' as const

/**
 * Per-kind payload schemas. `page` is the full v1 contract — route+spec+scope
 * projecting into page_specs, the contribution pattern the platform already
 * proves end to end. Every other kind carries the payload its future
 * projection target already accepts, so a manifest written today against
 * this schema is the manifest that installs when the projection lands.
 */
const pageContributionSchema = z.object({
  kind: z.literal('page'),
  /** Existing registered route PATTERN (/apps/[key]); customizes its layout through page_specs, without minting a route handler. */
  route: z.string().regex(ROUTE, 'route must be an absolute route pattern').max(120),
  /** The PageSpec document itself — validated against the closed schema. */
  spec: pageSpecSchema,
  /** Who the layout is for; 'org' projects with user_id null, 'user' is refused (a module customizes the org, never one person). */
  scope: z.enum(['org', 'user']).default('org'),
})

const panelContributionSchema = z.object({
  kind: z.literal('panel'),
  /** Route PATTERN whose page the panel is injected into. */
  route: z.string().regex(ROUTE, 'route must be an absolute route pattern').max(120),
  /** Named slot the page declares (e.g. 'header', 'aside'). */
  slot: z.string().regex(SLUG, 'slot must be a slug').max(64),
  /** ViewSpec block subtree rendered inside the slot — every block must satisfy the closed blockSchema vocabulary. */
  blocks: z.array(blockSchema).max(40),
  /** Render order among panels claiming the same slot. */
  sortOrder: z.number().int().min(0).max(10_000).default(0),
})

const recordTypeContributionSchema = z.object({
  kind: z.literal('record-type'),
  /** URL segment key (/records/<key>) — TYPE_KEY_RE plus the reserved keys record-schema refuses. */
  key: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,63}$/, 'key must be a 2–64 char slug')
    .refine((k) => !RESERVED_TYPE_KEYS.has(k), { message: 'key is reserved by the records surface' }),
  label: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  /** Ordered form sections, validated against the same formSectionSchema the record-type builder persists. */
  sections: z.array(formSectionSchema).min(1).max(50),
})

/**
 * Tables that actually carry custom-field storage today — the storage side of
 * CUSTOM_FIELD_TARGETS in packages/customization/src/custom-field-targets.ts.
 * A field contribution naming any other table could never project: the
 * installer would have nowhere to persist it.
 */
const CUSTOM_FIELD_TABLES = [
  'documents',
  'document_lines',
  'parties',
  'projects',
  'managed_properties',
  'accounts',
  'items',
  'crm_account_profiles',
  'crm_activities',
  'crm_opportunities',
  'item_rate_versions',
  'fixed_assets',
  'time_entries',
] as const

/** Tables a reference field may point at — CUSTOM_FIELD_REFERENCE_TABLES. */
const CUSTOM_FIELD_REFERENCE_TABLES = ['parties', 'projects', 'accounts', 'items'] as const

/**
 * Field-type vocabulary custom_field_defs accepts — FIELD_TYPES in
 * packages/customization/src/custom-field-definition.ts. Deliberately NOT the
 * wider forms-core fieldTypeSchema (no file/formula/pickers): a field
 * contribution projects into custom_field_defs, so only that table's nine
 * types are expressible.
 */
const CUSTOM_FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'currency',
  'date',
  'boolean',
  'select',
  'multi_select',
  'reference',
] as const

const fieldContributionBase = z.object({
  kind: z.literal('field'),
  /** Table the field extends, as custom_field_defs.target_table. */
  targetTable: z.enum(CUSTOM_FIELD_TABLES),
  /** Optional narrowing, e.g. documents of a kind — validated against live kinds at install. */
  targetKind: z.string().max(64).optional(),
  /** snake_case key, unique per target — the shape validator allows 2–61 chars. */
  key: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/, 'key must be snake_case (a-z, 0-9, _)'),
  label: z.string().min(1).max(120),
  fieldType: z.enum(CUSTOM_FIELD_TYPES),
  config: z.record(z.string(), z.unknown()).default({}),
  isRequired: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
})

/**
 * Field contribution with the config cross-rules the write path enforces
 * (validateCustomFieldDefinitionShape): select kinds need a non-empty unique
 * string option list, reference needs a valid referenceTable. Without these a
 * manifest parses here and dies at the projection it advertises.
 */
const fieldContributionSchema = fieldContributionBase.superRefine((f, ctx) => {
  if (f.fieldType === 'select' || f.fieldType === 'multi_select') {
    const opts = (f.config as { options?: unknown }).options
    if (!Array.isArray(opts) || opts.length === 0 || opts.some((o) => typeof o !== 'string' || !o.trim())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['config', 'options'], message: 'select fields need at least one option' })
    } else if (new Set(opts).size !== opts.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['config', 'options'], message: 'select options must be unique' })
    }
  }
  if (f.fieldType === 'reference') {
    const table = (f.config as { referenceTable?: unknown }).referenceTable
    if (typeof table !== 'string' || !(CUSTOM_FIELD_REFERENCE_TABLES as readonly string[]).includes(table)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', 'referenceTable'],
        message: 'reference fields need a valid referenceTable (parties, projects, accounts, items)',
      })
    }
  }
})

/**
 * Statement kinds the matrix/statement engine resolves — mirrors REPORT_KINDS
 * in web/lib/report-run.ts (server-only, so mirrored with citation rather
 * than imported; the installer re-checks against the live engine anyway).
 */
const REPORT_STATEMENT_KINDS = [
  'pnl',
  'balance-sheet',
  'trial-balance',
  'partners',
  'aging',
  'cash-flow',
  'cash-flow-indirect',
  'general-ledger',
  'journal',
  'registers',
  'budget',
  'partner-statement',
  'project-profitability',
  'true-cost',
] as const

const reportContributionBase = z.object({
  kind: z.literal('report'),
  /** URL slug (/reports/<slug>), as report_definitions.slug. */
  slug: z.string().regex(SLUG, 'slug must be a slug').max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  reportType: z.enum(['query', 'statement']).default('query'),
  /**
   * Custom-report query plan (report_type 'query'; validated by
   * validateCustomQuery on write, NULL for statements) or statement spec
   * ({ kind, params? }; NULL for queries) — schema/src/reporting.ts.
   */
  query: z.record(z.string(), z.unknown()).optional(),
  statement: z.object({ kind: z.enum(REPORT_STATEMENT_KINDS), params: z.record(z.string(), z.unknown()).optional() }).optional(),
})

/**
 * Report contribution with the storage exclusivity report_definitions
 * enforces: a query report carries no statement, a statement report carries
 * no query. A manifest claiming both (or the wrong one) parses here and
 * contradicts its row later.
 */
const reportContributionSchema = reportContributionBase.superRefine((r, ctx) => {
  if (r.reportType === 'query' && r.statement !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['statement'], message: 'query reports must not carry a statement spec' })
  }
  if (r.reportType === 'statement' && r.query !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['query'], message: 'statement reports must not carry a query plan' })
  }
})

const cardContributionSchema = z.object({
  kind: z.literal('card'),
  /** Insight-card name and query, as insight_cards stores them. */
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  query: z.record(z.string(), z.unknown()),
  vizType: z.enum(['table', 'bar', 'line', 'area', 'pie']).default('table'),
  vizSettings: z.record(z.string(), z.unknown()).default({}),
})

const jobContributionSchema = z.object({
  kind: z.literal('job'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  /** Cron expression; the scheduler re-parses with cron-parser. */
  cron: z.string().regex(CRON, 'cron must be a cron expression'),
  /** Hard wall-clock budget per run, milliseconds. */
  timeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
})

const endpointContributionSchema = z.object({
  kind: z.literal('endpoint'),
  /** HTTP method; module endpoints are read-only unless declared otherwise. */
  method: z.enum(['GET', 'POST', 'ANY']).default('ANY'),
  /** Backend handler path within the module bundle. */
  path: z.string().regex(SLUG, 'path must be a slug').max(64),
  description: z.string().max(2000).optional(),
})

const hookContributionSchema = z.object({
  kind: z.literal('hook'),
  /** Lifecycle trigger point, from the user_scripts trigger vocabulary. */
  trigger: z.enum([
    'before_submit',
    'before_post',
    'after_post',
    'before_void',
    'scheduled',
    'endpoint',
    'bulk',
    'client',
  ]),
  /** Backend handler path within the module bundle. */
  path: z.string().regex(SLUG, 'path must be a slug').max(64),
  /** Handler execution order among hooks on the same trigger. */
  sortOrder: z.number().int().min(0).max(10_000).default(100),
})

const flowContributionSchema = z.object({
  kind: z.literal('flow'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  /** Document/record subject kind the flow runs over (customer_invoice, …). */
  subjectKind: z.string().regex(KEY, 'subjectKind must be a snake_case identifier').max(64),
  /** Automation graph, validated against the same automationGraphSchema the flows table persists. */
  graph: automationGraphSchema,
  enabled: z.boolean().default(true),
})

const agentContributionSchema = z.object({
  kind: z.literal('agent'),
  /** Agent key (accounting, finance, …), as ai_agent_policies.agent_key. */
  key: z.string().regex(SLUG, 'key must be a slug').max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  /** Run cadence for autonomous agents. */
  cadence: z.enum(['daily', 'weekly']).default('daily'),
  /** Detector/analysis tuning, as the agent policies store. */
  settings: z.record(z.string(), z.unknown()).default({}),
})

/** One contribution: discriminated by `kind` against the per-kind payloads. */
export const contributionSchema = z.discriminatedUnion('kind', [
  pageContributionSchema,
  navContributionSchema,
  panelContributionSchema,
  recordTypeContributionSchema,
  fieldContributionSchema,
  reportContributionSchema,
  cardContributionSchema,
  jobContributionSchema,
  endpointContributionSchema,
  hookContributionSchema,
  flowContributionSchema,
  agentContributionSchema,
  permissionContributionSchema,
  settingContributionSchema,
])
export type ModuleContribution = z.infer<typeof contributionSchema>

/** A manifest: module identity, the version this payload belongs to, contributions. */
export const moduleManifestSchema = z.object({
  /** Module identity: stable across versions, org-unique. */
  key: z.string().regex(SLUG, 'key must be a slug (a-z, 0-9, -)').max(64),
  name: z.string().min(1).max(120),
  /** This version's tag — immutable once installed. */
  version: z.string().regex(VERSION, 'version must look like 1.0.0').max(32),
  /**
   * Optional blurb. Nullable on input because installed versions persist
   * the canonical manifest verbatim and rows written before the installer
   * omitted absent descriptions carry an explicit null — read-back
   * (diff/rollback re-parse the stored manifest) must accept what the
   * installer once wrote.
   */
  description: z.string().max(2000).nullable().optional(),
  /**
   * Requested platform permissions from MODULE_PLATFORM_PERMISSIONS; an
   * admin grants a subset at approval. Unknown strings are rejected — the
   * approval UI can only show grants from the shared catalogue.
   */
  permissions: z
    .array(z.string().max(80))
    .max(50)
    .default([])
    .superRefine((perms, ctx) => {
      for (let i = 0; i < perms.length; i++) {
        if (!(MODULE_PLATFORM_PERMISSIONS as readonly string[]).includes(perms[i]!)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: `unknown permission: ${perms[i]}` })
        }
      }
    }),
  contributions: z.array(contributionSchema).max(200).default([]),
})
export type ModuleManifest = z.infer<typeof moduleManifestSchema>

export interface ModuleManifestResult {
  ok: boolean
  manifest?: ModuleManifest
  errors: string[]
}

/**
 * Parse + validate a raw module manifest. Never throws.
 *
 * Structural validation only: zod checks each contribution against its
 * per-kind payload schema, then cross-contribution rules run by hand —
 * duplicate keys/routes a projection would collide on, and a page
 * contribution whose spec declares a route other than the one it is filed
 * under (the stored row's route column is authoritative, same rule as
 * page-specs enforces at read time).
 */
export function parseModuleManifest(raw: unknown): ModuleManifestResult {
  const res = moduleManifestSchema.safeParse(raw)
  if (!res.success) {
    return {
      ok: false,
      errors: res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    }
  }
  const manifest = res.data
  const errors: string[] = []
  const seenKinds = new Map<string, Set<string>>()
  const uniqueIn = (kind: string, namespace: string, value: string, label: string) => {
    let seen = seenKinds.get(`${kind}:${namespace}`)
    if (!seen) {
      seen = new Set<string>()
      seenKinds.set(`${kind}:${namespace}`, seen)
    }
    if (seen.has(value)) errors.push(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
  for (const c of manifest.contributions) {
    switch (c.kind) {
      case 'page':
        uniqueIn('page', 'route', c.route, 'page contribution route')
        if (c.spec.route && c.spec.route !== c.route) {
          errors.push(`page contribution for route ${c.route} carries a spec declaring route ${c.spec.route}`)
        }
        // A module version is org-wide by definition: it is reviewed and
        // approved once for everyone. `user` is a personal preference a
        // person sets for themselves in the layout editor, not something an
        // installer writes on someone's behalf.
        if (c.scope !== 'org') {
          errors.push('page contribution scope must be "org" — a module customizes the org, never one person')
        }
        break
      case 'panel':
        uniqueIn('panel', 'route+slot', `${c.route}#${c.slot}`, 'panel contribution route+slot')
        break
      case 'record-type':
        uniqueIn('record-type', 'key', c.key, 'record-type contribution key')
        break
      case 'field':
        uniqueIn('field', 'target+key', `${c.targetTable}/${c.targetKind ?? ''}#${c.key}`, 'field contribution key')
        break
      case 'report':
        uniqueIn('report', 'slug', c.slug, 'report contribution slug')
        break
      case 'card':
        uniqueIn('card', 'name', c.name, 'card contribution name')
        break
      case 'job':
        uniqueIn('job', 'name', c.name, 'job contribution name')
        break
      case 'endpoint':
        uniqueIn('endpoint', 'path', c.path, 'endpoint contribution path')
        break
      case 'hook':
        uniqueIn('hook', 'trigger+path', `${c.trigger}#${c.path}`, 'hook contribution path')
        break
      case 'flow':
        uniqueIn('flow', 'name', c.name, 'flow contribution name')
        break
      case 'agent':
        uniqueIn('agent', 'key', c.key, 'agent contribution key')
        break
      case 'nav':
        uniqueIn('nav', 'href', c.href, 'nav contribution href')
        break
      case 'permission':
        uniqueIn('permission', 'key', c.key, 'permission contribution key')
        break
      case 'setting':
        uniqueIn('setting', 'key', c.key, 'setting contribution key')
        break
    }
  }
  return { ok: errors.length === 0, manifest: errors.length ? undefined : manifest, errors }
}

/** What an install should do with a contribution of this kind. */
export interface ProjectionStatus {
  kind: ContributionKind
  /** 'projected' → the installer writes rows; the reason is the target table. */
  status: 'projected' | typeof NOT_IMPLEMENTED_YET
  /** Table/destination the contribution would project into. */
  target: string
}

/** Where each contribution kind projects, once implemented. */
export const PROJECTION_TARGETS: Readonly<Record<ContributionKind, string>> = {
  page: 'page_specs',
  panel: 'page_spec panels (pending)',
  'record-type': 'custom_record_types (pending)',
  field: 'custom_field_defs (pending)',
  report: 'report_definitions (pending)',
  card: 'insight_cards (pending)',
  job: 'user_scripts scheduled (pending)',
  endpoint: 'user_scripts endpoint (pending)',
  hook: 'user_scripts trigger (pending)',
  flow: 'flows (pending)',
  agent: 'ai_agent_policies (pending)',
  nav: 'org_nav_configs',
  permission: 'app_roles permission catalogue',
  setting: 'orgs.settings',
}

/**
 * Classify what an install would do with every contribution in a parsed
 * manifest. This is the report the approval UI shows and the installer
 * consumes: a NOT_IMPLEMENTED_YET kind is structurally valid but projects
 * nowhere yet, and the install must surface that result rather than
 * pretending the contribution happened.
 */
export function projectionStatuses(manifest: ModuleManifest): ProjectionStatus[] {
  return manifest.contributions.map((c) => ({
    kind: c.kind,
    status: PROJECTED_KINDS.includes(c.kind) ? ('projected' as const) : NOT_IMPLEMENTED_YET,
    target: PROJECTION_TARGETS[c.kind],
  }))
}

/** Count of contributions by projection status, for install summaries. */
export function projectionSummary(manifest: ModuleManifest): {
  projected: number
  notImplementedYet: number
} {
  const statuses = projectionStatuses(manifest)
  return {
    projected: statuses.filter((s) => s.status === 'projected').length,
    notImplementedYet: statuses.filter((s) => s.status !== 'projected').length,
  }
}

/** The PageSpec type re-exported for installer consumers. */
export type { PageSpec }
export { SPEC_VERSION }
