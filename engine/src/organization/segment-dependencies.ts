import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { orgFeatureEnabled } from "./org-feature-lock.ts";

export * from "./segment-dependency-rules.ts";
import {
  describeViolation,
  SEGMENT_DEPENDENCIES_FEATURE,
  segmentDependencyViolations,
  type DimensionAssignment,
  type SegmentDependencyRule,
} from "./segment-dependency-rules.ts";

/**
 * Segment value dependency enforcement against the database: loading the
 * effective rules, the document save check, and the open-document report.
 */

interface RuleRow extends Record<string, unknown> {
  id: string;
  segment_id: string;
  segment_key: string;
  segment_name: string;
  segment_kind: "builtin" | "custom";
  segment_storage: string | null;
  value_id: string;
  controlling_id: string;
  controlling_key: string;
  controlling_name: string;
  controlling_kind: "builtin" | "custom";
  controlling_storage: string | null;
  allowed_value_id: string;
  effective_from: string | null;
  effective_to: string | null;
}

/** Display labels for segment values: custom values and built-in domain rows alike. */
async function labelValues(
  executor: SqlExecutor,
  orgId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await executor.execute<{ id: string; label: string }>(
    sql`
    select id::text, concat_ws(' · ', code, name) as label from segment_values where org_id = ${orgId} and id::text in ${ids}
    union all select id::text, concat_ws(' · ', code, name) from departments where org_id = ${orgId} and id::text in ${ids}
    union all select id::text, concat_ws(' · ', code, name) from classes where org_id = ${orgId} and id::text in ${ids}
    union all select id::text, concat_ws(' · ', code, name) from locations where org_id = ${orgId} and id::text in ${ids}
    union all select id::text, concat_ws(' · ', code, name) from projects where org_id = ${orgId} and id::text in ${ids}
    union all select id::text, name from subsidiaries where org_id = ${orgId} and id::text in ${ids}`,
    "objects",
  );
  return new Map(rows.map((row) => [row.id, row.label]));
}

/**
 * Active rules, optionally only those effective on a date. Returns no rules
 * while the Segment dependencies feature is off (rules are kept, not
 * enforced). `ignoreFeature` serves setup screens that manage rules
 * regardless of enforcement.
 */
export async function loadSegmentDependencyRules(
  executor: SqlExecutor,
  orgId: string,
  options: { onDate?: string | null; ignoreFeature?: boolean } = {},
): Promise<SegmentDependencyRule[]> {
  const rows = await executor.execute<RuleRow>(
    sql`
    select r.id, r.value_id::text as value_id, r.allowed_value_id::text as allowed_value_id,
           r.effective_from::text as effective_from, r.effective_to::text as effective_to,
           sd.id as segment_id, sd.key as segment_key, sd.name as segment_name,
           sd.source_kind as segment_kind, sd.storage_column as segment_storage,
           cd.id as controlling_id, cd.key as controlling_key, cd.name as controlling_name,
           cd.source_kind as controlling_kind, cd.storage_column as controlling_storage
      from segment_value_dependencies r
      join segment_definitions sd on sd.org_id = r.org_id and sd.id = r.segment_id and sd.is_active
      join segment_definitions cd on cd.org_id = r.org_id and cd.id = r.controlling_segment_id and cd.is_active
     where r.org_id = ${orgId} and r.is_active
       ${
         options.onDate
           ? sql`and (r.effective_from is null or r.effective_from <= ${options.onDate})
                             and (r.effective_to is null or r.effective_to >= ${options.onDate})`
           : sql``
       }
     order by sd.sort_order, sd.name, r.value_id, cd.sort_order, r.id`,
    "objects",
  );
  if (rows.length === 0) return [];
  if (
    !options.ignoreFeature &&
    !(await orgFeatureEnabled(orgId, SEGMENT_DEPENDENCIES_FEATURE, executor))
  )
    return [];
  const labels = await labelValues(executor, orgId, [
    ...new Set(rows.flatMap((row) => [row.value_id, row.allowed_value_id])),
  ]);
  return rows.map((row) => ({
    id: row.id,
    segment: {
      id: row.segment_id,
      key: row.segment_key,
      name: row.segment_name,
      sourceKind: row.segment_kind,
      storageColumn: row.segment_storage,
    },
    valueId: row.value_id,
    valueLabel: labels.get(row.value_id) ?? row.value_id,
    controlling: {
      id: row.controlling_id,
      key: row.controlling_key,
      name: row.controlling_name,
      sourceKind: row.controlling_kind,
      storageColumn: row.controlling_storage,
    },
    allowedValueId: row.allowed_value_id,
    allowedLabel: labels.get(row.allowed_value_id) ?? row.allowed_value_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  }));
}

export class SegmentDependencyError extends Error {
  readonly name = "SegmentDependencyError";
  readonly status = 422;
  readonly code = "segment_dependency";
  readonly remedy =
    "Choose an allowed combination of segment values on the line, or change the dependency rule under Setup → Segments.";
  readonly details: { violations: { line: string; ruleId: string }[] };
  constructor(message: string, violations: { line: string; ruleId: string }[]) {
    super(message);
    this.details = { violations };
  }
}

/** Refuse when any labelled line breaks an effective rule on the date. */
export function assertNoSegmentDependencyViolations(
  rules: readonly SegmentDependencyRule[],
  lines: readonly { label: string; dims: DimensionAssignment }[],
  onDate: string,
): void {
  const found: { line: string; ruleId: string; message: string }[] = [];
  for (const line of lines) {
    for (const violation of segmentDependencyViolations(rules, line.dims, onDate)) {
      found.push({
        line: line.label,
        ruleId: violation.ruleId,
        message: describeViolation(violation, line.label),
      });
    }
  }
  if (found.length === 0) return;
  const more =
    found.length > 1
      ? ` (${found.length - 1} more line${found.length > 2 ? "s" : ""} break segment dependency rules)`
      : "";
  throw new SegmentDependencyError(
    `${found[0]!.message}${more}`,
    found.map(({ line, ruleId }) => ({ line, ruleId })),
  );
}

interface DocumentLineDims extends Record<string, unknown> {
  line_number: number;
  subsidiary_id: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  class_id: string | null;
  extra_dims: Record<string, unknown> | null;
}

/** A saved document's lines with header dimensions inherited, as the kernel will post them. */
async function documentLineDims(
  executor: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<{ date: string | null; lines: DocumentLineDims[] }> {
  const header = (
    await executor.execute<{ document_date: string }>(
      sql`
    select document_date::text as document_date from documents where org_id = ${orgId} and id = ${documentId}`,
      "objects",
    )
  )[0];
  if (!header) return { date: null, lines: [] };
  const lines = await executor.execute<DocumentLineDims>(
    sql`
    select l.line_number,
           coalesce(l.subsidiary_id, d.subsidiary_id) as subsidiary_id,
           coalesce(l.department_id, d.department_id) as department_id,
           coalesce(l.project_id, d.project_id) as project_id,
           coalesce(l.location_id, d.location_id) as location_id,
           coalesce(l.class_id, d.class_id) as class_id,
           coalesce(d.extra_dims, '{}'::jsonb) || coalesce(l.extra_dims, '{}'::jsonb) as extra_dims
      from document_lines l
      join documents d on d.org_id = l.org_id and d.id = l.document_id
     where l.org_id = ${orgId} and l.document_id = ${documentId}
     order by l.line_number`,
    "objects",
  );
  return { date: header.document_date, lines };
}

/**
 * Save-time check for a document inside its write transaction: reads the
 * saved lines (header defaults inherited) and refuses the save when any line
 * breaks a rule effective on the document date.
 */
export async function assertDocumentSegmentDependencies(
  executor: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<void> {
  const rules = await loadSegmentDependencyRules(executor, orgId);
  if (rules.length === 0) return;
  const { date, lines } = await documentLineDims(executor, orgId, documentId);
  if (!date) return;
  assertNoSegmentDependencyViolations(
    rules,
    lines.map((line) => ({
      label: `Line ${line.line_number}`,
      dims: {
        subsidiaryId: line.subsidiary_id,
        departmentId: line.department_id,
        projectId: line.project_id,
        locationId: line.location_id,
        classId: line.class_id,
        extraDims: line.extra_dims,
      },
    })),
    date,
  );
}

export interface OpenDocumentViolation {
  documentId: string;
  kind: string;
  documentNumber: string;
  documentDate: string;
  status: string;
  lineNumber: number;
  message: string;
}

/**
 * Unposted documents (draft, awaiting approval, approved) whose lines break
 * a rule effective on their document date — the work list after a rule is
 * added. Posted documents are history and never listed.
 */
export async function openDocumentSegmentViolations(
  executor: SqlExecutor,
  orgId: string,
  options: { limit: number; offset: number; allowedSubsidiaryIds?: ReadonlySet<string> | null } = {
    limit: 100,
    offset: 0,
  },
): Promise<{ rows: OpenDocumentViolation[]; total: number; scanned: number }> {
  const rules = await loadSegmentDependencyRules(executor, orgId);
  if (rules.length === 0) return { rows: [], total: 0, scanned: 0 };
  const governed = new Set(rules.map((rule) => rule.valueId));
  const scope = options.allowedSubsidiaryIds
    ? options.allowedSubsidiaryIds.size > 0
      ? sql`and d.subsidiary_id in ${[...options.allowedSubsidiaryIds]}`
      : sql`and false`
    : sql``;
  const candidates = await executor.execute<
    DocumentLineDims & {
      document_id: string;
      kind: string;
      document_number: string;
      document_date: string;
      status: string;
    }
  >(
    sql`
    select d.id as document_id, d.kind, d.document_number, d.document_date::text as document_date, d.status,
           l.line_number,
           coalesce(l.subsidiary_id, d.subsidiary_id) as subsidiary_id,
           coalesce(l.department_id, d.department_id) as department_id,
           coalesce(l.project_id, d.project_id) as project_id,
           coalesce(l.location_id, d.location_id) as location_id,
           coalesce(l.class_id, d.class_id) as class_id,
           coalesce(d.extra_dims, '{}'::jsonb) || coalesce(l.extra_dims, '{}'::jsonb) as extra_dims
      from documents d
      join document_lines l on l.org_id = d.org_id and l.document_id = d.id
     where d.org_id = ${orgId} and d.status in ('draft', 'pending_approval', 'approved') ${scope}
     order by d.document_date, d.document_number, d.id, l.line_number`,
    "objects",
  );
  const all: OpenDocumentViolation[] = [];
  for (const row of candidates) {
    const dims: DimensionAssignment = {
      subsidiaryId: row.subsidiary_id,
      departmentId: row.department_id,
      projectId: row.project_id,
      locationId: row.location_id,
      classId: row.class_id,
      extraDims: row.extra_dims,
    };
    const carried = [
      dims.subsidiaryId,
      dims.departmentId,
      dims.projectId,
      dims.locationId,
      dims.classId,
      ...Object.values(dims.extraDims ?? {}),
    ];
    if (!carried.some((value) => typeof value === "string" && governed.has(value))) continue;
    for (const violation of segmentDependencyViolations(rules, dims, row.document_date)) {
      all.push({
        documentId: row.document_id,
        kind: row.kind,
        documentNumber: row.document_number,
        documentDate: row.document_date,
        status: row.status,
        lineNumber: row.line_number,
        message: describeViolation(violation, `Line ${row.line_number}`),
      });
    }
  }
  return {
    rows: all.slice(options.offset, options.offset + options.limit),
    total: all.length,
    scanned: candidates.length,
  };
}
