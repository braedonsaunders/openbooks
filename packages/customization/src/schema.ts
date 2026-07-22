/**
 * Zod validation for the customization config blobs, plus the system-default
 * builders and the cross-field linter. Server (API writes) parses + lints
 * authoritatively; the web designer uses the same schemas client-side so the
 * two can never disagree (same contract as @openbooks/forms-core).
 */

import { z } from "zod";
import {
  RECORD_TYPE_BY_KEY,
  isBuiltInColumn,
  isBuiltInField,
  isBuiltInFilter,
  isCustomFieldKey,
  listColumnMeta,
  listFilterMeta,
  OPERATORS_BY_KIND,
} from "./registry";
import type {
  FilterOperator,
  FormActionPlacement,
  FormLayoutConfig,
  HeaderFieldPlacement,
  LineColumnPlacement,
  ListColumnPlacement,
  ListViewConfig,
  RecordTypeKey,
} from "./types";
import { DEFAULT_PER_PAGE } from "./types";

const fieldKeySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9_]+$/, "field key must be snake_case");

const recordTypeSchema = z
  .string()
  .min(1)
  .max(60)
  .refine((k) => k in RECORD_TYPE_BY_KEY, { message: "unknown record type" });

const headerFieldPlacementSchema = z.object({
  key: fieldKeySchema,
  visible: z.boolean(),
  labelOverride: z.string().max(120).nullable().optional(),
  required: z.boolean().nullable().optional(),
  colSpan: z.number().int().min(1).max(4).nullable().optional(),
});

const headerGroupSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().max(120).nullable().optional(),
  fields: z.array(headerFieldPlacementSchema).max(200),
});

const lineColumnPlacementSchema = z.object({
  key: fieldKeySchema,
  visible: z.boolean(),
  width: z.string().max(60).nullable().optional(),
  labelOverride: z.string().max(120).nullable().optional(),
});

export const FORM_ACTION_KEYS = [
  "customize",
  "pdf",
  "workflow",
  "approval",
  "edit",
  "submit",
  "post",
  "gl_impact",
  "delete",
] as const;

const formActionPlacementSchema = z.object({
  key: z.enum(FORM_ACTION_KEYS),
  visible: z.boolean(),
});

export const formLayoutConfigSchema = z.object({
  schemaVersion: z.literal(1),
  defaultVisibilityVersion: z.literal(1).optional(),
  defaultLayoutVersion: z.literal(1).optional(),
  recordType: recordTypeSchema,
  header: z.object({ groups: z.array(headerGroupSchema).min(1).max(20) }),
  lines: z.object({ columns: z.array(lineColumnPlacementSchema).max(200) }),
  actions: z.array(formActionPlacementSchema).length(FORM_ACTION_KEYS.length),
});

const filterOperatorSchema = z.enum([
  "eq",
  "ne",
  "in",
  "not_in",
  "gte",
  "lte",
  "between",
  "contains",
  "is_set",
  "is_not_set",
]);

const filterClauseSchema = z.object({
  key: fieldKeySchema,
  operator: filterOperatorSchema,
  value: z.union([z.string().max(500), z.array(z.string().max(500))]).nullable().optional(),
  to: z.string().max(500).nullable().optional(),
});

const listColumnPlacementSchema = z.object({
  key: fieldKeySchema,
  visible: z.boolean(),
  width: z.number().int().min(40).max(800).nullable().optional(),
  labelOverride: z.string().max(120).nullable().optional(),
});

export const listViewConfigSchema = z.object({
  schemaVersion: z.literal(1),
  recordType: recordTypeSchema,
  columns: z.array(listColumnPlacementSchema).max(100),
  filters: z.array(filterClauseSchema).max(50),
  sort: z
    .object({ column: z.string().max(60), dir: z.enum(["asc", "desc"]) })
    .nullable()
    .optional(),
  perPage: z.number().int().min(5).max(100).nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Lint — cross-field invariants a single zod node can't express       */
/* ------------------------------------------------------------------ */

export interface LintIssue {
  path: string
  message: string
}

/**
 * Validate a parsed FormLayoutConfig against the registry: every referenced
 * field must be a known built-in for that record type or a `cf_<key>`; no
 * duplicate keys within a group; locked fields present and visible; required
 * flags only on overridable fields. Custom field existence is checked at the
 * API layer (the def set is per-org + dynamic).
 */
export function lintFormLayout(config: FormLayoutConfig): LintIssue[] {
  const issues: LintIssue[] = []
  const meta = RECORD_TYPE_BY_KEY[config.recordType]
  if (!meta) {
    issues.push({ path: "recordType", message: "unknown record type" })
    return issues
  }

  // Header: every built-in field must appear exactly once across groups.
  const seenHeader = new Set<string>()
  config.header.groups.forEach((g, gi) => {
    const within = new Set<string>()
    g.fields.forEach((f, fi) => {
      const path = `header.groups[${gi}].fields[${fi}]`
      if (within.has(f.key)) issues.push({ path, message: `duplicate field "${f.key}"` })
      within.add(f.key)
      if (seenHeader.has(f.key) && !isCustomFieldKey(f.key))
        issues.push({ path, message: `built-in field "${f.key}" appears in multiple groups` })
      if (isCustomFieldKey(f.key)) {
        seenHeader.add(f.key)
        return
      }
      const fm = meta.headerFields.find((x) => x.key === f.key)
      if (!fm) {
        issues.push({ path, message: `unknown header field "${f.key}"` })
        return
      }
      if (fm.locked && !f.visible)
        issues.push({ path, message: `"${f.key}" is locked and cannot be hidden` })
      if (f.required && !fm.required && !fm.requiredOverridable)
        issues.push({ path, message: `"${f.key}" cannot be marked required` })
      if (f.labelOverride && fm.locked)
        issues.push({ path, message: `"${f.key}" is locked and cannot be renamed` })
      seenHeader.add(f.key)
    })
  })
  // Every locked header field must be present.
  for (const fm of meta.headerFields) {
    if (fm.locked && !seenHeader.has(fm.key))
      issues.push({ path: "header", message: `locked field "${fm.key}" is missing` })
  }

  // Lines: every built-in line field must appear exactly once; locked visible.
  const seenLine = new Set<string>()
  config.lines.columns.forEach((c, ci) => {
    const path = `lines.columns[${ci}]`
    if (seenLine.has(c.key) && !isCustomFieldKey(c.key))
      issues.push({ path, message: `duplicate line column "${c.key}"` })
    if (isCustomFieldKey(c.key)) {
      seenLine.add(c.key)
      return
    }
    const fm = meta.lineFields.find((x) => x.key === c.key)
    if (!fm) {
      issues.push({ path, message: `unknown line column "${c.key}"` })
      return
    }
    if (fm.locked && !c.visible)
      issues.push({ path, message: `"${c.key}" is locked and cannot be hidden` })
    if (c.labelOverride && fm.locked)
      issues.push({ path, message: `"${c.key}" is locked and cannot be renamed` })
    seenLine.add(c.key)
  })
  for (const fm of meta.lineFields) {
    if (fm.locked && !seenLine.has(fm.key))
      issues.push({ path: "lines", message: `locked line column "${fm.key}" is missing` })
  }

  const seenActions = new Set<string>()
  config.actions.forEach((action, ai) => {
    if (seenActions.has(action.key))
      issues.push({ path: `actions[${ai}]`, message: `duplicate action "${action.key}"` })
    seenActions.add(action.key)
  })
  for (const key of FORM_ACTION_KEYS) {
    if (!seenActions.has(key)) issues.push({ path: "actions", message: `action "${key}" is missing` })
  }

  return issues
}

/**
 * Validate a parsed ListViewConfig against the registry: columns and filters
 * reference known built-ins or `cf_<key>`; filter operators are allowed for the
 * field kind; sort column is a known sortable; required values present per
 * operator. Custom-field columns/filters existence is checked at the API layer.
 */
export function lintListView(config: ListViewConfig): LintIssue[] {
  const issues: LintIssue[] = []
  const meta = RECORD_TYPE_BY_KEY[config.recordType]
  if (!meta) {
    issues.push({ path: "recordType", message: "unknown record type" })
    return issues
  }

  // Locked columns must be present.
  const seenCol = new Set<string>()
  config.columns.forEach((c, ci) => {
    const path = `columns[${ci}]`
    if (seenCol.has(c.key) && !isCustomFieldKey(c.key))
      issues.push({ path, message: `duplicate column "${c.key}"` })
    if (isCustomFieldKey(c.key)) {
      seenCol.add(c.key)
      return
    }
    const cm = listColumnMeta(config.recordType, c.key)
    if (!cm) {
      issues.push({ path, message: `unknown column "${c.key}"` })
      return
    }
    if (cm.locked && !c.visible)
      issues.push({ path, message: `"${c.key}" is locked and cannot be hidden` })
    seenCol.add(c.key)
  })
  for (const cm of meta.listColumns) {
    if (cm.locked && !seenCol.has(cm.key))
      issues.push({ path: "columns", message: `locked column "${cm.key}" is missing` })
  }

  // Filters: known key, allowed operator, value presence.
  config.filters.forEach((f, fi) => {
    const path = `filters[${fi}]`
    if (isCustomFieldKey(f.key)) return
    const fm = listFilterMeta(config.recordType, f.key)
    if (!fm) {
      issues.push({ path, message: `unknown filter "${f.key}"` })
      return
    }
    if (!fm.operators.includes(f.operator))
      issues.push({ path, message: `operator "${f.operator}" not allowed for "${f.key}"` })
    const needsValue = !["is_set", "is_not_set"].includes(f.operator)
    if (needsValue) {
      const hasValue =
        (Array.isArray(f.value) ? f.value.length > 0 : f.value != null && f.value !== "") ||
        (f.operator === "between" && f.to != null && f.to !== "")
      if (!hasValue) issues.push({ path, message: `filter "${f.key}" needs a value` })
    }
    if (f.operator === "between" && (f.to == null || f.to === ""))
      issues.push({ path, message: `"between" needs an upper bound (to)` })
    // option-bound filters: value must be a known option.
    if (fm.options && fm.options.length && f.operator !== "is_set" && f.operator !== "is_not_set") {
      const allowed = new Set(fm.options.map((o) => o.value))
      const vals = Array.isArray(f.value) ? f.value : f.value != null ? [String(f.value)] : []
      for (const v of vals) if (!allowed.has(v)) issues.push({ path, message: `"${v}" is not a valid option for "${f.key}"` })
    }
  })

  // Sort column must be a known sortable built-in (custom-field sort is not
  // supported — they live in jsonb and aren't indexed for sort).
  if (config.sort) {
    const cm = listColumnMeta(config.recordType, config.sort.column)
    if (!cm || !cm.sortable || isCustomFieldKey(config.sort.column))
      issues.push({ path: "sort", message: `"${config.sort.column}" is not sortable` })
  }

  return issues
}

/* ------------------------------------------------------------------ */
/* Defaults — the system layout/view (used when no org/user config)    */
/* ------------------------------------------------------------------ */

/** Header col-spans reproduce the existing BillDrawer layout exactly. */
const VENDOR_BILL_HEADER_SPAN: Record<string, number> = {
  party_id: 2,
  memo: 3,
}

/** Per-record-type header col-span defaults so a fresh baseline reads well.
 *  Falls back to VENDOR_BILL_HEADER_SPAN for transaction kinds. */
const HEADER_SPAN_BY_TYPE: Record<string, Record<string, number>> = {
  customer: {
    display_name: 2,
    legal_name: 2,
    website: 2,
    invoicing_preference: 4,
    labor_pricing: 4,
    additional_subsidiaries: 4,
  },
  vendor: {
    display_name: 2,
    legal_name: 2,
    website: 2,
    eft_notification_email: 2,
    additional_subsidiaries: 4,
  },
  employee: {
    display_name: 2,
    legal_name: 2,
    website: 2,
    additional_subsidiaries: 4,
  },
  project: {
    name: 3,
    project_type_id: 2,
    customer_id: 2,
    foreman_id: 2,
    manager_id: 2,
    starts_on: 2,
    ends_on: 2,
    subsidiary_id: 4,
    notes: 4,
  },
}

/**
 * The system-default form layout for a record type — the form as it renders
 * today (before customization). Used when neither the org nor the user has a
 * config: every built-in field present, visible, default labels, in registry
 * order. Custom fields are appended at render time by the web layer (they are
 * dynamic per org).
 */
export function defaultFormLayout(recordType: RecordTypeKey): FormLayoutConfig {
  const meta = RECORD_TYPE_BY_KEY[recordType]
  if (!meta) throw new Error(`unknown record type: ${recordType}`)
  const spanMap = HEADER_SPAN_BY_TYPE[recordType] ?? VENDOR_BILL_HEADER_SPAN
  return {
    schemaVersion: 1,
    defaultVisibilityVersion: 1,
    defaultLayoutVersion: 1,
    recordType,
    header: {
      groups: [
        {
          id: "primary",
          label: null,
          fields: meta.headerFields.map<HeaderFieldPlacement>((f) => ({
            key: f.key,
            visible: true,
            required: f.required ? true : null,
            labelOverride: null,
            colSpan: spanMap[f.key] ?? null,
          })),
        },
      ],
    },
    lines: {
      columns: meta.lineFields.map<LineColumnPlacement>((f) => ({
        key: f.key,
        visible: true,
        width: null,
        labelOverride: null,
      })),
    },
    actions: FORM_ACTION_KEYS.map<FormActionPlacement>((key) => ({ key, visible: true })),
  }
}

/**
 * Bring a persisted form layout forward when the registry gains built-in
 * fields or actions. Existing placements (including hidden fields, custom
 * order, labels, groups, and spans) remain untouched. New header fields are
 * inserted beside their nearest registered predecessor and inherit the
 * system-default placement, so adding a native field never strands saved
 * forms on an obsolete shape.
 */
export function mergeRegisteredFieldsIntoLayout(layout: FormLayoutConfig): FormLayoutConfig {
  const meta = RECORD_TYPE_BY_KEY[layout.recordType]
  if (!meta) return layout

  const defaults = defaultFormLayout(layout.recordType)
  const defaultHeader = new Map(defaults.header.groups.flatMap((group) => group.fields).map((field) => [field.key, field]))
  const placedHeader = new Set(layout.header.groups.flatMap((group) => group.fields).map((field) => field.key))
  if (layout.header.groups.length === 0) layout.header.groups.push({ id: "primary", label: null, fields: [] })

  for (let registryIndex = 0; registryIndex < meta.headerFields.length; registryIndex++) {
    const fieldMeta = meta.headerFields[registryIndex]!
    if (placedHeader.has(fieldMeta.key)) continue

    const placement = defaultHeader.get(fieldMeta.key) ?? {
      key: fieldMeta.key,
      visible: true,
      required: fieldMeta.required ? true : null,
      labelOverride: null,
      colSpan: null,
    }
    let targetGroup = layout.header.groups[0]!
    let insertAt = targetGroup.fields.length

    for (let previousIndex = registryIndex - 1; previousIndex >= 0; previousIndex--) {
      const previousKey = meta.headerFields[previousIndex]!.key
      const group = layout.header.groups.find((candidate) => candidate.fields.some((field) => field.key === previousKey))
      if (!group) continue
      targetGroup = group
      insertAt = group.fields.findIndex((field) => field.key === previousKey) + 1
      break
    }

    targetGroup.fields.splice(insertAt, 0, { ...placement })
    placedHeader.add(fieldMeta.key)
  }

  const placedLines = new Set(layout.lines.columns.map((column) => column.key))
  const defaultLines = new Map(defaults.lines.columns.map((column) => [column.key, column]))
  for (const fieldMeta of meta.lineFields) {
    if (placedLines.has(fieldMeta.key)) continue
    const placement = defaultLines.get(fieldMeta.key) ?? {
      key: fieldMeta.key,
      visible: true,
      width: null,
      labelOverride: null,
    }
    layout.lines.columns.push({ ...placement })
    placedLines.add(fieldMeta.key)
  }

  const placedActions = new Set((layout.actions ?? []).map((action) => action.key))
  layout.actions = [
    ...(layout.actions ?? []),
    ...defaults.actions.filter((action) => !placedActions.has(action.key)),
  ]
  return layout
}

/**
 * Apply the current system placement to a tenant's baseline form exactly once.
 * Built-in fields return to registry order and current spans, while visibility,
 * label, and required overrides survive. Custom fields remain in their chosen
 * groups. Named custom forms never pass through this baseline-only migration.
 */
export function refreshDefaultFormLayout(layout: FormLayoutConfig): FormLayoutConfig {
  const defaults = defaultFormLayout(layout.recordType)
  const defaultBuiltIns = defaults.header.groups.flatMap((group) => group.fields)
  const existingByKey = new Map(
    layout.header.groups.flatMap((group) => group.fields).map((field) => [field.key, field]),
  )
  const customOnlyGroups = layout.header.groups.map((group) => ({
    ...group,
    fields: group.fields.filter((field) => isCustomFieldKey(field.key)),
  }))
  if (customOnlyGroups.length === 0) customOnlyGroups.push({ id: "primary", label: null, fields: [] })

  const builtIns = defaultBuiltIns.map((placement) => {
    const existing = existingByKey.get(placement.key)
    return existing
      ? { ...existing, colSpan: placement.colSpan ?? null }
      : { ...placement }
  })
  customOnlyGroups[0]!.fields = [...builtIns, ...customOnlyGroups[0]!.fields]

  layout.header.groups = customOnlyGroups.filter((group, index) => index === 0 || group.fields.length > 0)
  layout.defaultLayoutVersion = 1
  return mergeRegisteredFieldsIntoLayout(layout)
}

/** The system-default list view: all columns (registry order), no filters. */
export function defaultListView(recordType: RecordTypeKey): ListViewConfig {
  const meta = RECORD_TYPE_BY_KEY[recordType]
  if (!meta) throw new Error(`unknown record type: ${recordType}`)
  // Prefer date-desc (transaction date or created-at) for lists; otherwise the
  // first sortable column.
  const sortable =
    meta.listColumns.find((c) => c.sortable && (c.sortKey === "date" || c.sortKey === "created")) ??
    meta.listColumns.find((c) => c.sortable)
  return {
    schemaVersion: 1,
    recordType,
    columns: meta.listColumns.map<ListColumnPlacement>((c) => ({
      key: c.key,
      visible: !c.defaultHidden,
      width: c.defaultWidth ?? null,
      labelOverride: null,
    })),
    filters: [],
    sort: sortable ? { column: sortable.key, dir: "desc" } : null,
    perPage: DEFAULT_PER_PAGE,
  }
}

/* ------------------------------------------------------------------ */
/* Parse helpers (parse + lint) — the API authoritative path            */
/* ------------------------------------------------------------------ */

export interface ParseResult<T> {
  success: boolean
  data?: T
  issues: LintIssue[]
}

export function parseFormLayout(input: unknown): ParseResult<FormLayoutConfig> {
  const parsed = formLayoutConfigSchema.safeParse(input)
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    }
  }
  const lint = lintFormLayout(parsed.data)
  if (lint.length) return { success: false, issues: lint }
  return { success: true, data: parsed.data, issues: [] }
}

export function parseListView(input: unknown): ParseResult<ListViewConfig> {
  const parsed = listViewConfigSchema.safeParse(input)
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    }
  }
  const lint = lintListView(parsed.data)
  if (lint.length) return { success: false, issues: lint }
  return { success: true, data: parsed.data, issues: [] }
}

/** Is `key` a known built-in field/column/filter for `recordType`? */
export { isBuiltInField, isBuiltInColumn, isBuiltInFilter, isCustomFieldKey, OPERATORS_BY_KIND, type FilterOperator }
