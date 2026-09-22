import "server-only";
import { NextResponse } from "next/server";
import {
  createApplicationRecord,
  deleteApplicationRecord,
  getRecord,
  listRecords,
  updateApplicationRecord,
} from "../application/records";
import { notFound } from "../application/errors";
import { clamp } from "../list-params";
import {
  readV1JsonObject,
  requireV1IdempotencyKey,
  withV1Request,
} from "./v1-request";
import { V1_RESERVED_STATIC_SEGMENTS } from "./registry-data";

const RESERVED = new Set<string>(V1_RESERVED_STATIC_SEGMENTS);

function assertAliasedTypeKey(typeKey: string): void {
  if (RESERVED.has(typeKey)) throw notFound("record type");
}

function listQuery(request: Request): {
  query?: string;
  page: number;
  perPage: number;
  subsidiaryId?: string;
} {
  const url = new URL(request.url);
  return {
    query: url.searchParams.get("q")?.trim() || undefined,
    page: clamp(Number(url.searchParams.get("page") ?? "1"), 1, 10_000),
    perPage: clamp(Number(url.searchParams.get("perPage") ?? "25"), 5, 100),
    subsidiaryId: url.searchParams.get("subsidiaryId") || undefined,
  };
}

/** GET collection — same application list as /api/v1/records/{typeKey}. */
export function v1ListRecords(
  request: Request,
  typeKey: string,
  label = `api/v1/${typeKey}`,
): Promise<NextResponse> {
  return withV1Request(request, label, async (_auth, context) => ({
    status: 200,
    body: await listRecords(context, { typeKey, ...listQuery(request) }),
  }));
}

/** POST collection — same application create as /api/v1/records/{typeKey}. */
export function v1CreateRecord(
  request: Request,
  typeKey: string,
  label = `api/v1/${typeKey}`,
): Promise<NextResponse> {
  return withV1Request(request, label, async (_auth, context) => {
    const outcome = await createApplicationRecord(context, {
      typeKey,
      body: await readV1JsonObject(request),
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: outcome.status, body: outcome.result, replayed: outcome.replayed };
  });
}

/** GET item — same application read as /api/v1/records/{typeKey}/{id}. */
export function v1GetRecord(
  request: Request,
  typeKey: string,
  id: string,
  label = `api/v1/${typeKey}/:id`,
): Promise<NextResponse> {
  return withV1Request(request, label, async (_auth, context) => ({
    status: 200,
    body: await getRecord(context, { typeKey, id }),
  }));
}

/** PATCH item — same application update as /api/v1/records/{typeKey}/{id}. */
export function v1UpdateRecord(
  request: Request,
  typeKey: string,
  id: string,
  label = `api/v1/${typeKey}/:id`,
): Promise<NextResponse> {
  return withV1Request(request, label, async (_auth, context) => {
    const outcome = await updateApplicationRecord(context, {
      typeKey,
      id,
      body: await readV1JsonObject(request),
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: outcome.status, body: outcome.result, replayed: outcome.replayed };
  });
}

/** DELETE item — same application delete as /api/v1/records/{typeKey}/{id}. */
export function v1DeleteRecord(
  request: Request,
  typeKey: string,
  id: string,
  label = `api/v1/${typeKey}/:id`,
): Promise<NextResponse> {
  return withV1Request(request, label, async (_auth, context) => {
    const outcome = await deleteApplicationRecord(context, {
      typeKey,
      id,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: outcome.status, body: outcome.result, replayed: outcome.replayed };
  });
}

/** First-class alias of /api/v1/records/{typeKey} — refuses reserved static folders. */
export function v1ListAliasedRecords(request: Request, typeKey: string): Promise<NextResponse> {
  return withV1Request(request, `api/v1/${typeKey}`, async (_auth, context) => {
    assertAliasedTypeKey(typeKey);
    return { status: 200, body: await listRecords(context, { typeKey, ...listQuery(request) }) };
  });
}

export function v1CreateAliasedRecord(request: Request, typeKey: string): Promise<NextResponse> {
  return withV1Request(request, `api/v1/${typeKey}`, async (_auth, context) => {
    assertAliasedTypeKey(typeKey);
    const outcome = await createApplicationRecord(context, {
      typeKey,
      body: await readV1JsonObject(request),
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: outcome.status, body: outcome.result, replayed: outcome.replayed };
  });
}

export function v1GetAliasedRecord(request: Request, typeKey: string, id: string): Promise<NextResponse> {
  return withV1Request(request, `api/v1/${typeKey}/:id`, async (_auth, context) => {
    assertAliasedTypeKey(typeKey);
    return { status: 200, body: await getRecord(context, { typeKey, id }) };
  });
}

export function v1UpdateAliasedRecord(request: Request, typeKey: string, id: string): Promise<NextResponse> {
  return withV1Request(request, `api/v1/${typeKey}/:id`, async (_auth, context) => {
    assertAliasedTypeKey(typeKey);
    const outcome = await updateApplicationRecord(context, {
      typeKey,
      id,
      body: await readV1JsonObject(request),
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: outcome.status, body: outcome.result, replayed: outcome.replayed };
  });
}

export function v1DeleteAliasedRecord(request: Request, typeKey: string, id: string): Promise<NextResponse> {
  return withV1Request(request, `api/v1/${typeKey}/:id`, async (_auth, context) => {
    assertAliasedTypeKey(typeKey);
    const outcome = await deleteApplicationRecord(context, {
      typeKey,
      id,
      idempotencyKey: requireV1IdempotencyKey(request),
    });
    return { status: outcome.status, body: outcome.result, replayed: outcome.replayed };
  });
}
