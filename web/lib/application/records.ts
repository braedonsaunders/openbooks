import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  API_RECORD_TYPES,
  loadApiSchema,
  resolveApiType,
  type ApiOperation,
  type ApiRecordTypeSchema,
  type ResolvedApiType,
} from "../api/schema-registry";
import { createRecord, deleteRecord, updateRecord, type WriteResult } from "../api/writers";
import { clamp, isUuid } from "../list-params";
import {
  documentRevisionProjection,
  normalizeDocumentRecordRevisions,
} from "@openbooks/engine/records/document-edit-policy";
import { pgTextArrayLiteral } from "../pg-array";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";
import { inTypeAudience, loadRecordTypeByKey, recordVisibleInSubsidiaryFenceSql } from "../records";
import {
  customFieldViewerFor,
  loadCustomFieldAccessDefs,
  redactHiddenCustomValues,
} from "../custom-fields";
import {
  createApplicationOrder,
  createFullApplicationOrder,
  editApplicationOrderDraft,
  ORDER_TYPE_KIND,
  type FullOrderInput,
  type OrderTypeKey,
} from "./orders";

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

export function applicationDocumentHref(kind: string, id: string): string {
  return documentHref("documents", { kind, id }) ?? `/documents?doc=${encodeURIComponent(id)}`;
}

export function applicationRecordHref(
  typeKey: string,
  value: unknown,
  fallbackId?: string,
): string | null {
  const entry = API_RECORD_TYPES.find((type) => type.key === typeKey);
  if (!entry || entry.writer.kind !== "document") return null;
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const nested =
    record.document && typeof record.document === "object"
      ? (record.document as Record<string, unknown>)
      : record.doc && typeof record.doc === "object"
        ? (record.doc as Record<string, unknown>)
        : null;
  const id =
    (typeof record.id === "string" && record.id) ||
    (typeof record.documentId === "string" && record.documentId) ||
    (typeof nested?.id === "string" && nested.id) ||
    fallbackId;
  return id ? applicationDocumentHref(entry.writer.docKind, id) : null;
}

function documentHref(typeKey: string, row: Record<string, unknown>): string | null {
  if (typeof row.id !== "string") return null;
  const id = encodeURIComponent(row.id);
  switch (String(row.kind ?? "")) {
    case "vendor_bill":
    case "vendor_credit":
      return `/ap/bills?doc=${id}`;
    case "customer_invoice":
    case "customer_credit":
      return `/ar/invoices?doc=${id}`;
    case "cash_sale":
    case "cash_refund":
      return `/cash-sales?doc=${id}`;
    case "sales_order":
      return `/sales-orders?order=${id}`;
    case "purchase_order":
      return `/purchase-orders?order=${id}`;
    case "quote":
      return `/estimates?estimate=${id}`;
    case "rma":
      return `/returns?doc=${id}`;
    case "internal_billing":
      return `/internal-billing?doc=${id}`;
    case "project_charge":
      return `/projects?projectTxn=${id}&projectTxnKind=project_charge`;
    case "vendor_payment":
      return `/payments?payment=${id}`;
    case "customer_payment":
      return `/receipts?payment=${id}`;
    case "sales_fulfillment":
      return `/shipments?shipment=${id}`;
    case "purchase_receipt":
      return "/purchase-orders";
    case "expense_report":
      return `/expenses/reports?expense=${id}`;
    case "field_ticket":
      return `/field-tickets?ticket=${id}`;
    case "pay_run":
      return `/payroll/runs?run=${id}`;
    case "journal":
      return `/journal?journal=${id}`;
    case "check":
    case "deposit":
    case "transfer":
    case "card_charge":
    case "card_refund":
      return `/banking/cash?doc=${id}`;
    default:
      return `/${typeKey}?record=${id}`;
  }
}

async function documentLinesById(ids: readonly string[]): Promise<Map<string, unknown[]>> {
  if (ids.length === 0) return new Map();
  const rows = await db.execute<{ documentId: string; lines: unknown[] }>(
    sql`
    select document_id as "documentId",
           json_agg(to_jsonb(line) order by line_number) as lines
      from document_lines line
     where document_id = any(${pgTextArrayLiteral([...ids])}::uuid[])
     group by document_id
  `,
    "objects",
  );
  return new Map(rows.map((row) => [row.documentId, row.lines ?? []]));
}

function redactDocumentLines(
  lines: unknown[],
  definitions: Awaited<ReturnType<typeof loadCustomFieldAccessDefs>>,
  viewer: ReturnType<typeof customFieldViewerFor>,
): unknown[] {
  return lines.map((line) => {
    if (!line || typeof line !== "object" || Array.isArray(line)) return line;
    const record = line as Record<string, unknown>;
    if (!record.custom || typeof record.custom !== "object" || Array.isArray(record.custom)) {
      return record;
    }
    return {
      ...record,
      custom: redactHiddenCustomValues(
        definitions,
        viewer,
        record.custom as Record<string, unknown>,
      ),
    };
  });
}

function exposeDocumentRecord(
  typeKey: string,
  row: Record<string, unknown>,
  lines: unknown[] = [],
): Record<string, unknown> {
  if (typeof row.kind !== "string") return row;
  const revision = typeof row.updated_at === "string" ? row.updated_at : undefined;
  return {
    ...row,
    lines,
    ...(revision === undefined ? {} : { revision }),
    href: documentHref(typeKey, row),
  };
}

interface RecordScope {
  resolved: ResolvedApiType;
  schema: ApiRecordTypeSchema;
}

async function typeAudienceVisible(
  context: ApplicationContext,
  schema: ApiRecordTypeSchema,
): Promise<boolean> {
  if (!schema.dynamic) return true;
  const type = await loadRecordTypeByKey(context.authz.user.orgId, schema.key);
  return Boolean(
    type &&
    type.status === "published" &&
    inTypeAudience(
      context.authz.user.roles.map(({ key }) => key),
      type.allowed_roles,
    ),
  );
}

export { normalizeDocumentRecordRevisions } from "@openbooks/engine/records/document-edit-policy";

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
    loadApiSchema(context.authz.user.orgId, null, customFieldViewerFor(context.authz)),
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
  if (!(await typeAudienceVisible(context, schema))) throw notFound("record type");
  const permission =
    operation === "list" || operation === "get"
      ? resolved.readPermission
      : resolved.writePermission;
  if (!permission) {
    throw new ApplicationError("unsupported_operation", `${typeKey} is read-only`, 405);
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
  if (requested) {
    if (!isUuid(requested)) throw invalidInput("subsidiaryId must be a UUID");
    assertSubsidiaryAccess(context, requested);
    return scope.resolved.dynamic
      ? sql`data ->> ${"subsidiary_id"} = ${requested}`
      : sql`subsidiary_id = ${requested}`;
  }
  if (scope.resolved.dynamic) {
    return recordVisibleInSubsidiaryFenceSql(
      context.authz.allowedSubsidiaryIds,
      hasSubsidiary(scope),
    );
  }
  if (!hasSubsidiary(scope)) return null;
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed === null) return null;
  if (allowed.size === 0) return sql`false`;
  return scope.resolved.dynamic
    ? sql`data ->> ${"subsidiary_id"} = any(${pgTextArrayLiteral([...allowed])}::text[])`
    : sql`subsidiary_id = any(${pgTextArrayLiteral([...allowed])}::uuid[])`;
}

function baseWhere(
  context: ApplicationContext,
  scope: RecordScope,
  input: { id?: string; query?: string; subsidiaryId?: string },
): SQL {
  const conditions: SQL[] = [sql`org_id = ${context.authz.user.orgId}`];
  if (input.id) conditions.push(sql`id = ${input.id}`);
  if (scope.resolved.documentKinds) {
    conditions.push(
      sql`kind = any(${pgTextArrayLiteral([...scope.resolved.documentKinds])}::text[])`,
    );
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
  const direct = body.subsidiaryId ?? body.subsidiary_id;
  const nested =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>).subsidiary_id
      : undefined;
  const value = direct ?? nested;
  if (value === null || value === undefined) return value;
  if (typeof value !== "string" || !isUuid(value)) {
    throw invalidInput("subsidiaryId must be a UUID or null");
  }
  return value;
}

function writerError(result: WriteResult): never {
  const body =
    result.body && typeof result.body === "object" ? (result.body as Record<string, unknown>) : {};
  const raw = typeof body.error === "string" ? body.error : "record mutation rejected";
  const leaksInternals =
    /\b(sql|constraint|duplicate key|foreign key|stack|query)\b/i.test(raw) ||
    raw.startsWith("could not ") ||
    raw.startsWith("cannot delete — referenced");
  const message = leaksInternals ? "record mutation rejected by a data integrity control" : raw;
  const code =
    result.status === 404
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

export function applicationWriteValue(result: WriteResult): { status: number; body: unknown } {
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
  const row = await db.execute<{ "?column?": number }>(
    sql`
    select 1 from ${table} where ${where} limit 1
  `,
    "objects",
  );
  if (!row[0]) throw notFound();
}

export async function listRecordTypes(context: ApplicationContext): Promise<ApiRecordTypeSchema[]> {
  const schemas = await loadApiSchema(
    context.authz.user.orgId,
    null,
    customFieldViewerFor(context.authz),
  );
  const visible = await Promise.all(
    schemas.map(async (schema) => {
      if (!(await typeAudienceVisible(context, schema))) return null;
      try {
        assertApplicationPermission(context, schema.readPermission);
        return schema;
      } catch {
        return null;
      }
    }),
  );
  return visible.flatMap((schema) => (schema ? [schema] : []));
}

/** Recheck the exact record permission and tenant scope before replaying a write. */
export async function authorizeApplicationRecordMutation(
  context: ApplicationContext,
  input: {
    typeKey: string;
    operation: "create" | "update" | "delete";
    id?: string;
    body?: Record<string, unknown>;
  },
): Promise<void> {
  const scope = await scopeFor(context, input.typeKey, input.operation);
  if (input.operation === "create") {
    const requested = requestedSubsidiary(input.body ?? {});
    const orderType = input.typeKey in ORDER_TYPE_KIND;
    const documentWriter = scope.resolved.writer.kind === "document";
    if (requested !== undefined || (!scope.resolved.dynamic && !documentWriter)) {
      assertSubsidiaryAccess(context, requested);
    }
    if (orderType && requested === undefined) {
      const allowed = context.authz.allowedSubsidiaryIds;
      assertSubsidiaryAccess(
        context,
        allowed !== null && allowed.size === 1 ? [...allowed][0] : undefined,
      );
    }
    return;
  }
  if (!input.id) throw invalidInput("id is required to authorize this record mutation");
  await assertExistingRecordAccess(context, scope, input.id);
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
      select *${documentRevisionProjection(scope.resolved.table)} from ${table}
       where ${where}
       order by created_at desc, id desc
       limit ${perPage} offset ${(page - 1) * perPage}
    `) as Promise<{ rows: Record<string, unknown>[] }>,
    db.execute(sql`select count(*) as count from ${table} where ${where}`) as Promise<{
      rows: { count: string | number }[];
    }>,
  ]);
  const documentLines =
    scope.resolved.table === "documents"
      ? await documentLinesById(rows.rows.map((row) => String(row.id)))
      : new Map<string, unknown[]>();
  const lineCustomDefinitions =
    scope.resolved.table === "documents"
      ? await Promise.all(
          [...new Set(rows.rows.map((row) => String(row.kind)))].map(
            async (kind) =>
              [kind, await loadCustomFieldAccessDefs("document_lines", kind)] as const,
          ),
        )
      : [];
  const lineDefinitionsByKind = new Map(lineCustomDefinitions);
  const definitions = await loadCustomFieldAccessDefs(
    scope.resolved.table,
    scope.resolved.documentKinds?.[0],
  );
  const viewer = customFieldViewerFor(context.authz);
  return {
    records: normalizeDocumentRecordRevisions(scope.resolved.table, rows.rows).map((row) => {
      const custom =
        row.custom && typeof row.custom === "object"
          ? redactHiddenCustomValues(definitions, viewer, row.custom as Record<string, unknown>)
          : row.custom;
      const visible = { ...row, ...(custom === undefined ? {} : { custom }) };
      return scope.resolved.table === "documents"
        ? exposeDocumentRecord(
            scope.resolved.key,
            visible,
            redactDocumentLines(
              documentLines.get(String(row.id)) ?? [],
              lineDefinitionsByKind.get(String(row.kind)) ?? [],
              viewer,
            ),
          )
        : visible;
    }),
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
  const result = await db.execute<Record<string, unknown>>(
    sql`
    select *${documentRevisionProjection(scope.resolved.table)} from ${table} where ${where} limit 1
  `,
    "objects",
  );
  if (!result[0]) throw notFound();
  const row = normalizeDocumentRecordRevisions(scope.resolved.table, result)[0]!;
  const definitions = await loadCustomFieldAccessDefs(
    scope.resolved.table,
    scope.resolved.documentKinds?.[0],
  );
  if (row.custom && typeof row.custom === "object") {
    row.custom = redactHiddenCustomValues(
      definitions,
      customFieldViewerFor(context.authz),
      row.custom as Record<string, unknown>,
    );
  }
  if (scope.resolved.table === "documents") {
    const lines = await documentLinesById([input.id]);
    const lineDefinitions = await loadCustomFieldAccessDefs("document_lines", String(row.kind));
    return exposeDocumentRecord(
      scope.resolved.key,
      row,
      redactDocumentLines(
        lines.get(input.id) ?? [],
        lineDefinitions,
        customFieldViewerFor(context.authz),
      ),
    );
  }
  return row;
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
  const requested = requestedSubsidiary(input.body);
  const orderType = input.typeKey in ORDER_TYPE_KIND;
  const documentWriter = scope.resolved.writer.kind === "document";
  if (requested !== undefined || (!scope.resolved.dynamic && !documentWriter)) {
    assertSubsidiaryAccess(context, requested);
  }
  const outcome = await executeIdempotent({
    context,
    operation: `records.${input.typeKey}.create`,
    idempotencyKey: input.idempotencyKey,
    request: input.body,
    // The transport responds with the write result's own status; record it.
    successStatus: (value) => value.status,
    execute: async () => {
      if (orderType) {
        const typeKey = input.typeKey as OrderTypeKey;
        const kind = ORDER_TYPE_KIND[typeKey];
        const salesOrderContent = [
          "customer",
          "lines",
          "shippingLines",
          "documentDate",
          "dueDate",
          "currency",
          "memo",
          "externalRef",
          "externalSource",
        ].some((field) => input.body[field] !== undefined);
        if (typeKey === "sales-orders" && salesOrderContent) {
          const allowedFields = new Set([
            "customer",
            "lines",
            "shippingLines",
            "documentDate",
            "dueDate",
            "currency",
            "memo",
            "externalRef",
            "externalSource",
            "subsidiaryId",
            "subsidiary_id",
          ]);
          const unknownFields = Object.keys(input.body).filter(
            (field) => !allowedFields.has(field),
          );
          if (unknownFields.length > 0) {
            throw invalidInput(`unsupported sales-order create field: ${unknownFields[0]}`);
          }
          if (!input.body.customer || typeof input.body.customer !== "object") {
            throw invalidInput("customer is required when creating a sales order with content");
          }
          const order = await createFullApplicationOrder(context, {
            ...(input.body as unknown as Omit<FullOrderInput, "kind" | "idempotencyKey">),
            kind: "sales_order",
            idempotencyKey: input.idempotencyKey,
            subsidiaryId: (requested ?? null) as string | null,
          });
          return { status: 201, body: order.result };
        }
        const unsupportedContent = Object.keys(input.body).filter(
          (key) => !["subsidiaryId", "subsidiary_id"].includes(key),
        );
        if (unsupportedContent.length > 0) {
          throw invalidInput(
            `${typeKey} creates an empty draft; create it with subsidiaryId, then set its fields through update_record`,
          );
        }
        const order = await createApplicationOrder(context, {
          kind,
          idempotencyKey: input.idempotencyKey,
          subsidiaryId: (requested ?? null) as string | null,
        });
        return { status: 201, body: order.result };
      }
      const write = applicationWriteValue(
        await createRecord(context.authz.user, scope.resolved, scope.schema.fields, input.body, {
          source: context.source,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          customFieldViewer: customFieldViewerFor(context.authz),
        }),
      );
      return write;
    },
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
  const requested = requestedSubsidiary(input.body);
  if (requested !== undefined) assertSubsidiaryAccess(context, requested);
  const outcome = await executeIdempotent({
    context,
    operation: `records.${input.typeKey}.update`,
    idempotencyKey: input.idempotencyKey,
    request: { id: input.id, body: input.body },
    successStatus: (value) => value.status,
    execute: async () => {
      if (input.typeKey in ORDER_TYPE_KIND) {
        const result = await editApplicationOrderDraft(
          context,
          input.typeKey as OrderTypeKey,
          input.id,
          input.body as never,
        );
        return { status: 200, body: result };
      }
      const write = applicationWriteValue(
        await updateRecord(
          context.authz.user,
          scope.resolved,
          scope.schema.fields,
          input.id,
          input.body,
          {
            source: context.source,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
            customFieldViewer: customFieldViewerFor(context.authz),
          },
        ),
      );
      return write;
    },
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
    successStatus: (value) => value.status,
    execute: async () =>
      applicationWriteValue(
        await deleteRecord(context.authz.user, scope.resolved, input.id, {
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        }),
      ),
  });
  return { replayed: outcome.replayed, status: outcome.value.status, result: outcome.value.body };
}
