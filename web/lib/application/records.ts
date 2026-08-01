import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  loadApiSchema,
  resolveApiType,
  type ApiOperation,
  type ApiRecordTypeSchema,
  type ResolvedApiType,
} from "../api/schema-registry";
import { createRecord, deleteRecord, updateRecord, type WriteResult } from "../api/writers";
import { clamp, isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import {
  assertApplicationPermission,
  assertSubsidiaryAccess,
} from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

export interface RecordListInput {
  typeKey: string;
  query?: string;
  page?: number;
  perPage?: number;
  subsidiaryId?: string;
}

export interface RecordListResult {
  records: Record<string, unknown>[];
  total: number;
  page: number;
  perPage: number;
}

interface RecordScope {
  resolved: ResolvedApiType;
  schema: ApiRecordTypeSchema;
}

async function scopeFor(
  context: ApplicationContext,
  typeKey: string,
  operation: ApiOperation,
): Promise<RecordScope> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(typeKey)) {
    throw invalidInput("typeKey must be a lowercase kebab-case record key");
  }
  const [resolved, schemas] = await Promise.all([
    resolveApiType(context.authz.user.orgId, typeKey),
    loadApiSchema(context.authz.user.orgId),
  ]);
  if (!resolved) throw notFound("record type");
  if (!resolved.operations.includes(operation)) {
    throw new ApplicationError(
      "unsupported_operation",
      `${typeKey} does not support ${operation}`,
      405,
    );
  }
  const schema = schemas.find((candidate) => candidate.key === resolved.key);
  if (!schema) throw notFound("record type schema");
  const permission = operation === "list" || operation === "get"
    ? resolved.readPermission
    : resolved.writePermission;
  if (!permission) {
    throw new ApplicationError(
      "unsupported_operation",
      `${typeKey} is read-only`,
      405,
    );
  }
  assertApplicationPermission(context, permission);
  return { resolved, schema };
}

function hasSubsidiary(scope: RecordScope): boolean {
  return scope.schema.fields.some((field) => field.name === "subsidiary_id");
}

function subsidiaryWhere(
  context: ApplicationContext,
  scope: RecordScope,
  requested?: string,
): SQL | null {
  if (!hasSubsidiary(scope)) return null;
  if (requested) {
    if (!isUuid(requested)) throw invalidInput("subsidiaryId must be a UUID");
    assertSubsidiaryAccess(context, requested);
    return sql`subsidiary_id = ${requested}`;
  }
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed === null) return null;
  if (allowed.size === 0) return sql`false`;
  return sql`subsidiary_id = any(${[...allowed]}::uuid[])`;
}

function baseWhere(
  context: ApplicationContext,
  scope: RecordScope,
  input: { id?: string; query?: string; subsidiaryId?: string },
): SQL {
  const conditions: SQL[] = [sql`org_id = ${context.authz.user.orgId}`];
  if (input.id) conditions.push(sql`id = ${input.id}`);
  if (scope.resolved.writer.kind === "document") {
    conditions.push(sql`kind = ${scope.resolved.writer.docKind}`);
  }
  if (scope.resolved.dynamic) {
    conditions.push(sql`type_key = ${scope.resolved.key}`);
  }
  const subsidiary = subsidiaryWhere(context, scope, input.subsidiaryId);
  if (subsidiary) conditions.push(subsidiary);
  if (input.query?.trim()) {
    const escaped = input.query.trim().replace(/[\\%_]/g, (match) => `\\${match}`);
    conditions.push(
      sql`${sql.raw(scope.resolved.searchColumn)} ilike ${`%${escaped.toLowerCase()}%`}`,
    );
  }
  return sql.join(conditions, sql` and `);
}

function requestedSubsidiary(body: Record<string, unknown>): string | null | undefined {
  const value = body.subsidiaryId ?? body.subsidiary_id;
  if (value === null || value === undefined) return value;
  if (typeof value !== "string" || !isUuid(value)) {
    throw invalidInput("subsidiaryId must be a UUID or null");
  }
  return value;
}

function writerError(result: WriteResult): never {
  const body = result.body && typeof result.body === "object"
    ? result.body as Record<string, unknown>
    : {};
  const raw = typeof body.error === "string" ? body.error : "record mutation rejected";
  const leaksInternals = /\b(sql|constraint|duplicate key|foreign key|stack|query)\b/i.test(raw)
    || raw.startsWith("could not ")
    || raw.startsWith("cannot delete — referenced");
  const message = leaksInternals ? "record mutation rejected by a data integrity control" : raw;
  const code = result.status === 404
    ? "not_found"
    : result.status === 409
      ? "conflict"
      : result.status === 405
        ? "unsupported_operation"
        : "invalid_input";
  throw new ApplicationError(code, message, result.status, {
    ...(body.fieldErrors ? { fieldErrors: body.fieldErrors } : {}),
    ...(body.errors ? { errors: body.errors } : {}),
  });
}

function writerValue(result: WriteResult): { status: number; body: unknown } {
  if (result.status >= 400) writerError(result);
  return { status: result.status, body: result.body };
}

async function assertExistingRecordAccess(
  context: ApplicationContext,
  scope: RecordScope,
  id: string,
): Promise<void> {
  const table = sql.raw(`"${scope.resolved.table}"`);
  const where = baseWhere(context, scope, { id });
  const row = (await db.execute(sql`
    select 1 from ${table} where ${where} limit 1
  `)) as unknown as { rows: { "?column?": number }[] };
  if (!row.rows[0]) throw notFound();
}

export async function listRecordTypes(
  context: ApplicationContext,
): Promise<ApiRecordTypeSchema[]> {
  const schemas = await loadApiSchema(context.authz.user.orgId);
  return schemas.filter((schema) => {
    try {
      assertApplicationPermission(context, schema.readPermission);
      return true;
    } catch {
      return false;
    }
  });
}

export async function listRecords(
  context: ApplicationContext,
  input: RecordListInput,
): Promise<RecordListResult> {
  const scope = await scopeFor(context, input.typeKey, "list");
  const page = clamp(input.page ?? 1, 1, 10_000);
  const perPage = clamp(input.perPage ?? 25, 5, 100);
  const where = baseWhere(context, scope, {
    query: input.query,
    subsidiaryId: input.subsidiaryId,
  });
  const table = sql.raw(`"${scope.resolved.table}"`);
  const [rows, count] = await Promise.all([
    db.execute(sql`
      select * from ${table}
       where ${where}
       order by created_at desc, id desc
       limit ${perPage} offset ${(page - 1) * perPage}
    `) as Promise<{ rows: Record<string, unknown>[] }>,
    db.execute(sql`select count(*) as count from ${table} where ${where}`) as Promise<{
      rows: { count: string | number }[];
    }>,
  ]);
  return {
    records: rows.rows,
    total: Number(count.rows[0]?.count ?? 0),
    page,
    perPage,
  };
}

export async function getRecord(
  context: ApplicationContext,
  input: { typeKey: string; id: string },
): Promise<Record<string, unknown>> {
  if (!isUuid(input.id)) throw invalidInput("id must be a UUID");
  const scope = await scopeFor(context, input.typeKey, "get");
  const table = sql.raw(`"${scope.resolved.table}"`);
  const where = baseWhere(context, scope, { id: input.id });
  const result = (await db.execute(sql`
    select * from ${table} where ${where} limit 1
  `)) as unknown as { rows: Record<string, unknown>[] };
  if (!result.rows[0]) throw notFound();
  return result.rows[0];
}

export async function createApplicationRecord(
  context: ApplicationContext,
  input: {
    typeKey: string;
    body: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; status: number; result: unknown }> {
  const scope = await scopeFor(context, input.typeKey, "create");
  assertSubsidiaryAccess(context, requestedSubsidiary(input.body));
  const outcome = await executeIdempotent({
    context,
    operation: `records.${input.typeKey}.create`,
    idempotencyKey: input.idempotencyKey,
    request: input.body,
    execute: async () => writerValue(await createRecord(
      context.authz.user,
      scope.resolved,
      scope.schema.fields,
      input.body,
      { source: context.source },
    )),
  });
  return { replayed: outcome.replayed, status: outcome.value.status, result: outcome.value.body };
}

export async function updateApplicationRecord(
  context: ApplicationContext,
  input: {
    typeKey: string;
    id: string;
    body: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<{ replayed: boolean; status: number; result: unknown }> {
  if (!isUuid(input.id)) throw invalidInput("id must be a UUID");
  const scope = await scopeFor(context, input.typeKey, "update");
  await assertExistingRecordAccess(context, scope, input.id);
  assertSubsidiaryAccess(context, requestedSubsidiary(input.body));
  const outcome = await executeIdempotent({
    context,
    operation: `records.${input.typeKey}.update`,
    idempotencyKey: input.idempotencyKey,
    request: { id: input.id, body: input.body },
    execute: async () => writerValue(await updateRecord(
      context.authz.user,
      scope.resolved,
      scope.schema.fields,
      input.id,
      input.body,
      { source: context.source },
    )),
  });
  return { replayed: outcome.replayed, status: outcome.value.status, result: outcome.value.body };
}

export async function deleteApplicationRecord(
  context: ApplicationContext,
  input: { typeKey: string; id: string; idempotencyKey: string },
): Promise<{ replayed: boolean; status: number; result: unknown }> {
  if (!isUuid(input.id)) throw invalidInput("id must be a UUID");
  const scope = await scopeFor(context, input.typeKey, "delete");
  await assertExistingRecordAccess(context, scope, input.id);
  const outcome = await executeIdempotent({
    context,
    operation: `records.${input.typeKey}.delete`,
    idempotencyKey: input.idempotencyKey,
    request: { id: input.id },
    execute: async () => writerValue(await deleteRecord(
      context.authz.user,
      scope.resolved,
      input.id,
    )),
  });
  return { replayed: outcome.replayed, status: outcome.value.status, result: outcome.value.body };
}
