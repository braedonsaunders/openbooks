import "server-only";
import { sql } from "drizzle-orm";
import { db, orgContext, withOrgTransaction } from "@openbooks/engine/platform/db";
import { runTriggerScripts } from "@openbooks/engine/scripting/scripting";
import {
  FixedAssetEquipmentLinkConflict,
  refuseFixedAssetRehomeWithEquipment,
} from "@openbooks/engine/organization/scope";
import {
  createDocumentFromInput,
  deleteDocumentInScope,
  DocumentEditingRefusal,
  editDocument,
  type DocumentEditingContext,
  type DocumentEditingResult,
  type DocumentWriteInput,
} from "@openbooks/engine/ledger/document-editing";
import { resolveDefaultValue, type FieldValueMap, type FormSection } from "@openbooks/forms-core";
import type { SessionUser } from "../auth";
import { ensurePartyRoleRow } from "../party-roles";
import { nextDocumentNumber } from "../bills.ts";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  findUnownedCustomReferences,
  hiddenCustomFieldRefusal,
  loadCustomFieldAccessDefs,
  loadFieldDefs,
  redactHiddenCustomValues,
  validateCustomValues,
  visibleCustomFieldDefs,
  type CustomFieldViewer,
} from "../custom-fields";
import { allowedSubsidiaryIds as loadAllowedSubsidiaryIds } from "../subsidiaries";
import {
  buildSearchText,
  hasSubsidiaryField,
  inTypeAudience,
  loadRecord,
  loadRecordTypeByKey,
  recordVisibleInSubsidiaryFence,
  retainStoredSubsidiaryId,
} from "../records";
import {
  findUnknownDataKeys,
  lintRecordFields,
  recordNumberPrefix,
  stripUnknownData,
  validateRecordData,
  withComputedFormulas,
  type RecordStatus,
} from "../record-schema";
import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import { isFeatureEnabled } from "../features";
import { isDocumentRevisionToken } from "@openbooks/engine/records/revision";
import { auditSetupChange } from "../setup/audit";
import { validateEntityBody } from "./validate";
import { ITEM_EQUIPMENT_KINDS } from "./registry-data";
import {
  ITEM_REVENUE_RECOGNITION_COLUMNS,
  ITEM_TIME_TRACKING_COLUMNS,
  type ApiField,
  type ResolvedApiType,
} from "./schema-registry";
import { isUuid } from "@openbooks/engine/platform/identifiers";

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

const err = (status: number, error: string, extra?: Record<string, unknown>): WriteResult => ({
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
 *  the interactive save path (lock → revision check → validate → compute
 *  formulas → triggers → persist), so API and UI writes are byte-identical.
 *  Data-bearing saves require the caller's read revision (expectedUpdatedAt);
 *  lifecycle-only transitions stay on their status machine. */
async function applyCustomRecord(
  user: SessionUser,
  typeKey: string,
  id: string,
  sections: Extract<ReturnType<typeof lintRecordFields>, { success: true }>["sections"],
  body: { data?: unknown; status?: string; expectedUpdatedAt?: unknown },
  allowedScope?: ReadonlySet<string> | null,
): Promise<WriteResult> {
  if (body.data !== undefined && !isDocumentRevisionToken(body.expectedUpdatedAt)) {
    return err(409, "A current record revision is required; reload the record and try again");
  }
  // The lock, revision compare, mutation, and read-back all share the
  // caller's transaction (updateRecord/createRecord wrap in
  // withOrgTransaction), so a concurrent editor serializes here and the
  // loser compares against the winner's committed revision.
  const locked = (
    await db.execute(
      sql`
    select *, ${documentRevisionCounterSql(sql`revision_seq`)} as revision from custom_records
     where id = ${id} and org_id = ${user.orgId} and type_key = ${typeKey}
     for update`,
      "objects",
    )
  )[0] as (Record<string, unknown> & { revision?: unknown }) | undefined;
  if (!locked) return err(404, "not found");
  const record = {
    id: String(locked.id),
    record_number: String(locked.record_number),
    data: locked.data as FieldValueMap,
    status: locked.status as RecordStatus,
  };
  const allowed = await mutationSubsidiaryScope(user, allowedScope);
  if (!recordVisibleInSubsidiaryFence(sections, record.data, allowed)) return err(404, "not found");
  if (body.data !== undefined && locked.revision !== body.expectedUpdatedAt) {
    return err(
      409,
      "This record changed after you opened it; reload the record and reapply your changes",
    );
  }

  let nextStatus: RecordStatus | undefined;
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "inactive") return err(422, "unknown status");
    const allowed: Record<RecordStatus, RecordStatus[]> = {
      draft: ["active"],
      active: ["inactive"],
      inactive: ["active"],
    };
    if (!allowed[record.status].includes(body.status)) {
      return err(422, `Cannot move a ${record.status} record to ${body.status}`);
    }
    nextStatus = body.status;
  }

  let nextData: FieldValueMap | undefined;
  if (body.data !== undefined) {
    if (record.status === "inactive" && nextStatus !== "active") {
      return err(422, "Reactivate this record before editing it");
    }
    if (typeof body.data !== "object" || body.data === null || Array.isArray(body.data)) {
      return err(422, "data must be an object");
    }
    // Unknown ids are refused BEFORE stripping (same contract as the
    // interactive PATCH route): strip-then-validate drops them with success.
    const unknownFields = findUnknownDataKeys(sections, body.data as FieldValueMap);
    if (unknownFields.length > 0) {
      return err(
        422,
        `Unknown field${unknownFields.length === 1 ? "" : "s"} ${unknownFields.map((f) => `"${f}"`).join(", ")}: remove ${unknownFields.length === 1 ? "it" : "them"} from data or ask the designer to add ${unknownFields.length === 1 ? "the field" : "the fields"} to the record type`,
        { unknownFields },
      );
    }
    nextData = withComputedFormulas(
      sections,
      stripUnknownData(sections, body.data as FieldValueMap),
    );
  }

  const strippedData = nextData ?? stripUnknownData(sections, record.data);
  const persistedData = retainStoredSubsidiaryId(sections, record.data, strippedData);
  if (nextData !== undefined) nextData = persistedData;
  const effectiveData = strippedData;
  const effectiveStatus = nextStatus ?? record.status;
  if (!recordVisibleInSubsidiaryFence(sections, persistedData, allowed))
    return err(404, "not found");
  const stage = effectiveStatus === "active" ? "submit" : "draft";
  const errors = validateRecordData(sections, effectiveData, stage);
  if (errors.length > 0) {
    const msg =
      stage === "submit" && errors.some((e) => e.message === "Required")
        ? "Fill every required field before activating"
        : errors[0]!.message;
    return err(422, msg, { errors });
  }
  // Picker values are uuid-SHAPED at this point but nothing proves the
  // referenced row belongs to the caller: refuse foreign or dangling ids with
  // a tenant-opaque 404 instead of persisting a cross-tenant pointer.
  // Ownership applies to newly supplied references only: the effective bag may
  // carry legacy values written before this fence existed, and an unrelated
  // edit must not lock the record on those.
  if (
    nextData !== undefined &&
    typeof body.data === "object" &&
    body.data !== null &&
    !Array.isArray(body.data)
  ) {
    const supplied: FieldValueMap = {};
    for (const key of Object.keys(body.data as FieldValueMap)) {
      if (nextData[key] !== undefined) supplied[key] = nextData[key];
    }
    const unownedRecordRefs = await findUnownedRecordReferences(user.orgId, sections, supplied);
    if (unownedRecordRefs.length > 0) {
      const field = unownedRecordRefs[0]!;
      return err(404, `${field} not found in this organization`, {
        fieldErrors: [{ field, message: "not found in this organization" }],
      });
    }
  }

  // before_submit user scripts gate the save exactly as they do in the UI.
  const orgRow = await db.execute<{
    id: string;
    name: string;
    base_currency: string;
  }>(sql`select id, name, base_currency from orgs where id = ${user.orgId}`, "objects");
  const org = orgRow[0]!;
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
  if (blocked) return err(422, blocked.abortReason ?? `script "${blocked.name}" ${blocked.status}`);

  const searchText =
    nextData !== undefined
      ? await buildSearchText(user.orgId, sections, nextData, record.record_number)
      : undefined;

  const written = (
    await db.execute<Record<string, unknown>>(
      sql`
    update custom_records set
      data = coalesce(${nextData !== undefined ? JSON.stringify(nextData) : null}::jsonb, data),
      search_text = coalesce(${searchText ?? null}, search_text),
      status = coalesce(${nextStatus ?? null}, status),
      updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${user.id}
    where id = ${id} and org_id = ${user.orgId}
    returning *
  `,
      "objects",
    )
  )[0];
  if (!written) return err(404, "not found");
  // The lock, mutation, and immutable audit event share the caller's
  // transaction (same as the interactive route), so the before-image is the
  // row this write serialized against.
  await auditSetupChange({
    orgId: user.orgId,
    table: "custom_records",
    rowId: id,
    action: "update",
    changes: {
      operation: nextStatus === undefined ? "update" : "lifecycle",
      before: locked,
      after: written,
    },
    actorId: user.id,
  });

  const updated = await loadRecord(user.orgId, typeKey, id);
  return { status: 200, body: { record: updated } };
}

async function createCustomRecordAttempt(
  user: SessionUser,
  typeKey: string,
  body: { data?: unknown; status?: string },
  allowedScope?: ReadonlySet<string> | null,
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
  const allowed = await mutationSubsidiaryScope(user, allowedScope);
  if (allowed !== null && hasSubsidiaryField(sections)) {
    const requested = values.subsidiary_id;
    if (requested === undefined || requested === null || requested === "") {
      const ids = [...allowed];
      if (ids.length !== 1) return err(422, "subsidiaryId is required for this record");
      values.subsidiary_id = ids[0];
    } else if (!allowed.has(String(requested))) {
      return err(403, "forbidden subsidiary");
    }
  }
  const data = withComputedFormulas(sections, values);
  const recordNumber = await nextDocumentNumber(
    user.orgId,
    `custrec:${typeKey}`,
    recordNumberPrefix(typeKey),
  );
  const searchText = await buildSearchText(user.orgId, sections, data, recordNumber);

  const r = await db.execute<{ id: string }>(
    sql`
    insert into custom_records (org_id, type_id, type_key, record_number, data, search_text, created_by, updated_by)
    values (${user.orgId}, ${type.id}, ${typeKey}, ${recordNumber}, ${JSON.stringify(data)}::jsonb,
            ${searchText}, ${user.id}, ${user.id})
    returning id
  `,
    "objects",
  );
  const id = r[0]!.id;

  // If the caller sent data/status, apply it on top of the seeded draft. The
  // seeded row was just inserted by this same command, so no concurrent
  // writer could have touched it: seed the revision evidence from the
  // persisted row instead of demanding a token the creator never read.
  if (body.data !== undefined || body.status !== undefined) {
    const fresh = (
      await db.execute<{ revision: string }>(
        sql`
      select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from custom_records
       where id = ${id} and org_id = ${user.orgId}`,
        "objects",
      )
    )[0];
    const applied = await applyCustomRecord(
      user,
      typeKey,
      id,
      sections,
      { ...body, expectedUpdatedAt: fresh?.revision },
      allowedScope,
    );
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
  allowedScope?: ReadonlySet<string> | null,
): Promise<WriteResult> {
  const run = async (): Promise<WriteResult> => {
    const savepoint = "custom_record_create";
    await db.execute(sql.raw(`savepoint ${savepoint}`));
    try {
      const result = await createCustomRecordAttempt(user, typeKey, body, allowedScope);
      if (result.status >= 400) {
        await db.execute(sql.raw(`rollback to savepoint ${savepoint}`));
        await db.execute(sql.raw(`release savepoint ${savepoint}`));
        return result;
      }
      await db.execute(sql.raw(`release savepoint ${savepoint}`));
      return result;
    } catch (error) {
      await db.execute(sql.raw(`rollback to savepoint ${savepoint}`)).catch(() => undefined);
      await db.execute(sql.raw(`release savepoint ${savepoint}`)).catch(() => undefined);
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
  body: { data?: unknown; status?: string; expectedUpdatedAt?: unknown },
  allowedScope?: ReadonlySet<string> | null,
): Promise<WriteResult> {
  const scope = await loadCustomScope(user, typeKey);
  if (!scope) return err(404, "not found");
  return applyCustomRecord(user, typeKey, id, scope.sections, body, allowedScope);
}

async function deleteCustomRecord(
  user: SessionUser,
  typeKey: string,
  id: string,
  allowedScope?: ReadonlySet<string> | null,
): Promise<WriteResult> {
  const scope = await loadCustomScope(user, typeKey);
  if (!scope) return err(404, "not found");
  // Lock first (same as the interactive route): the before-image below is
  // the row this delete serialized against, and a concurrent writer cannot
  // slip a mutation between the draft check and the erase.
  const locked = (
    await db.execute<Record<string, unknown>>(
      sql`
    select * from custom_records
     where id = ${id} and org_id = ${user.orgId} and type_key = ${typeKey}
     for update`,
      "objects",
    )
  )[0];
  if (!locked) return err(404, "not found");
  const allowed = await mutationSubsidiaryScope(user, allowedScope);
  if (!recordVisibleInSubsidiaryFence(scope.sections, locked.data as FieldValueMap, allowed)) {
    return err(404, "not found");
  }
  if (locked.status !== "draft") {
    return err(422, "Only draft records can be deleted — deactivate instead");
  }
  const deleted = (
    await db.execute<Record<string, unknown>>(
      sql`
    delete from custom_records where id = ${id} and org_id = ${user.orgId}
    returning *`,
      "objects",
    )
  )[0];
  if (!deleted) return err(404, "not found");
  await auditSetupChange({
    orgId: user.orgId,
    table: "custom_records",
    rowId: id,
    action: "delete",
    changes: { operation: "delete", before: deleted, after: null },
    actorId: user.id,
  });
  return { status: 200, body: { ok: true } };
}

async function refuseDisabledItemRevenueRecognition(
  orgId: string,
  table: string,
  columns: Record<string, unknown>,
): Promise<WriteResult | null> {
  if (table !== "items") return null;
  if (!Object.keys(columns).some((col) => ITEM_REVENUE_RECOGNITION_COLUMNS.has(col))) return null;
  if (await isFeatureEnabled(orgId, "revenueRecognition")) return null;
  return err(404, "not found");
}

async function refuseDisabledItemTimeTracking(
  orgId: string,
  table: string,
  columns: Record<string, unknown>,
): Promise<WriteResult | null> {
  if (table !== "items") return null;
  if (!Object.keys(columns).some((col) => ITEM_TIME_TRACKING_COLUMNS.has(col))) return null;
  if (await isFeatureEnabled(orgId, "timeTracking")) return null;
  return err(404, "not found");
}

const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

/**
 * Native reference columns per entity table → owning table. `coerceScalar`
 * proves uuid SHAPE, but composite tenant-coherent FKs refuse a foreign id
 * only as an unhandled storage error (generic 422 leaking SQL text), and
 * single-column FKs (items.recognition_rule_id, projects.project_type_id)
 * are tenant-incoherent: a foreign id passes the constraint and persists as
 * a silent cross-tenant link. Ownership is therefore fenced here, batched
 * per table like the document line-ref precheck. Keys mirror the live FK
 * graph; columns absent from a table's map are not reference columns.
 */
const ENTITY_REFERENCE_TABLES: Record<string, Record<string, string>> = {
  items: {
    income_account_id: "accounts",
    expense_account_id: "accounts",
    deferred_account_id: "accounts",
    cost_recovery_account_id: "accounts",
    tax_code_id: "tax_codes",
    recognition_rule_id: "recognition_rules",
  },
  projects: {
    parent_id: "projects",
    customer_id: "parties",
    foreman_id: "parties",
    manager_id: "parties",
    project_type_id: "project_types",
    subsidiary_id: "subsidiaries",
  },
  parties: {
    subsidiary_id: "subsidiaries",
  },
  fixed_assets: {
    asset_account_id: "accounts",
    accumulated_depreciation_account_id: "accounts",
    depreciation_expense_account_id: "accounts",
    category_id: "asset_categories",
    custodian_party_id: "parties",
    department_id: "departments",
    depreciation_method_id: "depreciation_methods",
    location_id: "locations",
    project_id: "projects",
    source_document_line_id: "document_lines",
    subsidiary_id: "subsidiaries",
  },
};

/** Columns in `columns` whose value is not owned by `orgId` (tenant-opaque callers map to 404). */
async function findUnownedEntityReferences(
  orgId: string,
  table: string,
  columns: Record<string, unknown>,
): Promise<string[]> {
  const refs = ENTITY_REFERENCE_TABLES[table];
  if (!refs) return [];
  const wanted = new Map<string, { column: string; value: string }[]>();
  for (const [column, refTable] of Object.entries(refs)) {
    const raw = columns[column];
    // Null/undefined clears the column (or was already refused as a required
    // clear); only present values need an owner. Shape is proven upstream by
    // coerceScalar's uuid branch.
    if (typeof raw !== "string" || raw.length === 0) continue;
    const list = wanted.get(refTable) ?? [];
    list.push({ column, value: raw });
    wanted.set(refTable, list);
  }
  const unowned: string[] = [];
  for (const [refTable, entries] of wanted) {
    const ids = [...new Set(entries.map((e) => e.value))];
    const owned = new Set(
      (
        await db.execute<{ id: string }>(
          sql`
          select id from ${sql.raw(`"${refTable}"`)}
           where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`,
          "objects",
        )
      ).map((r) => r.id),
    );
    for (const entry of entries) {
      if (!owned.has(entry.value)) unowned.push(entry.column);
    }
  }
  return unowned;
}

function unownedEntityReferenceResult(column: string): WriteResult {
  return err(404, `${column} not found in this organization`, {
    fieldErrors: [{ field: column, message: "not found in this organization" }],
  });
}

/**
 * Record-field pickers (`party` → parties.id, `gl_account` → accounts.id)
 * backed by their native tables. `validateRecordData` proves uuid SHAPE only,
 * so without an ownership check a caller can persist another org's row id (or
 * a dangling uuid) blind into tenant jsonb — the entity and document writers
 * fence the same gap with a batched per-table check and refuse with a
 * tenant-opaque 404. Keys mirror the picker value contract; columns of any
 * other field type are never reference columns.
 */
const RECORD_REFERENCE_TABLES: Record<string, string> = {
  party: "parties",
  gl_account: "accounts",
};

/** Field ids in `data` whose picker value is not owned by `orgId` (callers map to a tenant-opaque 404). */
async function findUnownedRecordReferences(
  orgId: string,
  sections: FormSection[],
  data: FieldValueMap,
): Promise<string[]> {
  const wanted = new Map<string, { field: string; value: string }[]>();
  const collect = (fieldId: string, fieldType: string, raw: unknown) => {
    const refTable = RECORD_REFERENCE_TABLES[fieldType];
    // Empty clears the field; shape-invalid values are refused upstream by
    // validateRecordData — only well-formed present values need an owner.
    if (!refTable || !isUuid(raw)) return;
    const list = wanted.get(refTable) ?? [];
    list.push({ field: fieldId, value: raw });
    wanted.set(refTable, list);
  };
  for (const section of sections) {
    if (section.repeating) {
      const rows = data[section.id];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        for (const field of section.fields) {
          collect(field.id, field.type, (row as FieldValueMap)[field.id]);
        }
      }
      continue;
    }
    for (const field of section.fields) {
      collect(field.id, field.type, data[field.id]);
    }
  }
  const unowned: string[] = [];
  for (const [refTable, entries] of wanted) {
    const ids = [...new Set(entries.map((e) => e.value))];
    const owned = new Set(
      (
        await db.execute<{ id: string }>(
          sql`
          select id from ${sql.raw(`"${refTable}"`)}
           where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`,
          "objects",
        )
      ).map((r) => r.id),
    );
    for (const entry of entries) {
      if (!owned.has(entry.value)) unowned.push(entry.field);
    }
  }
  return unowned;
}

const ENTITY_SUBSIDIARY_TABLES = new Set(["parties", "projects", "fixed_assets"]);

/** An entity row as the viewer may read it: restricted custom values are removed. */
async function viewerEntityRow(
  table: string,
  row: Record<string, unknown>,
  viewer: CustomFieldViewer,
): Promise<Record<string, unknown>> {
  if (!("custom" in row)) return row;
  const defs = await loadCustomFieldAccessDefs(table);
  return {
    ...row,
    custom: redactHiddenCustomValues(defs, viewer, row.custom as Record<string, unknown> | null),
  };
}

/** Keys that name no active definition on this table are refused by name. */
function undefinedCustomField(
  defs: Awaited<ReturnType<typeof loadFieldDefs>>,
  values: Record<string, unknown>,
): WriteResult | null {
  const known = new Set(defs.map((def) => def.key));
  const unknown = Object.keys(values).find((key) => !known.has(key));
  return unknown === undefined ? null : err(403, "forbidden custom field");
}

async function mutationSubsidiaryScope(
  user: SessionUser,
  explicit: ReadonlySet<string> | null | undefined,
): Promise<ReadonlySet<string> | null> {
  return explicit === undefined ? loadAllowedSubsidiaryIds(user.id, user.orgId) : explicit;
}

function subsidiaryInMutationScope(
  allowed: ReadonlySet<string> | null,
  subsidiaryId: string | null | undefined,
): boolean {
  return (
    allowed === null ||
    (subsidiaryId !== null && subsidiaryId !== undefined && allowed.has(String(subsidiaryId)))
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
  const existing = await db.execute<{ kind: string }>(
    sql`
    select kind from items where id = ${itemId} and org_id = ${orgId} limit 1
  `,
    "objects",
  );
  const storedKind = existing[0]?.kind;
  if (storedKind && INVENTORY_ITEM_KINDS.has(storedKind) && nextKind !== storedKind) {
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
  const existing = await db.execute<{ kind: string }>(
    sql`
    select kind from items where id = ${itemId} and org_id = ${orgId} limit 1
  `,
    "objects",
  );
  const storedKind = existing[0]?.kind;
  if (storedKind && ITEM_EQUIPMENT_KINDS.has(storedKind) && nextKind !== storedKind) {
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
  allowedScope: ReadonlySet<string> | null | undefined,
  viewer: CustomFieldViewer,
): Promise<WriteResult> {
  const gated = await refuseDisabledItemFeatureColumns(user.orgId, table, body);
  if (gated) return gated;
  const v = validateEntityBody(fields, body, { stage: "create" });
  if (!v.ok) return err(422, v.errors[0]!.message, { fieldErrors: v.errors });
  const activeDefs = await loadFieldDefs(table);
  const deniedCustom = undefinedCustomField(activeDefs, v.customValues);
  if (deniedCustom) return deniedCustom;
  const hiddenCustom = hiddenCustomFieldRefusal(activeDefs, viewer, v.customValues, null);
  if (hiddenCustom)
    return err(403, hiddenCustom.message, {
      fieldErrors: { [hiddenCustom.key]: hiddenCustom.message },
    });
  const defs = visibleCustomFieldDefs(activeDefs, viewer);
  const cv = validateCustomValues(defs, v.customValues);
  if (!cv.ok) return err(422, Object.values(cv.errors)[0]!, { fieldErrors: cv.errors });
  // Reference custom values are uuid-SHAPED at this point but nothing proves
  // the referenced row belongs to the caller: refuse foreign or dangling ids
  // with a tenant-opaque 404 instead of persisting a cross-tenant pointer.
  const unownedCreateRefs = await findUnownedCustomReferences(user.orgId, defs, cv.cleaned);
  if (unownedCreateRefs.length > 0) {
    const def = unownedCreateRefs[0]!;
    return err(404, `${def.label} not found in this organization`, {
      fieldErrors: { [def.key]: "not found in this organization" },
    });
  }
  // Native reference columns: shape is proven by coerceScalar, ownership here.
  const unownedCreateColumns = await findUnownedEntityReferences(user.orgId, table, v.columns);
  if (unownedCreateColumns.length > 0)
    return unownedEntityReferenceResult(unownedCreateColumns[0]!);
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
    const r = await db.execute(
      sql`
      insert into ${sql.raw(`"${table}"`)} (${colSql}) values (${valSql})
      returning *`,
      "objects",
    );
    const created = r[0] as Record<string, unknown> | undefined;
    if (!created) return err(422, `could not create record: no row returned`);
    // A role-kind parties kind names its role row — the generic
    // record writer has no role inputs, so it backs the claim with the
    // canonical row instead of stranding a Kind no read can observe.
    if (table === "parties") {
      await ensurePartyRoleRow(db, {
        orgId: user.orgId,
        partyId: String(created.id),
        kind: created.kind,
        isActive: created.is_active,
        actorId: user.id,
      });
    }
    await auditSetupChange({
      orgId: user.orgId,
      table,
      rowId: String(created.id),
      action: "insert",
      changes: { after: created },
      actorId: user.id,
    });
    return { status: 201, body: await viewerEntityRow(table, created, viewer) };
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
  allowedScope: ReadonlySet<string> | null | undefined,
  viewer: CustomFieldViewer,
): Promise<WriteResult> {
  const subsidiaryColumn = ENTITY_SUBSIDIARY_TABLES.has(table)
    ? sql`, subsidiary_id as "subsidiaryId"`
    : sql``;
  // The full locked row is the authoritative before-image for the audit
  // event below (same contract as the interactive entity routes).
  const existing = await db.execute(
    sql`
    select *${subsidiaryColumn}
      from ${sql.raw(`"${table}"`)} where id = ${id} and org_id = ${user.orgId}
      for update`,
    "objects",
  );
  if (!existing[0]) return err(404, "not found");

  const allowed = await mutationSubsidiaryScope(user, allowedScope);
  const existingSubsidiary = (existing[0] as { subsidiaryId?: string | null }).subsidiaryId;
  // Subsidiary scope only constrains tables carrying the dimension (parties,
  // projects, fixed assets) — the same contract the platform list/get paths
  // enforce by checking for a subsidiary_id field first. Dimension-less rows
  // (items) are org-wide catalog: gating their undefined subsidiary would
  // 404 every restricted update while create stays open.
  if (
    ENTITY_SUBSIDIARY_TABLES.has(table) &&
    !subsidiaryInMutationScope(allowed, existingSubsidiary)
  )
    return err(404, "not found");

  const gated = await refuseDisabledItemFeatureColumns(user.orgId, table, body, id);
  if (gated) return gated;
  const v = validateEntityBody(fields, body, { stage: "update" });
  if (!v.ok) return err(422, v.errors[0]!.message, { fieldErrors: v.errors });

  if (
    v.columns.subsidiary_id !== undefined &&
    !subsidiaryInMutationScope(allowed, v.columns.subsidiary_id as string | null)
  ) {
    return err(403, "forbidden subsidiary");
  }
  if (table === "fixed_assets" && v.columns.subsidiary_id !== undefined) {
    try {
      await refuseFixedAssetRehomeWithEquipment(
        db,
        user.orgId,
        id,
        existingSubsidiary ?? null,
        v.columns.subsidiary_id as string | null,
      );
    } catch (error) {
      if (error instanceof FixedAssetEquipmentLinkConflict) return err(409, error.message);
      throw error;
    }
  }
  // Native reference columns on the partial patch: shape is proven by
  // coerceScalar, ownership here. v.columns carries supplied keys only, so
  // omitted references are never re-checked.
  const unownedUpdateColumns = await findUnownedEntityReferences(user.orgId, table, v.columns);
  if (unownedUpdateColumns.length > 0)
    return unownedEntityReferenceResult(unownedUpdateColumns[0]!);

  const sets: ReturnType<typeof sql>[] = [];
  for (const [col, value] of Object.entries(v.columns)) {
    sets.push(sql`${sql.raw(`"${col}"`)} = ${value}`);
  }
  if (Object.keys(v.customValues).length > 0) {
    const activeDefs = await loadFieldDefs(table);
    const deniedCustom = undefinedCustomField(activeDefs, v.customValues);
    if (deniedCustom) return deniedCustom;
    const storedCustom = (existing[0].custom as Record<string, unknown> | null) ?? {};
    // A hidden field the caller echoes unchanged passes; any change to it is refused,
    // and its stored value is never overwritten by this update.
    const hiddenCustom = hiddenCustomFieldRefusal(activeDefs, viewer, v.customValues, storedCustom);
    if (hiddenCustom)
      return err(403, hiddenCustom.message, {
        fieldErrors: { [hiddenCustom.key]: hiddenCustom.message },
      });
    const defs = visibleCustomFieldDefs(activeDefs, viewer);
    // PATCH is partial: validate the effective custom bag so omitted required
    // fields are satisfied by their already-persisted values. The supplied
    // keys still win in the merge below, while unknown/hidden legacy keys are
    // preserved exactly as before.
    const cv = validateCustomValues(defs, {
      ...((existing[0].custom as Record<string, unknown>) ?? {}),
      ...v.customValues,
    });
    if (!cv.ok) return err(422, Object.values(cv.errors)[0]!, { fieldErrors: cv.errors });
    // Ownership applies to newly supplied references only: the merged bag may
    // carry legacy values written before this fence existed, and an unrelated
    // edit must not lock the row on those.
    const suppliedCleaned: Record<string, unknown> = {};
    for (const key of Object.keys(v.customValues)) {
      if (cv.cleaned[key] !== undefined) suppliedCleaned[key] = cv.cleaned[key];
    }
    const unownedUpdateRefs = await findUnownedCustomReferences(user.orgId, defs, suppliedCleaned);
    if (unownedUpdateRefs.length > 0) {
      const def = unownedUpdateRefs[0]!;
      return err(404, `${def.label} not found in this organization`, {
        fieldErrors: { [def.key]: "not found in this organization" },
      });
    }
    const merged = {
      ...((existing[0].custom as Record<string, unknown>) ?? {}),
      ...cv.cleaned,
    };
    sets.push(sql`custom = ${JSON.stringify(merged)}::jsonb`);
  }
  if (sets.length === 0) return err(422, "no writable fields supplied");
  sets.push(sql`updated_at = now()`, sql`updated_by = ${user.id}`);

  try {
    const r = await db.execute(
      sql`
      update ${sql.raw(`"${table}"`)} set ${sql.join(sets, sql`, `)}
      where id = ${id} and org_id = ${user.orgId}
      returning *`,
      "objects",
    );
    const written = r[0] as Record<string, unknown> | undefined;
    if (!written) return err(404, "not found");
    // Adopting a role-kind kind on update backs the claim the same
    // way creation does (see above).
    if (table === "parties") {
      await ensurePartyRoleRow(db, {
        orgId: user.orgId,
        partyId: id,
        kind: written.kind,
        isActive: written.is_active,
        actorId: user.id,
      });
    }
    await auditSetupChange({
      orgId: user.orgId,
      table,
      rowId: id,
      action: "update",
      changes: { before: existing[0], after: written },
      actorId: user.id,
    });
    return { status: 200, body: await viewerEntityRow(table, written, viewer) };
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
  const owned = await db.execute(
    sql`
    select *${subsidiaryColumn}
      from ${sql.raw(`"${table}"`)} where id = ${id} and org_id = ${user.orgId}
      for update`,
    "objects",
  );
  if (!owned[0]) return err(404, "not found");
  const allowed = await mutationSubsidiaryScope(user, allowedScope);
  // Subsidiary scope only constrains tables carrying the dimension (parties,
  // projects, fixed assets) — the same contract updateEntity enforces above.
  // Dimension-less rows (items) are org-wide catalog.
  if (
    ENTITY_SUBSIDIARY_TABLES.has(table) &&
    !subsidiaryInMutationScope(allowed, (owned[0] as { subsidiaryId?: string | null }).subsidiaryId)
  ) {
    return err(404, "not found");
  }
  try {
    const erased = (
      await db.execute(
        sql`
      delete from ${sql.raw(`"${table}"`)} where id = ${id} and org_id = ${user.orgId}
      returning *`,
        "objects",
      )
    )[0] as Record<string, unknown> | undefined;
    if (!erased) return err(404, "not found");
    await auditSetupChange({
      orgId: user.orgId,
      table,
      rowId: id,
      action: "delete",
      changes: { before: erased, after: null },
      actorId: user.id,
    });
    return { status: 200, body: { ok: true } };
  } catch (e) {
    // FK references (a party on posted documents, an item on lines, …) block
    // the delete — surface it as a conflict rather than a 500.
    return err(409, `cannot delete — referenced by other records: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Documents (bills, invoices): the engine document editing commands mint the
// draft, write the body through the shared edit core the drawer uses, refuse
// duplicate external references and take the requested lifecycle step. This
// adapter maps their results and refusals to the response.
// ---------------------------------------------------------------------------

export interface RecordWriteOptions {
  source?: "api" | "mcp" | "assistant";
  /** Optional pre-resolved subsidiary scope; omitted callers are resolved from the actor. */
  allowedSubsidiaryIds?: ReadonlySet<string> | null;
  /**
   * The actor's custom-field viewer, derived from live grants by the caller.
   * Omitted callers fail closed to the user's role keys with no manager
   * override, so restricted fields stay hidden.
   */
  customFieldViewer?: CustomFieldViewer;
}

/** Viewer used when a caller supplies none: role keys only, no manager override. */
function fallbackCustomFieldViewer(user: SessionUser): CustomFieldViewer {
  return {
    roleKeys: user.roles.map(({ key }) => key),
    canManageCustomFields: false,
  };
}

function documentEditingContext(
  user: SessionUser,
  options: RecordWriteOptions,
): DocumentEditingContext {
  return {
    orgId: user.orgId,
    userId: user.id,
    source: options.source ?? "api",
    allowedSubsidiaryIds: options.allowedSubsidiaryIds,
    customFieldViewer: options.customFieldViewer ?? fallbackCustomFieldViewer(user),
  };
}

/** The saved document, or the lifecycle outcome alongside it. */
function documentWriteResult(result: DocumentEditingResult, savedStatus: 200 | 201): WriteResult {
  switch (result.outcome) {
    case "saved":
      return { status: savedStatus, body: result.document };
    case "pending_approval":
      return {
        status: 202,
        body: {
          ok: true,
          pendingApproval: true,
          requestId: result.requestId,
          document: result.document,
        },
      };
    case "lifecycle_failed":
      return {
        status: result.refused ? 422 : 500,
        body: { error: result.message, document: result.document },
      };
  }
}

async function documentWrite(run: () => Promise<WriteResult>): Promise<WriteResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DocumentEditingRefusal) {
      return err(error.status, error.message, error.details);
    }
    throw error;
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
        return createCustomRecord(user, resolved.key, body, options.allowedSubsidiaryIds);
      case "entity":
        return createEntity(
          user,
          resolved.writer.table,
          fields,
          body,
          options.allowedSubsidiaryIds,
          options.customFieldViewer ?? fallbackCustomFieldViewer(user),
        );
      case "document": {
        const kind = resolved.writer.docKind;
        return documentWrite(async () =>
          documentWriteResult(
            await createDocumentFromInput(documentEditingContext(user, options), {
              kind,
              body: body as DocumentWriteInput,
            }),
            201,
          ),
        );
      }
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
        return updateCustomRecord(user, resolved.key, id, body, options.allowedSubsidiaryIds);
      case "entity":
        return updateEntity(
          user,
          resolved.writer.table,
          fields,
          id,
          body,
          options.allowedSubsidiaryIds,
          options.customFieldViewer ?? fallbackCustomFieldViewer(user),
        );
      case "document": {
        const kind = resolved.writer.docKind;
        return documentWrite(async () =>
          documentWriteResult(
            await editDocument(documentEditingContext(user, options), {
              kind,
              documentId: id,
              body: body as DocumentWriteInput,
            }),
            200,
          ),
        );
      }
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
        return deleteCustomRecord(user, resolved.key, id, options.allowedSubsidiaryIds);
      case "entity":
        return deleteEntity(user, resolved.writer.table, id, options.allowedSubsidiaryIds);
      case "document": {
        const kind = resolved.writer.docKind;
        return documentWrite(async () => {
          await deleteDocumentInScope(
            {
              orgId: user.orgId,
              userId: user.id,
              allowedSubsidiaryIds: options.allowedSubsidiaryIds,
            },
            { kind, documentId: id },
          );
          return { status: 200, body: { ok: true } };
        });
      }
      case "readonly":
        return err(405, `${resolved.key} is read-only through the API`);
    }
  });
}
