import { sql } from "drizzle-orm";
import { ResourcingRefusal } from "@openbooks/engine/src/resourcing/errors.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { claimIdempotentCreate, resolveIdempotentReplay } from "@/lib/api/idempotency";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type CreateTable = "res_demand_lines" | "res_requests" | "res_retainers";

/** Call inside withOrgTransaction so the lock, create, and audit commit together. */
export async function idempotentResourcingCreate<T>(input: {
  orgId: string;
  request: Request;
  table: CreateTable;
  match: Record<string, unknown>;
  create: (id: string, requestId: string, match: Record<string, unknown>) => Promise<T>;
  load: () => Promise<T | null>;
}): Promise<T> {
  const key = input.request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!UUID.test(key)) {
    throw new ResourcingRefusal(
      400,
      "invalid_idempotency_key",
      "A UUID Idempotency-Key header is required for this create.",
      "Retry the create with a new UUID Idempotency-Key.",
    );
  }

  await db.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(
      ${input.orgId} || ':resourcing-create:' || ${input.table} || ':' || ${key}, 0))
  `);
  const claim = await claimIdempotentCreate(db, { orgId: input.orgId, table: input.table, key });
  if (claim === "exists") {
    const replay = await resolveIdempotentReplay(db, {
      orgId: input.orgId,
      table: input.table,
      key,
      match: input.match,
      matchField: "match",
    });
    if (replay !== "replay") throw idempotencyConflict();
    const existing = await input.load();
    if (existing === null) throw idempotencyConflict();
    return existing;
  }

  await db.execute(sql`savepoint resourcing_idempotent_create`);
  try {
    const result = await input.create(key, key, input.match);
    await db.execute(sql`release savepoint resourcing_idempotent_create`);
    return result;
  } catch (error) {
    await db.execute(sql`rollback to savepoint resourcing_idempotent_create`);
    await db.execute(sql`release savepoint resourcing_idempotent_create`);
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    const constraint = typeof error === "object" && error !== null && "constraint" in error ? String(error.constraint) : "";
    if (code === "23505" && constraint === `${input.table}_pkey`) throw idempotencyConflict();
    throw error;
  }
}

function idempotencyConflict(): ResourcingRefusal {
  return new ResourcingRefusal(
    409,
    "idempotency_key_conflict",
    "This request key is already in use or was saved with different details.",
    "Retry with the intended details and a new UUID Idempotency-Key.",
  );
}
