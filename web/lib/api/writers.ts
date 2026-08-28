import "server-only";
import { sql } from "drizzle-orm";
import {
  db,
  orgContext,
  withOrgTransaction,
} from "@openbooks/engine/src/db.ts";
import { runTriggerScripts } from "@openbooks/engine/src/scripting.ts";
import { postDocument, PostingError } from "@openbooks/engine/src/posting.ts";
import { ControlAccountsIncompleteError } from "@openbooks/engine/src/control-accounts.ts";
import { submitAndReleaseIfUngated } from "@openbooks/engine/src/flows/index.ts";
import {
  deleteDocument,
  DeleteError,
} from "@openbooks/engine/src/document-delete.ts";
import { resolveDefaultValue, type FieldValueMap } from "@openbooks/forms-core";
import type { SessionUser } from "../auth";
import { nextDocumentNumber } from "../bills";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { loadFieldDefs, validateCustomValues } from "../custom-fields";
import { allowedSubsidiaryIds as loadAllowedSubsidiaryIds } from "../subsidiaries";
import {
  buildSearchText,
  inTypeAudience,
  loadRecord,
  loadRecordTypeByKey,
} from "../records";
import {
  lintRecordFields,
  recordNumberPrefix,
  stripUnknownData,
  validateRecordData,
  withComputedFormulas,
  type RecordStatus,
} from "../record-schema";
import {
  applyDocumentEdit,
  controlDeps,
  createDocumentDraft,
  documentRevisionSql,
  DocumentEditError,
  isDocKindEnabled,
  loadDocument,
  loadDocumentEditCurrent,
  precomputeDocumentTotalsForCreate,
  type DocumentEditCurrent,
  type DocumentEditInput,
} from "../documents";
import { isFeatureEnabled } from "../features";
import { validateEntityBody } from "./validate";
import { ITEM_EQUIPMENT_KINDS } from "./registry-data";
import {
  ITEM_REVENUE_RECOGNITION_COLUMNS,
  ITEM_TIME_TRACKING_COLUMNS,
  type ApiField,
  type ResolvedApiType,
} from "./schema-registry";

/**
 * The generic write engine behind /api/v1/records. Every writer reuses the
 * SAME domain primitives the interactive UI uses — validators, number
 * sequences, the posting kernel — so an API write can never bypass an invariant
 * the app itself enforces. Routes stay thin: resolve the type, check the
 * permission, hand off to `createRecord` / `updateRecord` / `deleteRecord`.
 */

export interface WriteResult {
  status: number;
  body: unknown;
}

const err = (
  status: number,
  error: string,
  extra?: Record<string, unknown>,
): WriteResult => ({
  status,
  body: { error, ...(extra ?? {}) },
});

// ---------------------------------------------------------------------------
// Custom records (custom_records + FormSection[] definition) — the pure
// metadata-driven path: a new custom record type gets full CRUD for free.
// ---------------------------------------------------------------------------

async function loadCustomScope(user: SessionUser, typeKey: string) {
  const type = await loadRecordTypeByKey(user.orgId, typeKey);
  if (
    !type ||
    type.status !== "published" ||
    !inTypeAudience(
      user.roles.map(({ key }) => key),
      type.allowed_roles,
    )
  )
    return null;
  const lint = lintRecordFields(type.fields, type.name);
  if (!lint.success) return null;
  return { type, sections: lint.sections };
}

/** Apply a `{ data?, status? }` mutation to an existing custom record. Mirrors
 *  the interactive autosave path (validate → compute formulas → triggers →
 *  persist), so API and UI writes are byte-identical. */
async function applyCustomRecord(
  user: SessionUser,
  typeKey: string,
  id: string,
  sections: Extract<
    ReturnType<typeof lintRecordFields>,
    { success: true }
  >["sections"],
  body: { data?: unknown; status?: string },
): Promise<WriteResult> {
  const record = await loadRecord(user.orgId, typeKey, id);
  if (!record) return err(404, "not found");

  let nextStatus: RecordStatus | undefined;
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "inactive")
      return err(422, "unknown status");
    const allowed: Record<RecordStatus, RecordStatus[]> = {
      draft: ["active"],
      active: ["inactive"],
      inactive: ["active"],
    };
    if (!allowed[record.status].includes(body.status)) {
      return err(
        422,
        `Cannot move a ${record.status} record to ${body.status}`,
      );
    }
    nextStatus = body.status;
  }

  let nextData: FieldValueMap | undefined;
  if (body.data !== undefined) {
    if (record.status === "inactive" && nextStatus !== "active") {
      return err(422, "Reactivate this record before editing it");
    }
    if (
      typeof body.data !== "object" ||
      body.data === null ||
      Array.isArray(body.data)
    ) {
      return err(422, "data must be an object");
    }
    nextData = withComputedFormulas(
      sections,
      stripUnknownData(sections, body.data as FieldValueMap),
    );
  }

  const effectiveData = nextData ?? stripUnknownData(sections, record.data);
  const effectiveStatus = nextStatus ?? record.status;
  const stage = effectiveStatus === "active" ? "submit" : "draft";
  const errors = validateRecordData(sections, effectiveData, stage);
  if (errors.length > 0) {
    const msg =
      stage === "submit" && errors.some((e) => e.message === "Required")
        ? "Fill every required field before activating"
        : errors[0]!.message;
    return err(422, msg, { errors });
  }

  // before_submit user scripts gate the save exactly as they do in the UI.
  const orgRow = await db.execute<{
    id: string;
    name: string;
    base_currency: string;
  }>(sql`select id, name, base_currency from orgs where id = ${user.orgId}`);
  const org = orgRow.rows[0]!;
  const outcomes = await runTriggerScripts(
    "before_submit",
    {
      trigger: "before_submit",
      document: {
        kind: `custrec:${typeKey}`,
        id: record.id,
        recordNumber: record.record_number,
        status: effectiveStatus,
        data: effectiveData,
      },
      org: { id: org.id, name: org.name, baseCurrency: org.base_currency },
      user: {
        id: user.id,
        name: user.name,
        roles: user.roles.map(({ key }) => key),
      },
    },
    record.id,
  );
  const blocked = outcomes.find((o) => o.status !== "ok");
  if (blocked)
    return err(
      422,
      blocked.abortReason ?? `script "${blocked.name}" ${blocked.status}`,
    );

  const searchText =
    nextData !== undefined
      ? await buildSearchText(sections, nextData, record.record_number)
      : undefined;

  await db.execute(sql`
    update custom_records set
      data = coalesce(${nextData !== undefined ? JSON.stringify(nextData) : null}::jsonb, data),
      search_text = coalesce(${searchText ?? null}, search_text),
      status = coalesce(${nextStatus ?? null}, status),
      updated_at = now(), updated_by = ${user.id}
    where id = ${id} and org_id = ${user.orgId}
  `);

  const updated = await loadRecord(user.orgId, typeKey, id);
  return { status: 200, body: { record: updated } };
}

async function createCustomRecordAttempt(
  user: SessionUser,
  typeKey: string,
  body: { data?: unknown; status?: string },
): Promise<WriteResult> {
  const scope = await loadCustomScope(user, typeKey);
  if (!scope) return err(404, "not found");
  const { type, sections } = scope;

  // Seed field defaults (today/now/current-user/expression); repeating line
  // lists start empty — same as the interactive draft path.
  const values: FieldValueMap = {};
  const ctx = {
    values,
    rows: {},
    requestContext: {
      now: new Date(),
      today: await businessToday(user.orgId),
      currentUserName: user.name ?? null,
    },
  };
  for (const section of sections) {
    if (section.repeating) {
      values[section.id] = [];
      continue;
    }
    for (const field of section.fields) {
      if (!field.defaultValue) continue;
      const v = resolveDefaultValue(field.defaultValue, ctx);
      if (v !== undefined && v !== null && v !== "") values[field.id] = v;
    }
  }
  const data = withComputedFormulas(sections, values);
  const recordNumber = await nextDocumentNumber(
    user.orgId,
    `custrec:${typeKey}`,
    recordNumberPrefix(typeKey),
  );
  const searchText = await buildSearchText(sections, data, recordNumber);

  const r = await db.execute<{ id: string }>(sql`
    insert into custom_records (org_id, type_id, type_key, record_number, data, search_text, created_by, updated_by)
    values (${user.orgId}, ${type.id}, ${typeKey}, ${recordNumber}, ${JSON.stringify(data)}::jsonb,
            ${searchText}, ${user.id}, ${user.id})
    returning id
  `);
  const id = r.rows[0]!.id;

  // If the caller sent data/status, apply it on top of the seeded draft.
  if (body.data !== undefined || body.status !== undefined) {
    const applied = await applyCustomRecord(user, typeKey, id, sections, body);
    if (applied.status >= 400) return applied;
    return { status: 201, body: applied.body };
  }
  const record = await loadRecord(user.orgId, typeKey, id);
  return { status: 201, body: { record } };
}

/**
 * A rejected create must not leave either its draft row or its number
 * allocation behind. Application commands already run inside
 * `withOrgTransaction`, so a returned 4xx would otherwise commit both writes.
 * A savepoint lets this writer roll back only the attempted create while
 * preserving any caller-owned transaction state. The defensive
 * `withOrgTransaction` wrapper also makes direct callers atomic.
 */
async function createCustomRecord(
  user: SessionUser,
  typeKey: string,
  body: { data?: unknown; status?: string },
): Promise<WriteResult> {
  const run = async (): Promise<WriteResult> => {
    const savepoint = "custom_record_create";
    await db.execute(sql.raw(`savepoint ${savepoint}`));
    try {
      const result = await createCustomRecordAttempt(user, typeKey, body);
      if (result.status >= 400) {
        await db.execute(sql.raw(`rollback to savepoint ${savepoint}`));
        await db.execute(sql.raw(`release savepoint ${savepoint}`));
        return result;
      }
      await db.execute(sql.raw(`release savepoint ${savepoint}`));
      return result;
    } catch (error) {
      await db
        .execute(sql.raw(`rollback to savepoint ${savepoint}`))
        .catch(() => undefined);
      await db
        .execute(sql.raw(`release savepoint ${savepoint}`))
        .catch(() => undefined);
      throw error;
    }
  };

  if (orgContext.getStore()?.txDb) return run();
  return withOrgTransaction(user.orgId, run);
}

async function updateCustomRecord(
  user: SessionUser,
  typeKey: string,
  id: string,
  body: { data?: unknown; status?: string },
): Promise<WriteResult> {
  const scope = await loadCustomScope(user, typeKey);
  if (!scope) return err(404, "not found");
  return applyCustomRecord(user, typeKey, id, scope.sections, body);
}

async function deleteCustomRecord(
  user: SessionUser,
  typeKey: string,
  id: string,
): Promise<WriteResult> {
  const scope = await loadCustomScope(user, typeKey);
  if (!scope) return err(404, "not found");
  const record = await loadRecord(user.orgId, typeKey, id);
  if (!record) return err(404, "not found");
  if (record.status !== "draft") {
    return err(422, "Only draft records can be deleted — deactivate instead");
  }
  await db.execute(
    sql`delete from custom_records where id = ${id} and org_id = ${user.orgId}`,
  );
  return { status: 200, body: { ok: true } };
}

async function refuseDisabledItemRevenueRecognition(
  orgId: string,
  table: string,
  columns: Record<string, unknown>,
): Promise<WriteResult | null> {
  if (table !== "items") return null;
  if (
    !Object.keys(columns).some((col) =>
      ITEM_REVENUE_RECOGNITION_COLUMNS.has(col),
    )
  )
    return null;
  if (await isFeatureEnabled(orgId, "revenueRecognition")) return null;
  return err(404, "not found");
}

async function refuseDisabledItemTimeTracking(
  orgId: string,
  table: string,
  columns: Record<string, unknown>,
): Promise<WriteResult | null> {
  if (table !== "items") return null;
  if (!Object.keys(columns).some((col) => ITEM_TIME_TRACKING_COLUMNS.has(col)))
    return null;
  if (await isFeatureEnabled(orgId, "timeTracking")) return null;
  return err(404, "not found");
}

const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

const ENTITY_SUBSIDIARY_TABLES = new Set([
  "parties",
  "projects",
  "fixed_assets",
]);

function visibleCustomFieldDefs(
  user: SessionUser,
  defs: Awaited<ReturnType<typeof loadFieldDefs>>,
) {
  const roleKeys = user.roles.map(({ key }) => key);
  const unrestricted = user.isSuperAdmin || roleKeys.includes("admin");
  if (unrestricted) return defs;
  return defs.filter((def) => {
    const roles = def.config?.allowedRoles;
    return (
      !Array.isArray(roles) ||
      roles.length === 0 ||
      roles.some((role) => roleKeys.includes(role))
    );
  });
}

function forbiddenCustomField(
  defs: Awaited<ReturnType<typeof loadFieldDefs>>,
  values: Record<string, unknown>,
): WriteResult | null {
  const visible = new Set(defs.map((def) => def.key));
  const denied = Object.keys(values).find((key) => !visible.has(key));
  return denied ? err(403, "forbidden custom field") : null;
}

async function mutationSubsidiaryScope(
  user: SessionUser,
  explicit: ReadonlySet<string> | null | undefined,
): Promise<ReadonlySet<string> | null> {
  return explicit === undefined ? loadAllowedSubsidiaryIds(user.id) : explicit;
}

function subsidiaryInMutationScope(
  allowed: ReadonlySet<string> | null,
  subsidiaryId: string | null | undefined,
): boolean {
  return (
    allowed === null ||
    (subsidiaryId !== null &&
      subsidiaryId !== undefined &&
      allowed.has(String(subsidiaryId)))
  );
}

async function guardEntitySubsidiaryMutation(
  user: SessionUser,
  table: string,
  id: string | undefined,
  requested: string | null | undefined,
  explicitScope: ReadonlySet<string> | null | undefined,
): Promise<WriteResult | null> {
  if (!ENTITY_SUBSIDIARY_TABLES.has(table)) return null;
  const allowed = await mutationSubsidiaryScope(user, explicitScope);
  if (id !== undefined && !subsidiaryInMutationScope(allowed, requested))
    return err(404, "not found");
  if (
    id === undefined &&
    requested !== undefined &&
    requested !== null &&
    !subsidiaryInMutationScope(allowed, requested)
  ) {
    return err(403, "forbidden subsidiary");
  }
  return null;
}

async function refuseDisabledItemInventoryKind(
  orgId: string,
  table: string,
  columns: Record<string, unknown>,
  itemId?: string,
): Promise<WriteResult | null> {
  if (table !== "items" || columns.kind === undefined) return null;
  if (await isFeatureEnabled(orgId, "inventory")) return null;
  const nextKind = String(columns.kind);
  if (INVENTORY_ITEM_KINDS.has(nextKind)) return err(404, "not found");
  if (!itemId) return null;
  const existing = (await db.execute<{ kind: string }>(sql`
    select kind from items where id = ${itemId} and org_id = ${orgId} limit 1
  `)) as { rows: Array<{ kind: string }> };
  const storedKind = existing.rows[0]?.kind;
  if (
    storedKind &&
    INVENTORY_ITEM_KINDS.has(storedKind) &&
    nextKind !== storedKind
  ) {
    return err(404, "not found");
  }
  return null;
}

async function refuseDisabledItemEquipmentKind(
  orgId: string,
  table: string,
  columns: Record<string, unknown>,
  itemId?: string,
): Promise<WriteResult | null> {
  if (table !== "items" || columns.kind === undefined) return null;
  if (await isFeatureEnabled(orgId, "equipment")) return null;
  const nextKind = String(columns.kind);
  if (ITEM_EQUIPMENT_KINDS.has(nextKind)) return err(404, "not found");
  if (!itemId) return null;
  const existing = (await db.execute<{ kind: string }>(sql`
    select kind from items where id = ${itemId} and org_id = ${orgId} limit 1
  `)) as { rows: Array<{ kind: string }> };
  const storedKind = existing.rows[0]?.kind;
  if (
    storedKind &&
    ITEM_EQUIPMENT_KINDS.has(storedKind) &&
    nextKind !== storedKind
  ) {
    return err(404, "not found");
  }
  return null;
}

async function refuseDisabledItemFeatureColumns(
  orgId: string,
  table: string,
  columns: Record<string, unknown>,
  itemId?: string,
): Promise<WriteResult | null> {
  return (
    (await refuseDisabledItemRevenueRecognition(orgId, table, columns)) ??
    (await refuseDisabledItemTimeTracking(orgId, table, columns)) ??
    (await refuseDisabledItemInventoryKind(orgId, table, columns, itemId)) ??
    (await refuseDisabledItemEquipmentKind(orgId, table, columns, itemId))
  );
}

// ---------------------------------------------------------------------------
// Flat entity tables (items, projects, parties, fixed_assets): typed columns +
// a `custom` jsonb bag validated against custom_field_defs.
// ---------------------------------------------------------------------------

async function createEntity(
  user: SessionUser,
  table: string,
  fields: ApiField[],
  body: Record<string, unknown>,
  allowedScope?: ReadonlySet<string> | null,
): Promise<WriteResult> {
  const gated = await refuseDisabledItemFeatureColumns(user.orgId, table, body);
  if (gated) return gated;
  const v = validateEntityBody(fields, body, { stage: "create" });
  if (!v.ok) return err(422, v.errors[0]!.message, { fieldErrors: v.errors });
  const defs = visibleCustomFieldDefs(user, await loadFieldDefs(table));
  const deniedCustom = forbiddenCustomField(defs, v.customValues);
  if (deniedCustom) return deniedCustom;
  const cv = validateCustomValues(defs, v.customValues);
  if (!cv.ok)
    return err(422, Object.values(cv.errors)[0]!, { fieldErrors: cv.errors });
  const subsidiaryGate = await guardEntitySubsidiaryMutation(
    user,
    table,
    undefined,
    v.columns.subsidiary_id as string | null | undefined,
    allowedScope,
  );
  if (subsidiaryGate) return subsidiaryGate;

  const cols: string[] = ["org_id", "created_by", "updated_by"];
  const vals: unknown[] = [user.orgId, user.id, user.id];
  for (const [col, value] of Object.entries(v.columns)) {
    cols.push(col);
    vals.push(value);
  }
  const hasCustom = fields.some((f) => f.name === "custom") || defs.length > 0;
  if (hasCustom) {
    cols.push("custom");
    vals.push(sql`${JSON.stringify(cv.cleaned)}::jsonb`);
  }
  const colSql = sql.join(
    cols.map((c) => sql.raw(`"${c}"`)),
    sql`, `,
  );
  const valSql = sql.join(
    vals.map((val) =>
      val && typeof val === "object" && "queryChunks" in (val as object)
        ? (val as ReturnType<typeof sql>)
        : sql`${val}`,
    ),
    sql`, `,
  );
  try {
    const r = await db.execute(sql`
      insert into ${sql.raw(`"${table}"`)} (${colSql}) values (${valSql})
      returning *`);
    return { status: 201, body: r.rows[0] };
  } catch (e) {
    return err(422, `could not create record: ${(e as Error).message}`);
  }
}

async function updateEntity(
  user: SessionUser,
  table: string,
  fields: ApiField[],
  id: string,
  body: Record<string, unknown>,
  allowedScope?: ReadonlySet<string> | null,
): Promise<WriteResult> {
  const subsidiaryColumn = ENTITY_SUBSIDIARY_TABLES.has(table)
    ? sql`, subsidiary_id as "subsidiaryId"`
    : sql``;
  const existing = await db.execute(sql`
    select custom${subsidiaryColumn}
      from ${sql.raw(`"${table}"`)} where id = ${id} and org_id = ${user.orgId}
      for update`);
  if (!existing.rows[0]) return err(404, "not found");

  const allowed = await mutationSubsidiaryScope(user, allowedScope);
  const existingSubsidiary = (
    existing.rows[0] as { subsidiaryId?: string | null }
  ).subsidiaryId;
  if (!subsidiaryInMutationScope(allowed, existingSubsidiary))
    return err(404, "not found");

  const gated = await refuseDisabledItemFeatureColumns(
    user.orgId,
    table,
    body,
    id,
  );
  if (gated) return gated;
  const v = validateEntityBody(fields, body, { stage: "update" });
  if (!v.ok) return err(422, v.errors[0]!.message, { fieldErrors: v.errors });

  if (
    v.columns.subsidiary_id !== undefined &&
    !subsidiaryInMutationScope(
      allowed,
      v.columns.subsidiary_id as string | null,
    )
  ) {
    return err(403, "forbidden subsidiary");
  }

  const sets: ReturnType<typeof sql>[] = [];
  for (const [col, value] of Object.entries(v.columns)) {
    sets.push(sql`${sql.raw(`"${col}"`)} = ${value}`);
  }
  if (Object.keys(v.customValues).length > 0) {
    const defs = visibleCustomFieldDefs(user, await loadFieldDefs(table));
    const deniedCustom = forbiddenCustomField(defs, v.customValues);
    if (deniedCustom) return deniedCustom;
    const cv = validateCustomValues(defs, v.customValues);
    if (!cv.ok)
      return err(422, Object.values(cv.errors)[0]!, { fieldErrors: cv.errors });
    const merged = {
      ...((existing.rows[0].custom as Record<string, unknown>) ?? {}),
      ...cv.cleaned,
    };
    sets.push(sql`custom = ${JSON.stringify(merged)}::jsonb`);
  }
  if (sets.length === 0) return err(422, "no writable fields supplied");
  sets.push(sql`updated_at = now()`, sql`updated_by = ${user.id}`);

  try {
    const r = await db.execute(sql`
      update ${sql.raw(`"${table}"`)} set ${sql.join(sets, sql`, `)}
      where id = ${id} and org_id = ${user.orgId}
      returning *`);
    return { status: 200, body: r.rows[0] };
  } catch (e) {
    return err(422, `could not update record: ${(e as Error).message}`);
  }
}

async function deleteEntity(
  user: SessionUser,
  table: string,
  id: string,
  allowedScope?: ReadonlySet<string> | null,
): Promise<WriteResult> {
  const subsidiaryColumn = ENTITY_SUBSIDIARY_TABLES.has(table)
    ? sql`, subsidiary_id as "subsidiaryId"`
    : sql``;
  const owned = await db.execute(sql`
    select 1${subsidiaryColumn}
      from ${sql.raw(`"${table}"`)} where id = ${id} and org_id = ${user.orgId}
      for update`);
  if (!owned.rows[0]) return err(404, "not found");
  const allowed = await mutationSubsidiaryScope(user, allowedScope);
  if (
    !subsidiaryInMutationScope(
      allowed,
      (owned.rows[0] as { subsidiaryId?: string | null }).subsidiaryId,
    )
  ) {
    return err(404, "not found");
  }
  try {
    await db.execute(
      sql`delete from ${sql.raw(`"${table}"`)} where id = ${id} and org_id = ${user.orgId}`,
    );
    return { status: 200, body: { ok: true } };
  } catch (e) {
    // FK references (a party on posted documents, an item on lines, …) block
    // the delete — surface it as a conflict rather than a 500.
    return err(
      409,
      `cannot delete — referenced by other records: ${(e as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Documents (bills, invoices): NEVER a raw insert. Mint a draft through the
// document service, then hand the header + lines to the shared
// `applyDocumentEdit` service (the exact write path the drawer uses — custom-
// field validation, GL re-materialization, transaction audit, on_update flows)
// and optionally submit/post through the posting kernel.
// ---------------------------------------------------------------------------

/** The REST body for a document write: the shared edit input plus a lifecycle
 *  action (draft is the default; submit routes for approval; post writes GL). */
type DocApiBody = DocumentEditInput & { action?: "draft" | "submit" | "post" };

export interface RecordWriteOptions {
  source?: "api" | "mcp" | "assistant";
  /** Optional pre-resolved subsidiary scope; omitted callers are resolved from the actor. */
  allowedSubsidiaryIds?: ReadonlySet<string> | null;
}

/** Run the submit/post lifecycle after an edit. Only for not-yet-posted docs
 *  (a posted doc already carries GL). Returns an error result or null on ok. */
async function runDocumentLifecycle(
  user: SessionUser,
  id: string,
  kind: string,
  action: DocApiBody["action"],
  source: "api" | "mcp" | "assistant",
): Promise<WriteResult | null> {
  if (action !== "submit" && action !== "post") return null;
  try {
    const status = await db.execute<{ status: string }>(sql`
      select status from documents
       where id = ${id} and org_id = ${user.orgId}
    `);
    if (status.rows[0]?.status === "draft") {
      const submission = await submitAndReleaseIfUngated(kind, id, user.id);
      if (submission.flowError) {
        return err(
          422,
          `approval could not be routed: ${submission.flowError}`,
        );
      }
      if (submission.gated) {
        return {
          status: 202,
          body: {
            ok: true,
            pendingApproval: true,
            requestId: submission.runId,
            document: await loadDocument(id, user.orgId),
          },
        };
      }
    }
    if (action === "post") {
      const deps = await controlDeps(user.orgId);
      await postDocument(id, deps, {
        audit: { actorId: user.id, source },
      });
    }
    return null;
  } catch (e) {
    // Posting refusals (kernel rules or unconfigured org control accounts) are
    // request-state failures, not server defects.
    const status =
      e instanceof PostingError || e instanceof ControlAccountsIncompleteError
        ? 422
        : 500;
    return {
      status,
      body: {
        error: (e as Error).message,
        document: await loadDocument(id, user.orgId),
      },
    };
  }
}

function docEditError(e: unknown): WriteResult | null {
  if (e instanceof DocumentEditError) {
    return err(
      e.status,
      e.message,
      e.fieldErrors ? { fieldErrors: e.fieldErrors } : undefined,
    );
  }
  return null;
}

async function createDocument(
  user: SessionUser,
  docKind: string,
  body: DocApiBody,
  source: "api" | "mcp" | "assistant",
  allowedScope?: ReadonlySet<string> | null,
): Promise<WriteResult> {
  if (!(await isDocKindEnabled(user.orgId, docKind)))
    return err(404, "not found");
  if (body.subsidiaryId !== undefined && body.subsidiaryId !== null) {
    const allowed = await mutationSubsidiaryScope(user, allowedScope);
    if (!subsidiaryInMutationScope(allowed, body.subsidiaryId))
      return err(403, "forbidden subsidiary");
  }
  if (
    body.currency !== undefined &&
    !(await isFeatureEnabled(user.orgId, "multiCurrency"))
  ) {
    return err(404, "not found");
  }
  let precomputedTotals;
  try {
    precomputedTotals = await precomputeDocumentTotalsForCreate(
      user.orgId,
      docKind,
      body,
    );
  } catch (e) {
    const mapped = docEditError(e);
    if (mapped) return mapped;
    throw e;
  }
  const draft = await createDocumentDraft(user.orgId, user.id, docKind, {
    source,
  });
  const draftId = draft!.id;
  // on_create flows run before createDocumentDraft returns and may mutate the
  // row. Initialize from the settled persisted snapshot, including its exact
  // revision, instead of treating creation as a tokenless update.
  const current = await loadDocumentEditCurrent(draftId, user.orgId);
  if (!current)
    throw new Error(
      `draft document ${draftId} disappeared during initialization`,
    );
  try {
    await applyDocumentEdit(
      draftId,
      current,
      { ...body, expectedUpdatedAt: current.updatedAt },
      { orgId: user.orgId, userId: user.id, source, precomputedTotals },
    );
  } catch (e) {
    const mapped = docEditError(e);
    if (mapped) return mapped;
    throw e;
  }
  const life = await runDocumentLifecycle(
    user,
    draftId,
    docKind,
    body.action,
    source,
  );
  if (life) return life;
  return { status: 201, body: await loadDocument(draftId, user.orgId) };
}

async function updateDocument(
  user: SessionUser,
  docKind: string,
  id: string,
  body: DocApiBody,
  source: "api" | "mcp" | "assistant",
  allowedScope?: ReadonlySet<string> | null,
): Promise<WriteResult> {
  const owned = await db.execute<DocumentEditCurrent>(sql`
    select kind, status, total, tax_total as "taxTotal", party_id as "partyId",
           document_date as "documentDate",
           subsidiary_id as "subsidiaryId",
           ${documentRevisionSql(sql.raw("updated_at"))} as "updatedAt"
      from documents where id = ${id} and org_id = ${user.orgId} and kind = ${docKind}
      for update`);
  const row = owned.rows[0];
  if (!row) return err(404, "not found");
  const allowed = await mutationSubsidiaryScope(user, allowedScope);
  if (
    !subsidiaryInMutationScope(
      allowed,
      (row as DocumentEditCurrent & { subsidiaryId?: string | null })
        .subsidiaryId,
    )
  ) {
    return err(404, "not found");
  }
  if (
    body.subsidiaryId !== undefined &&
    body.subsidiaryId !== null &&
    !subsidiaryInMutationScope(allowed, body.subsidiaryId)
  ) {
    return err(403, "forbidden subsidiary");
  }
  if (!(await isDocKindEnabled(user.orgId, docKind)))
    return err(404, "not found");
  if (
    body.currency !== undefined &&
    !(await isFeatureEnabled(user.orgId, "multiCurrency"))
  ) {
    return err(404, "not found");
  }
  if (row.status === "voided")
    return err(422, "a voided document cannot be edited");
  try {
    await applyDocumentEdit(id, row, body, {
      orgId: user.orgId,
      userId: user.id,
      source,
    });
  } catch (e) {
    const mapped = docEditError(e);
    if (mapped) return mapped;
    throw e;
  }
  // Posted docs already have GL; only advance the lifecycle for pre-post edits.
  const life =
    row.status === "posted"
      ? null
      : await runDocumentLifecycle(user, id, docKind, body.action, source);
  if (life) return life;
  return { status: 200, body: await loadDocument(id, user.orgId) };
}

async function deleteDocumentWriter(
  user: SessionUser,
  docKind: string,
  id: string,
  allowedScope?: ReadonlySet<string> | null,
): Promise<WriteResult> {
  const owned = await db.execute(sql`
    select subsidiary_id as "subsidiaryId"
      from documents where id = ${id} and org_id = ${user.orgId} and kind = ${docKind}
      for update`);
  if (!owned.rows[0]) return err(404, "not found");
  const allowed = await mutationSubsidiaryScope(user, allowedScope);
  if (
    !subsidiaryInMutationScope(
      allowed,
      (owned.rows[0] as { subsidiaryId?: string | null }).subsidiaryId,
    )
  ) {
    return err(404, "not found");
  }
  if (!(await isDocKindEnabled(user.orgId, docKind)))
    return err(404, "not found");
  try {
    await deleteDocument(id, user.id, user.orgId);
    return { status: 200, body: { ok: true } };
  } catch (e) {
    if (e instanceof DeleteError) return err(422, (e as Error).message);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function createRecord(
  user: SessionUser,
  resolved: ResolvedApiType,
  fields: ApiField[],
  body: Record<string, unknown>,
  options: RecordWriteOptions = {},
): Promise<WriteResult> {
  if (resolved.writer.kind === "readonly") {
    return err(405, `${resolved.key} is read-only through the API`);
  }
  return withOrgTransaction(user.orgId, async () => {
    switch (resolved.writer.kind) {
      case "custom_record":
        return createCustomRecord(user, resolved.key, body);
      case "entity":
        return createEntity(
          user,
          resolved.writer.table,
          fields,
          body,
          options.allowedSubsidiaryIds,
        );
      case "document":
        return createDocument(
          user,
          resolved.writer.docKind,
          body as DocApiBody,
          options.source ?? "api",
          options.allowedSubsidiaryIds,
        );
      case "readonly":
        return err(405, `${resolved.key} is read-only through the API`);
    }
  });
}

export async function updateRecord(
  user: SessionUser,
  resolved: ResolvedApiType,
  fields: ApiField[],
  id: string,
  body: Record<string, unknown>,
  options: RecordWriteOptions = {},
): Promise<WriteResult> {
  if (resolved.writer.kind === "readonly") {
    return err(405, `${resolved.key} is read-only through the API`);
  }
  return withOrgTransaction(user.orgId, async () => {
    switch (resolved.writer.kind) {
      case "custom_record":
        return updateCustomRecord(user, resolved.key, id, body);
      case "entity":
        return updateEntity(
          user,
          resolved.writer.table,
          fields,
          id,
          body,
          options.allowedSubsidiaryIds,
        );
      case "document":
        return updateDocument(
          user,
          resolved.writer.docKind,
          id,
          body as DocApiBody,
          options.source ?? "api",
          options.allowedSubsidiaryIds,
        );
      case "readonly":
        return err(405, `${resolved.key} is read-only through the API`);
    }
  });
}

export async function deleteRecord(
  user: SessionUser,
  resolved: ResolvedApiType,
  id: string,
  options: RecordWriteOptions = {},
): Promise<WriteResult> {
  if (resolved.writer.kind === "readonly") {
    return err(405, `${resolved.key} is read-only through the API`);
  }
  return withOrgTransaction(user.orgId, async () => {
    switch (resolved.writer.kind) {
      case "custom_record":
        return deleteCustomRecord(user, resolved.key, id);
      case "entity":
        return deleteEntity(
          user,
          resolved.writer.table,
          id,
          options.allowedSubsidiaryIds,
        );
      case "document":
        return deleteDocumentWriter(
          user,
          resolved.writer.docKind,
          id,
          options.allowedSubsidiaryIds,
        );
      case "readonly":
        return err(405, `${resolved.key} is read-only through the API`);
    }
  });
}
