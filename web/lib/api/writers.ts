import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { runTriggerScripts } from "@openbooks/engine/src/scripting.ts";
import { postDocument, PostingError } from "@openbooks/engine/src/posting.ts";
import { submitForApproval } from "@openbooks/engine/src/approvals.ts";
import { deleteDocument, DeleteError } from "@openbooks/engine/src/document-delete.ts";
import { resolveDefaultValue, type FieldValueMap } from "@openbooks/forms-core";
import type { SessionUser } from "../auth";
import { nextDocumentNumber } from "../bills";
import { loadFieldDefs, validateCustomValues } from "../custom-fields";
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
  DocumentEditError,
  loadDocument,
  DOC_KINDS,
  type DocumentEditCurrent,
  type DocumentEditInput,
} from "../documents";
import { validateEntityBody } from "./validate";
import type { ApiField, ResolvedApiType } from "./schema-registry";

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
  if (!type || type.status !== "published" || !inTypeAudience(user.role, type.allowed_roles)) return null;
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
  sections: Extract<ReturnType<typeof lintRecordFields>, { success: true }>["sections"],
  body: { data?: unknown; status?: string },
): Promise<WriteResult> {
  const record = await loadRecord(user.orgId, typeKey, id);
  if (!record) return err(404, "not found");

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
    nextData = withComputedFormulas(sections, stripUnknownData(sections, body.data as FieldValueMap));
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
  const orgRow = (await db.execute(
    sql`select id, name, base_currency from orgs where id = ${user.orgId}`,
  )) as unknown as { rows: { id: string; name: string; base_currency: string }[] };
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
      user: { id: user.id, name: user.name, role: user.role },
    },
    record.id,
  );
  const blocked = outcomes.find((o) => o.status !== "ok");
  if (blocked) return err(422, blocked.abortReason ?? `script "${blocked.name}" ${blocked.status}`);

  const searchText =
    nextData !== undefined ? await buildSearchText(sections, nextData, record.record_number) : undefined;

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

async function createCustomRecord(
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
  const ctx = { values, rows: {}, requestContext: { now: new Date(), currentUserName: user.name ?? null } };
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
  const recordNumber = await nextDocumentNumber(user.orgId, `custrec:${typeKey}`, recordNumberPrefix(typeKey));
  const searchText = await buildSearchText(sections, data, recordNumber);

  const r = (await db.execute(sql`
    insert into custom_records (org_id, type_id, type_key, record_number, data, search_text, created_by, updated_by)
    values (${user.orgId}, ${type.id}, ${typeKey}, ${recordNumber}, ${JSON.stringify(data)}::jsonb,
            ${searchText}, ${user.id}, ${user.id})
    returning id
  `)) as unknown as { rows: { id: string }[] };
  const id = r.rows[0]!.id;

  // If the caller sent data/status, apply it on top of the seeded draft.
  if (body.data !== undefined || body.status !== undefined) {
    const applied = await applyCustomRecord(user, typeKey, id, sections, body);
    if (applied.status >= 400) return applied; // draft row remains; caller sees the validation error
    return { status: 201, body: applied.body };
  }
  const record = await loadRecord(user.orgId, typeKey, id);
  return { status: 201, body: { record } };
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

async function deleteCustomRecord(user: SessionUser, typeKey: string, id: string): Promise<WriteResult> {
  const scope = await loadCustomScope(user, typeKey);
  if (!scope) return err(404, "not found");
  const record = await loadRecord(user.orgId, typeKey, id);
  if (!record) return err(404, "not found");
  if (record.status !== "draft") {
    return err(422, "Only draft records can be deleted — deactivate instead");
  }
  await db.execute(sql`delete from custom_records where id = ${id} and org_id = ${user.orgId}`);
  return { status: 200, body: { ok: true } };
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
): Promise<WriteResult> {
  const v = validateEntityBody(fields, body, { stage: "create" });
  if (!v.ok) return err(422, v.errors[0]!.message, { fieldErrors: v.errors });
  const defs = await loadFieldDefs(table);
  const cv = validateCustomValues(defs, v.customValues);
  if (!cv.ok) return err(422, Object.values(cv.errors)[0]!, { fieldErrors: cv.errors });

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
  const colSql = sql.join(cols.map((c) => sql.raw(`"${c}"`)), sql`, `);
  const valSql = sql.join(
    vals.map((val) => (val && typeof val === "object" && "queryChunks" in (val as object) ? (val as ReturnType<typeof sql>) : sql`${val}`)),
    sql`, `,
  );
  try {
    const r = (await db.execute(sql`
      insert into ${sql.raw(`"${table}"`)} (${colSql}) values (${valSql})
      returning *`)) as any;
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
): Promise<WriteResult> {
  const existing = (await db.execute(sql`
    select custom from ${sql.raw(`"${table}"`)} where id = ${id} and org_id = ${user.orgId} limit 1`)) as any;
  if (!existing.rows[0]) return err(404, "not found");

  const v = validateEntityBody(fields, body, { stage: "update" });
  if (!v.ok) return err(422, v.errors[0]!.message, { fieldErrors: v.errors });

  const sets: ReturnType<typeof sql>[] = [];
  for (const [col, value] of Object.entries(v.columns)) {
    sets.push(sql`${sql.raw(`"${col}"`)} = ${value}`);
  }
  if (Object.keys(v.customValues).length > 0) {
    const defs = await loadFieldDefs(table);
    const cv = validateCustomValues(defs, v.customValues);
    if (!cv.ok) return err(422, Object.values(cv.errors)[0]!, { fieldErrors: cv.errors });
    const merged = { ...((existing.rows[0].custom as Record<string, unknown>) ?? {}), ...cv.cleaned };
    sets.push(sql`custom = ${JSON.stringify(merged)}::jsonb`);
  }
  if (sets.length === 0) return err(422, "no writable fields supplied");
  sets.push(sql`updated_at = now()`, sql`updated_by = ${user.id}`);

  try {
    const r = (await db.execute(sql`
      update ${sql.raw(`"${table}"`)} set ${sql.join(sets, sql`, `)}
      where id = ${id} and org_id = ${user.orgId}
      returning *`)) as any;
    return { status: 200, body: r.rows[0] };
  } catch (e) {
    return err(422, `could not update record: ${(e as Error).message}`);
  }
}

async function deleteEntity(user: SessionUser, table: string, id: string): Promise<WriteResult> {
  const owned = (await db.execute(sql`
    select 1 from ${sql.raw(`"${table}"`)} where id = ${id} and org_id = ${user.orgId} limit 1`)) as any;
  if (!owned.rows[0]) return err(404, "not found");
  try {
    await db.execute(sql`delete from ${sql.raw(`"${table}"`)} where id = ${id} and org_id = ${user.orgId}`);
    return { status: 200, body: { ok: true } };
  } catch (e) {
    // FK references (a party on posted documents, an item on lines, …) block
    // the delete — surface it as a conflict rather than a 500.
    return err(409, `cannot delete — referenced by other records: ${(e as Error).message}`);
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

/** Run the submit/post lifecycle after an edit. Only for not-yet-posted docs
 *  (a posted doc already carries GL). Returns an error result or null on ok. */
async function runDocumentLifecycle(
  user: SessionUser,
  id: string,
  kind: string,
  action: DocApiBody["action"],
): Promise<WriteResult | null> {
  if (action !== "submit" && action !== "post") return null;
  const cfg = DOC_KINDS[kind]!;
  try {
    if (action === "submit") {
      await submitForApproval(kind, id).catch(async (e) => {
        // No policy seeded: only direct-post kinds and credit memos may skip
        // straight to approved (mirrors the documents/actions route).
        if (!(e as Error).message.includes("no active approval policy")) throw e;
        if (!(cfg.directPost || kind === "vendor_credit" || kind === "customer_credit")) throw e;
        await db.execute(sql`update documents set status = 'approved', updated_by = ${user.id} where id = ${id}`);
      });
    } else {
      const deps = await controlDeps(user.orgId);
      await postDocument(id, deps);
    }
    return null;
  } catch (e) {
    const status = e instanceof PostingError ? 422 : 500;
    return { status, body: { error: (e as Error).message, document: await loadDocument(id, user.orgId) } };
  }
}

function docEditError(e: unknown): WriteResult | null {
  if (e instanceof DocumentEditError) {
    return err(e.status, e.message, e.fieldErrors ? { fieldErrors: e.fieldErrors } : undefined);
  }
  return null;
}

async function createDocument(user: SessionUser, docKind: string, body: DocApiBody): Promise<WriteResult> {
  const draft = await createDocumentDraft(user.orgId, user.id, docKind);
  const current: DocumentEditCurrent = { kind: docKind, status: "draft", total: "0", taxTotal: "0", partyId: null };
  try {
    await applyDocumentEdit(draft.id, current, body, { orgId: user.orgId, userId: user.id, source: "api" });
  } catch (e) {
    const mapped = docEditError(e);
    if (mapped) return mapped;
    throw e;
  }
  const life = await runDocumentLifecycle(user, draft.id, docKind, body.action);
  if (life) return life;
  return { status: 201, body: await loadDocument(draft.id, user.orgId) };
}

async function updateDocument(user: SessionUser, docKind: string, id: string, body: DocApiBody): Promise<WriteResult> {
  const owned = (await db.execute(sql`
    select kind, status, total, tax_total as "taxTotal", party_id as "partyId"
      from documents where id = ${id} and org_id = ${user.orgId} and kind = ${docKind}`)) as unknown as { rows: DocumentEditCurrent[] };
  const row = owned.rows[0];
  if (!row) return err(404, "not found");
  if (row.status === "voided") return err(422, "a voided document cannot be edited");
  try {
    await applyDocumentEdit(id, row, body, { orgId: user.orgId, userId: user.id, source: "api" });
  } catch (e) {
    const mapped = docEditError(e);
    if (mapped) return mapped;
    throw e;
  }
  // Posted docs already have GL; only advance the lifecycle for pre-post edits.
  const life = row.status === "posted" ? null : await runDocumentLifecycle(user, id, docKind, body.action);
  if (life) return life;
  return { status: 200, body: await loadDocument(id, user.orgId) };
}

async function deleteDocumentWriter(user: SessionUser, docKind: string, id: string): Promise<WriteResult> {
  const owned = (await db.execute(sql`
    select 1 from documents where id = ${id} and org_id = ${user.orgId} and kind = ${docKind}`)) as any;
  if (!owned.rows[0]) return err(404, "not found");
  try {
    await deleteDocument(id, user.id);
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
): Promise<WriteResult> {
  switch (resolved.writer.kind) {
    case "custom_record":
      return createCustomRecord(user, resolved.key, body);
    case "entity":
      return createEntity(user, resolved.writer.table, fields, body);
    case "document":
      return createDocument(user, resolved.writer.docKind, body as DocApiBody);
    case "readonly":
      return err(405, `${resolved.key} is read-only through the API`);
  }
}

export async function updateRecord(
  user: SessionUser,
  resolved: ResolvedApiType,
  fields: ApiField[],
  id: string,
  body: Record<string, unknown>,
): Promise<WriteResult> {
  switch (resolved.writer.kind) {
    case "custom_record":
      return updateCustomRecord(user, resolved.key, id, body);
    case "entity":
      return updateEntity(user, resolved.writer.table, fields, id, body);
    case "document":
      return updateDocument(user, resolved.writer.docKind, id, body as DocApiBody);
    case "readonly":
      return err(405, `${resolved.key} is read-only through the API`);
  }
}

export async function deleteRecord(
  user: SessionUser,
  resolved: ResolvedApiType,
  id: string,
): Promise<WriteResult> {
  switch (resolved.writer.kind) {
    case "custom_record":
      return deleteCustomRecord(user, resolved.key, id);
    case "entity":
      return deleteEntity(user, resolved.writer.table, id);
    case "document":
      return deleteDocumentWriter(user, resolved.writer.docKind, id);
    case "readonly":
      return err(405, `${resolved.key} is read-only through the API`);
  }
}
