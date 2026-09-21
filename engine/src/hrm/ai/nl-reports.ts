import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { AiRailsError, nlDefinitionRefused } from "./errors.ts";
import { logDecision } from "./governance.ts";

/**
 * HRM AI rails (HR-21) natural-language reports. The model produces a
 * REPORT DEFINITION in the report engine's own schema (ReportCustomQuery:
 * entity, mode, columns, breakouts, measures, filters, sorts, limit) —
 * never SQL. This service VALIDATES the definition strictly against the
 * caller's visible catalog snapshot (built in the web layer from
 * REPORT_ENTITY_MAP filtered by the caller's report permissions) and
 * refuses invalid definitions BY NAME — never repaired silently, because
 * the shared sanitizer (validateCustomQuery) drops what it does not
 * understand, and silent drops answer a different question than asked.
 */

const AGG_FNS = ["count", "count_distinct", "sum", "avg", "min", "max", "latest"] as const;
const FILTER_OPS = [
  "eq", "neq", "in", "not_in", "gte", "lte",
  "is_null", "is_not_null", "is_true", "is_false", "contains",
] as const;
const TEMPORAL_BINS = [
  "day", "week", "month", "quarter", "year",
  "fiscal_period", "fiscal_quarter", "fiscal_year",
] as const;

/** Caller-visible catalog snapshot: entity key, its column keys, its gate. */
export interface NlCatalogEntity {
  readonly key: string;
  readonly columns: readonly string[];
  /** Permission beyond reports.read the entity needs, if any. */
  readonly requiredPermission?: string | null;
}

export interface NlValidatedDefinition {
  readonly entity: string;
  readonly mode: "rows" | "summarize";
  readonly columns: string[];
  readonly breakouts: { column: string; bin?: string }[];
  readonly measures: { fn: string; column?: string; label?: string }[];
  readonly filters: unknown;
  readonly sorts: { column: string; direction: "asc" | "desc" }[];
  readonly limit: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countRules(group: unknown): number {
  if (!isRecord(group) || !Array.isArray(group.rules)) return 0;
  let n = 0;
  for (const r of group.rules) n += isRecord(r) && Array.isArray(r.rules) ? countRules(r) : 1;
  return n;
}

function validateFilters(
  entityKey: string,
  columns: ReadonlySet<string>,
  filters: unknown,
  depth: number,
): unknown {
  if (filters === null || filters === undefined) return null;
  if (!isRecord(filters)) throw nlDefinitionRefused("filters must be a rule group object or null");
  if (depth > 5) throw nlDefinitionRefused("filters nest deeper than 5 levels");
  if (filters.combinator !== "and" && filters.combinator !== "or") {
    throw nlDefinitionRefused(`filters combinator must be "and" or "or", got ${JSON.stringify(filters.combinator)}`);
  }
  if (!Array.isArray(filters.rules)) throw nlDefinitionRefused("filters.rules must be an array");
  if (countRules(filters) > 60) throw nlDefinitionRefused("filters carry more than 60 rules");
  const rules: unknown[] = [];
  for (const rule of filters.rules) {
    if (isRecord(rule) && Array.isArray(rule.rules)) {
      rules.push(validateFilters(entityKey, columns, rule, depth + 1));
      continue;
    }
    if (!isRecord(rule)) throw nlDefinitionRefused("every filter rule must be an object");
    const field = rule.field;
    if (typeof field !== "string" || !columns.has(field)) {
      throw nlDefinitionRefused(
        `filter field ${JSON.stringify(field)} is not a column of entity "${entityKey}"`,
      );
    }
    if (typeof rule.op !== "string" || !(FILTER_OPS as readonly string[]).includes(rule.op)) {
      throw nlDefinitionRefused(`filter operator ${JSON.stringify(rule.op)} on "${field}" is unknown`);
    }
    rules.push({ field, op: rule.op, ...(rule.value !== undefined ? { value: rule.value } : {}) });
  }
  return {
    combinator: filters.combinator,
    ...(typeof filters.not === "boolean" ? { not: filters.not } : {}),
    rules,
  };
}

/**
 * Strict validation: every name must resolve, or the definition is
 * refused naming the first bad name. Returns the saved-view-compatible
 * normalized definition.
 */
export function validateNlDefinition(
  raw: unknown,
  catalog: readonly NlCatalogEntity[],
  callerPermissions: readonly string[],
): NlValidatedDefinition {
  if (!isRecord(raw)) throw nlDefinitionRefused("definition must be an object");
  const allowedTop = new Set([
    "entity", "mode", "columns", "breakouts", "measures",
    "filters", "sorts", "limit", "groupBy",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedTop.has(key)) throw nlDefinitionRefused(`unknown definition key "${key}"`);
  }
  const entityKey = raw.entity;
  if (typeof entityKey !== "string" || entityKey.length === 0) {
    throw nlDefinitionRefused("definition needs an entity key");
  }
  const entity = catalog.find((e) => e.key === entityKey);
  if (!entity) {
    const visible = catalog.map((e) => e.key).join(", ");
    throw nlDefinitionRefused(
      `unknown report entity "${entityKey}" — visible to you: ${visible || "(none)"}`,
    );
  }
  if (entity.requiredPermission && !callerPermissions.includes(entity.requiredPermission)) {
    throw nlDefinitionRefused(
      `report entity "${entityKey}" needs ${entity.requiredPermission} — ask an administrator for access`,
    );
  }
  const columns = new Set(entity.columns);
  const mode = raw.mode === undefined || raw.mode === null ? "rows" : raw.mode;
  if (mode !== "rows" && mode !== "summarize") {
    throw nlDefinitionRefused(`mode must be "rows" or "summarize", got ${JSON.stringify(raw.mode)}`);
  }
  if (!Array.isArray(raw.columns)) throw nlDefinitionRefused("columns must be an array of entity column keys");
  const outColumns: string[] = [];
  for (const c of raw.columns) {
    if (typeof c !== "string" || !columns.has(c)) {
      throw nlDefinitionRefused(`column ${JSON.stringify(c)} is not a column of entity "${entityKey}"`);
    }
    if (!outColumns.includes(c)) outColumns.push(c);
  }
  if (mode === "rows" && outColumns.length === 0) {
    throw nlDefinitionRefused("rows mode needs at least one column");
  }
  const breakouts: { column: string; bin?: string }[] = [];
  if (raw.breakouts !== undefined && raw.breakouts !== null) {
    if (!Array.isArray(raw.breakouts)) throw nlDefinitionRefused("breakouts must be an array");
    if (raw.breakouts.length > 6) throw nlDefinitionRefused("breakouts carry more than 6 dimensions");
    for (const b of raw.breakouts) {
      if (!isRecord(b) || typeof b.column !== "string" || !columns.has(b.column)) {
        throw nlDefinitionRefused(
          `breakout ${JSON.stringify(isRecord(b) ? b.column : b)} is not a column of entity "${entityKey}"`,
        );
      }
      const bin = b.bin === undefined || b.bin === null ? undefined : b.bin;
      if (bin !== undefined && (typeof bin !== "string" || !(TEMPORAL_BINS as readonly string[]).includes(bin))) {
        throw nlDefinitionRefused(`breakout bin ${JSON.stringify(b.bin)} on "${b.column}" is unknown`);
      }
      breakouts.push(bin === undefined ? { column: b.column } : { column: b.column, bin });
    }
  }
  const measures: { fn: string; column?: string; label?: string }[] = [];
  if (raw.measures !== undefined && raw.measures !== null) {
    if (!Array.isArray(raw.measures)) throw nlDefinitionRefused("measures must be an array");
    if (raw.measures.length > 8) throw nlDefinitionRefused("measures carry more than 8 aggregates");
    for (const m of raw.measures) {
      if (!isRecord(m) || typeof m.fn !== "string" || !(AGG_FNS as readonly string[]).includes(m.fn)) {
        throw nlDefinitionRefused(
          `measure fn ${JSON.stringify(isRecord(m) ? m.fn : m)} is unknown (count, sum, avg, min, max, count_distinct, latest)`,
        );
      }
      if (m.fn !== "count") {
        if (typeof m.column !== "string" || !columns.has(m.column)) {
          throw nlDefinitionRefused(
            `measure column ${JSON.stringify(m.column)} is not a column of entity "${entityKey}"`,
          );
        }
      }
      measures.push({
        fn: m.fn,
        ...(m.fn === "count" ? {} : { column: m.column as string }),
        ...(typeof m.label === "string" && m.label.trim() ? { label: m.label.trim().slice(0, 80) } : {}),
      });
    }
  }
  const sorts: { column: string; direction: "asc" | "desc" }[] = [];
  if (raw.sorts !== undefined && raw.sorts !== null) {
    if (!Array.isArray(raw.sorts)) throw nlDefinitionRefused("sorts must be an array");
    if (raw.sorts.length > 3) throw nlDefinitionRefused("sorts carry more than 3 levels");
    for (const s of raw.sorts) {
      if (!isRecord(s) || typeof s.column !== "string" || !columns.has(s.column)) {
        throw nlDefinitionRefused(
          `sort column ${JSON.stringify(isRecord(s) ? s.column : s)} is not a column of entity "${entityKey}"`,
        );
      }
      if (s.direction !== "asc" && s.direction !== "desc") {
        throw nlDefinitionRefused(`sort direction on "${s.column}" must be "asc" or "desc"`);
      }
      sorts.push({ column: s.column, direction: s.direction });
    }
  }
  let limit: number | null = null;
  if (raw.limit !== undefined && raw.limit !== null) {
    if (!Number.isInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > 10000) {
      throw nlDefinitionRefused("limit must be an integer from 1 to 10000");
    }
    limit = raw.limit as number;
  }
  const filters = validateFilters(entityKey, columns, raw.filters ?? null, 0);
  return { entity: entityKey, mode, columns: outColumns, breakouts, measures, filters, sorts, limit };
}

async function assertNlFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, "hrmNlReports"))) {
    throw new AiRailsError(
      "ai_feature_off",
      "natural-language reports are unavailable while hrmNlReports is off — enable it under Company Settings → Features",
    );
  }
}

export interface NlDraftInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly question: string;
  /** Candidate definition from the model, validated strictly here. */
  readonly candidate: unknown;
  readonly catalog: readonly NlCatalogEntity[];
  readonly callerPermissions: readonly string[];
}

/**
 * Validate the candidate, persist the draft row, and log the decision.
 * The preview run happens in the web layer through the report runner
 * under the caller's gates — the service never executes SQL itself.
 */
export async function saveNlDraft(
  exec: SqlExecutor,
  input: NlDraftInput,
): Promise<{ draftId: string; definition: NlValidatedDefinition }> {
  const { orgId, actorId, question } = input;
  if (!orgId || !actorId) throw new AiRailsError("ai_invalid_input", "orgId and actorId are required");
  if (!question || question.trim().length === 0) {
    throw new AiRailsError("ai_invalid_input", "ask a question first — an empty question has no report");
  }
  await assertNlFeature(exec, orgId);
  const definition = validateNlDefinition(input.candidate, input.catalog, input.callerPermissions);
  const rows = (await exec.execute<{ id: string }>(sql`
    insert into nl_report_drafts (org_id, user_id, question, definition, status)
    values (${orgId}::uuid, ${actorId}::uuid, ${question}, ${JSON.stringify(definition)}::jsonb, 'drafted')
    returning id::text as id`)).rows;
  const draft = rows[0];
  if (!draft) {
    throw new AiRailsError(
      "ai_draft_not_saved",
      "the report draft was not saved — nothing was stored; reload and retry",
    );
  }
  await logDecision(exec, {
    orgId,
    actorId,
    capabilityKey: "hrmNlReports",
    subjectKind: "nl_report_draft",
    subjectId: draft.id,
    input: question,
    output: `entity=${definition.entity} mode=${definition.mode}`,
    outputSummary: `report draft from question (${definition.entity}, ${definition.mode})`,
    sources: [{ kind: "report_entity", id: definition.entity }],
    outcome: "shown",
    model: "nl-reports-service",
  });
  return { draftId: draft.id, definition };
}

/** Public boundary: validate and save the draft. One transaction. */
export async function draftNlReport(query: NlDraftInput): Promise<{ draftId: string; definition: NlValidatedDefinition }> {
  return withOrgTransaction(query.orgId, () => saveNlDraft(db, query));
}
