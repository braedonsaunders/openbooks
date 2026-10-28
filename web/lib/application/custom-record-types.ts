import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { documentRevisionSql, isDocumentRevisionToken } from "@openbooks/engine/records/revision";
import type { FormSection } from "@openbooks/forms-core";
import { isUuid } from "../list-params";
import { pgTextArrayLiteral } from "../pg-array";
import { hasSubsidiaryField, loadRecordTypeById, subsidiaryDeclaredTypeIds } from "../records";
import { auditSetupChange } from "../setup/audit";
import {
  describeIssue,
  lintRecordFields,
  recordTypeLintBody,
  slugifyTypeKey,
  typeKeyError,
} from "../record-schema";
import { claimIdempotentCreate, resolveIdempotentReplay } from "../api/idempotency";
import { assertApplicationPermission, type ApplicationContext } from "./context";

export type RecordTypeActionResult = { status: number; body: Record<string, unknown> };

type TypeBody = Record<string, unknown>;
const ICON_KEY_RE = /^[a-z0-9-]{1,32}$/;
const TYPE_REVISION_SQL = documentRevisionSql(sql`updated_at`);
const TYPE_REVISION_CONFLICT = {
  error: "This record type changed after you opened it; reload the type and try again",
  code: "revision_conflict",
} as const;

function response(status: number, body: Record<string, unknown>): RecordTypeActionResult {
  return { status, body };
}

function typeDeclaresSubsidiary(fields: unknown, name: string): boolean {
  const lint = lintRecordFields(fields, name);
  return lint.success && hasSubsidiaryField(lint.sections);
}

export async function listCustomRecordTypeDefinitions(
  context: ApplicationContext,
): Promise<Record<string, unknown>[]> {
  assertApplicationPermission(context, "records.manage_types");
  const fence = context.authz.allowedSubsidiaryIds;
  const scopedTypeIds =
    fence === null
      ? null
      : subsidiaryDeclaredTypeIds(
          await db.execute<{ id: string; name: string; fields: unknown }>(
            sql`select id, name, fields from custom_record_types where org_id = ${context.authz.user.orgId}`,
            "objects",
          ),
        );
  const countScope =
    fence === null || scopedTypeIds === null
      ? sql``
      : sql`and (
          cr.data ->> ${"subsidiary_id"} = any(${pgTextArrayLiteral([...fence])}::text[])
          or (
            not (t.id = any(${`{${scopedTypeIds.join(",")}}`}::uuid[]))
            and cr.data ->> ${"subsidiary_id"} is null
          )
        )`;
  return db.execute(
    sql`
      select t.id, t.key, t.name, t.plural_name, t.icon_key, t.description, t.fields,
             t.status, t.show_in_nav, t.allowed_roles, t.sort_order, t.updated_at,
             (select count(*) from custom_records cr where cr.type_id = t.id ${countScope}) as record_count
        from custom_record_types t
       where t.org_id = ${context.authz.user.orgId}
       order by t.sort_order, t.name
    `,
    "objects",
  );
}

export async function getCustomRecordTypeDefinition(
  context: ApplicationContext,
  id: string,
): Promise<RecordTypeActionResult> {
  assertApplicationPermission(context, "records.manage_types");
  if (!isUuid(id)) return response(404, { error: "record not found" });
  const type = await loadRecordTypeById(context.authz.user.orgId, id);
  return type ? response(200, { type }) : response(404, { error: "record not found" });
}

export async function createCustomRecordType(
  context: ApplicationContext,
  body: TypeBody,
  requestId: string,
): Promise<RecordTypeActionResult> {
  assertApplicationPermission(context, "records.manage_types");
  const { user } = context.authz;
  if (!isUuid(requestId)) return response(400, { error: "invalid_idempotency_key" });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 200) return response(422, { error: "Name must be 1–200 characters" });
  const pluralName = body.pluralName === undefined ? `${name}s` : String(body.pluralName).trim();
  if (!pluralName || pluralName.length > 200) {
    return response(422, { error: "Plural name must be 1–200 characters" });
  }
  const iconKey = typeof body.iconKey === "string" ? body.iconKey : "grid";
  if (!ICON_KEY_RE.test(iconKey)) return response(422, { error: "Invalid icon key" });
  const description = typeof body.description === "string" ? body.description.trim() || null : null;
  if (description !== null && description.length > 2000) {
    return response(422, { error: "Description must be at most 2,000 characters" });
  }
  const allowedRoles = (body.allowedRoles ?? null) as string[] | null;
  if (
    allowedRoles !== null &&
    (!Array.isArray(allowedRoles) ||
      allowedRoles.length > 50 ||
      allowedRoles.some(
        (role) => typeof role !== "string" || role.length === 0 || role.length > 100,
      ))
  ) {
    return response(422, { error: "Invalid allowed roles" });
  }
  const sortOrder = typeof body.sortOrder === "number" ? body.sortOrder : 0;
  if (!Number.isInteger(sortOrder) || Math.abs(sortOrder) > 100_000) {
    return response(422, { error: "Invalid sort order" });
  }
  if (body.showInNav !== undefined && typeof body.showInNav !== "boolean") {
    return response(422, { error: "Invalid show in nav flag" });
  }
  const showInNav = body.showInNav === true;
  const lint = lintRecordFields(body.fields ?? [], name);
  if (!lint.success) return response(422, recordTypeLintBody(lint.issues));

  let key: string;
  if (typeof body.key === "string") {
    const keyIssue = typeKeyError(body.key);
    if (keyIssue) return response(422, { error: keyIssue });
    const clash = await db.execute(
      sql`select 1 from custom_record_types where org_id = ${user.orgId} and key = ${body.key} and id <> ${requestId}`,
      "objects",
    );
    if (clash.length > 0) {
      return response(409, { error: `A record type with key "${body.key}" already exists` });
    }
    key = body.key;
  } else {
    const base = slugifyTypeKey(name) || "new-record-type";
    const taken = new Set(
      (
        await db.execute<{ key: string }>(
          sql`select key from custom_record_types where org_id = ${user.orgId} and id <> ${requestId} and (key = ${base} or key like ${base + "-%"})`,
          "objects",
        )
      ).map((row) => row.key),
    );
    key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
    const derivedIssue = typeKeyError(key);
    if (derivedIssue) return response(422, { error: derivedIssue });
  }
  const snapshot = {
    id: requestId,
    org_id: user.orgId,
    key,
    name,
    plural_name: pluralName,
    icon_key: iconKey,
    description,
    fields: lint.sections,
    show_in_nav: showInNav,
    allowed_roles: allowedRoles,
    sort_order: sortOrder,
  };
  const match = {
    key,
    name,
    plural_name: pluralName,
    icon_key: iconKey,
    description,
    fields: lint.sections,
    show_in_nav: showInNav,
    allowed_roles: allowedRoles,
    sort_order: sortOrder,
  };
  const outcome = await db.transaction(async (tx) => {
    const claim = await claimIdempotentCreate(tx, {
      orgId: user.orgId,
      table: "custom_record_types",
      key: requestId,
    });
    if (claim === "exists") {
      return resolveIdempotentReplay(tx, {
        orgId: user.orgId,
        table: "custom_record_types",
        key: requestId,
        match,
      });
    }
    const inserted = await tx.execute<{ id: string }>(
      sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, icon_key, description, fields,
           status, show_in_nav, allowed_roles, sort_order, created_by, updated_by)
        values (${requestId}, ${user.orgId}, ${key}, ${name}, ${pluralName}, ${iconKey}, ${description},
                ${JSON.stringify(lint.sections)}::jsonb, 'draft', ${showInNav},
                ${allowedRoles ? JSON.stringify(allowedRoles) : null}::jsonb, ${sortOrder}, ${user.id}, ${user.id})
        -- The duplicate key is accepted only after the matching request payload is verified below.
        on conflict (id) do nothing returning id
      `,
      "objects",
    );
    if (!inserted[0]) {
      return resolveIdempotentReplay(tx, {
        orgId: user.orgId,
        table: "custom_record_types",
        key: requestId,
        match,
      });
    }
    await auditSetupChange(
      {
        orgId: user.orgId,
        table: "custom_record_types",
        rowId: requestId,
        action: "insert",
        changes: { before: null, after: snapshot },
        actorId: user.id,
        requestId,
      },
      tx,
    );
    return "fresh" as const;
  });
  if (outcome === "conflict") return response(409, { error: "invalid_idempotency_key" });
  return response(outcome === "fresh" ? 201 : 200, { id: requestId });
}

export async function updateCustomRecordType(
  context: ApplicationContext,
  id: string,
  body: TypeBody,
): Promise<RecordTypeActionResult> {
  assertApplicationPermission(context, "records.manage_types");
  const { user } = context.authz;
  if (!isUuid(id)) return response(404, { error: "record not found" });
  const type = await loadRecordTypeById(user.orgId, id);
  if (!type) return response(404, { error: "record not found" });
  if (
    body.name !== undefined &&
    (typeof body.name !== "string" || !body.name.trim() || body.name.length > 200)
  ) {
    return response(422, { error: "Name must be 1–200 characters" });
  }
  if (
    body.pluralName !== undefined &&
    (typeof body.pluralName !== "string" || !body.pluralName.trim() || body.pluralName.length > 200)
  ) {
    return response(422, { error: "Plural name must be 1–200 characters" });
  }
  if (
    body.iconKey !== undefined &&
    (typeof body.iconKey !== "string" || !ICON_KEY_RE.test(body.iconKey))
  ) {
    return response(422, { error: "Invalid icon key" });
  }
  if (
    body.description !== undefined &&
    body.description !== null &&
    (typeof body.description !== "string" || body.description.length > 2000)
  ) {
    return response(422, { error: "Description must be at most 2,000 characters" });
  }
  const allowedRoles = body.allowedRoles as string[] | null | undefined;
  if (
    allowedRoles !== undefined &&
    allowedRoles !== null &&
    (!Array.isArray(allowedRoles) ||
      allowedRoles.length > 50 ||
      allowedRoles.some(
        (role) => typeof role !== "string" || role.length === 0 || role.length > 100,
      ))
  ) {
    return response(422, { error: "Invalid allowed roles" });
  }
  if (
    body.sortOrder !== undefined &&
    (typeof body.sortOrder !== "number" ||
      !Number.isInteger(body.sortOrder) ||
      Math.abs(body.sortOrder) > 100_000)
  ) {
    return response(422, { error: "Invalid sort order" });
  }
  if (body.showInNav !== undefined && typeof body.showInNav !== "boolean") {
    return response(422, { error: "Invalid show in nav flag" });
  }
  let key: string | undefined;
  if (body.key !== undefined && body.key !== type.key) {
    if (type.status !== "draft") {
      return response(422, {
        error:
          "The key is pinned once a type has been published (records and numbering reference it)",
      });
    }
    if (typeof body.key !== "string") return response(422, { error: "Invalid key" });
    const issue = typeKeyError(body.key);
    if (issue) return response(422, { error: issue });
    const clash = await db.execute(
      sql`select 1 from custom_record_types where org_id = ${user.orgId} and key = ${body.key} and id <> ${id}`,
      "objects",
    );
    if (clash.length)
      return response(409, { error: `A record type with key "${body.key}" already exists` });
    key = body.key;
  }
  let fieldsJson: string | undefined;
  let nextSections: FormSection[] | undefined;
  let issues: { path: Array<string | number>; message: string }[] = [];
  if (body.fields !== undefined) {
    const lint = lintRecordFields(body.fields, String(body.name ?? type.name));
    if (!lint.success)
      return response(422, {
        error: `Invalid fields: ${lint.issues.slice(0, 3).map(describeIssue).join("; ")}`,
        issues: lint.issues,
      });
    fieldsJson = JSON.stringify(lint.sections);
    nextSections = lint.sections;
    issues = lint.issues;
  } else {
    issues = lintRecordFields(type.fields, String(body.name ?? type.name)).issues;
  }
  const expected = body.expectedUpdatedAt;
  if (!isDocumentRevisionToken(expected)) return response(409, { ...TYPE_REVISION_CONFLICT });
  const outcome = await withOrgTransaction(user.orgId, async () => {
    const locked = (
      await db.execute<{
        updated_at: string;
        fields: unknown;
        name: string;
        snapshot: Record<string, unknown>;
      }>(
        sql`select ${TYPE_REVISION_SQL} as updated_at, fields, name, to_jsonb(custom_record_types) as snapshot from custom_record_types where id = ${id} and org_id = ${user.orgId} for update`,
        "objects",
      )
    )[0];
    if (!locked) return "not_found" as const;
    if (locked.updated_at !== expected) return "conflict" as const;
    if (
      nextSections !== undefined &&
      context.authz.allowedSubsidiaryIds !== null &&
      typeDeclaresSubsidiary(locked.fields, locked.name) &&
      !hasSubsidiaryField(nextSections)
    ) {
      return "subsidiary_field_required" as const;
    }
    const updated = await db.execute<{ snapshot: Record<string, unknown> }>(
      sql`
        update custom_record_types set
          name = coalesce(${(body.name as string | undefined) ?? null}, name),
          plural_name = coalesce(${(body.pluralName as string | undefined) ?? null}, plural_name),
          key = coalesce(${key ?? null}, key),
          icon_key = coalesce(${(body.iconKey as string | undefined) ?? null}, icon_key),
          description = ${body.description !== undefined ? body.description : sql`description`},
          fields = coalesce(${fieldsJson ?? null}::jsonb, fields),
          show_in_nav = coalesce(${(body.showInNav as boolean | undefined) ?? null}, show_in_nav),
          allowed_roles = ${body.allowedRoles !== undefined ? (body.allowedRoles === null ? null : JSON.stringify(body.allowedRoles)) : sql`allowed_roles`}${body.allowedRoles !== undefined && body.allowedRoles !== null ? sql`::jsonb` : sql``},
          sort_order = coalesce(${(body.sortOrder as number | undefined) ?? null}, sort_order),
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
          updated_by = ${user.id}
        where id = ${id} and org_id = ${user.orgId} and ${TYPE_REVISION_SQL} = ${expected}
        returning to_jsonb(custom_record_types) as snapshot
      `,
      "objects",
    );
    if (!updated.length) return "conflict" as const;
    await auditSetupChange(
      {
        orgId: user.orgId,
        table: "custom_record_types",
        rowId: id,
        action: "update",
        changes: { before: locked.snapshot, after: updated[0]!.snapshot },
        actorId: user.id,
      },
      db,
    );
    return "ok" as const;
  });
  if (outcome === "not_found") return response(404, { error: "record not found" });
  if (outcome === "conflict") return response(409, { ...TYPE_REVISION_CONFLICT });
  if (outcome === "subsidiary_field_required")
    return response(422, {
      error:
        "Keep the subsidiary_id field; removing it would expose records from subsidiaries outside your scope",
    });
  const updated = await loadRecordTypeById(user.orgId, id);
  return updated
    ? response(200, { type: updated, issues })
    : response(404, { error: "record not found" });
}

export async function deleteCustomRecordType(
  context: ApplicationContext,
  id: string,
): Promise<RecordTypeActionResult> {
  assertApplicationPermission(context, "records.manage_types");
  const { user } = context.authz;
  if (!isUuid(id)) return response(404, { error: "record not found" });
  const outcome = await withOrgTransaction(user.orgId, async () => {
    const locked = (
      await db.execute<{ status: string; snapshot: Record<string, unknown> }>(
        sql`select status, to_jsonb(custom_record_types) as snapshot from custom_record_types where id = ${id} and org_id = ${user.orgId} for update`,
        "objects",
      )
    )[0];
    if (!locked) return "not_found" as const;
    if (locked.status !== "draft") return "not_draft" as const;
    const records = await db.execute(
      sql`select 1 from custom_records where org_id = ${user.orgId} and type_id = ${id} limit 1`,
      "objects",
    );
    if (records.length) return "has_records" as const;
    const deleted = await db.execute(
      sql`delete from custom_record_types where id = ${id} and org_id = ${user.orgId} and status = 'draft' and not exists (select 1 from custom_records where org_id = ${user.orgId} and type_id = ${id}) returning id`,
      "objects",
    );
    if (!deleted.length) return "has_records" as const;
    await auditSetupChange(
      {
        orgId: user.orgId,
        table: "custom_record_types",
        rowId: id,
        action: "delete",
        changes: { before: locked.snapshot },
        actorId: user.id,
      },
      db,
    );
    return "ok" as const;
  });
  if (outcome === "not_found") return response(404, { error: "record not found" });
  if (outcome === "not_draft")
    return response(422, {
      error: "Only draft types can be deleted — archive published types instead",
    });
  if (outcome === "has_records")
    return response(422, { error: "This type already has records and cannot be deleted" });
  return response(200, { ok: true });
}

export async function transitionCustomRecordType(
  context: ApplicationContext,
  id: string,
  action: "publish" | "archive",
  reason: string,
): Promise<RecordTypeActionResult> {
  assertApplicationPermission(context, "records.manage_types");
  const { user } = context.authz;
  if (!isUuid(id)) return response(404, { error: "record not found" });
  if (!reason.trim() || reason.trim().length > 2000) {
    return response(422, {
      error:
        "A reason is required to publish or archive a record type — include a reason for the audit trail",
    });
  }
  const outcome = await withOrgTransaction(user.orgId, async () => {
    const locked = (
      await db.execute<{
        id: string;
        key: string;
        name: string;
        plural_name: string;
        fields: unknown;
        status: string;
        snapshot: Record<string, unknown>;
      }>(
        sql`select id, key, name, plural_name, fields, status, to_jsonb(custom_record_types) as snapshot from custom_record_types where id = ${id} and org_id = ${user.orgId} for update`,
        "objects",
      )
    )[0];
    if (!locked) return "not_found" as const;
    if (action === "archive") {
      if (locked.status !== "published") return "not_published" as const;
      const changed = await db.execute<{ snapshot: Record<string, unknown> }>(
        sql`update custom_record_types set status = 'archived', updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${user.id} where id = ${id} and org_id = ${user.orgId} and status = 'published' returning to_jsonb(custom_record_types) as snapshot`,
        "objects",
      );
      if (!changed.length) return "not_published" as const;
      await auditSetupChange(
        {
          orgId: user.orgId,
          table: "custom_record_types",
          rowId: id,
          action: "update",
          changes: { before: locked.snapshot, after: changed[0]!.snapshot, reason: reason.trim() },
          actorId: user.id,
        },
        db,
      );
      return "archived" as const;
    }
    if (locked.status === "published") return "already_published" as const;
    const keyIssue = typeKeyError(locked.key);
    if (keyIssue) return { kind: "invalid", message: `Key ${keyIssue}` } as const;
    if (!locked.name.trim() || !locked.plural_name.trim())
      return { kind: "invalid", message: "Name and plural name are required" } as const;
    const lint = lintRecordFields(locked.fields, locked.name);
    if (!lint.success || lint.fields.length === 0)
      return { kind: "invalid", message: "Add at least one field before publishing" } as const;
    if (lint.issues.length)
      return {
        kind: "invalid",
        message: `Resolve ${lint.issues.length} field issue${lint.issues.length === 1 ? "" : "s"} before publishing: ${lint.issues.slice(0, 3).map(describeIssue).join("; ")}`,
        issues: lint.issues,
      } as const;
    const changed = await db.execute<{ snapshot: Record<string, unknown> }>(
      sql`update custom_record_types set status = 'published', updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${user.id} where id = ${id} and org_id = ${user.orgId} and status in ('draft', 'archived') returning to_jsonb(custom_record_types) as snapshot`,
      "objects",
    );
    if (!changed.length) return "conflict" as const;
    await auditSetupChange(
      {
        orgId: user.orgId,
        table: "custom_record_types",
        rowId: id,
        action: "update",
        changes: { before: locked.snapshot, after: changed[0]!.snapshot, reason: reason.trim() },
        actorId: user.id,
      },
      db,
    );
    return "published" as const;
  });
  if (outcome === "not_found") return response(404, { error: "record not found" });
  if (outcome === "not_published")
    return response(422, { error: "Only published types can be archived" });
  if (outcome === "already_published") return response(422, { error: "Already published" });
  if (outcome === "conflict")
    return response(409, { error: "This record type changed; reload the type and try again" });
  if (typeof outcome === "object" && outcome.kind === "invalid") {
    return response(422, {
      error: outcome.message,
      ...(outcome.issues ? { issues: outcome.issues } : {}),
    });
  }
  return response(200, { ok: true, status: outcome });
}
