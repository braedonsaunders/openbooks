import { lockManufacturingManageAuthority } from "@openbooks/engine/manufacturing/authority";
import { assertManufacturingFeature } from "@openbooks/engine/manufacturing/gate";
import { sql } from "drizzle-orm";
import {
  ManufacturingError,
  ManufacturingIdempotencyConflictError,
} from "@openbooks/engine/manufacturing/errors";
import { db } from "@openbooks/engine/platform/db";
import { isUuid } from "@openbooks/engine/platform/identifiers";
import { claimIdempotentCreate, resolveIdempotentReplay } from "@/lib/api/idempotency";

/** Called only inside withOrgTransaction so the key lock, claim, domain write, and audit commit together. */
export async function idempotentManufacturingCreate<T>(input: {
  orgId: string;
  actorId: string;
  request: Request;
  table: string;
  match: Record<string, unknown>;
  create: (id: string, requestId: string, match: Record<string, unknown>) => Promise<T>;
  load: () => Promise<T | null>;
}): Promise<T> {
  const key = input.request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!isUuid(key)) {
    throw new ManufacturingError("A UUID Idempotency-Key header is required for this create.", {
      status: 400,
      code: "invalid_idempotency_key",
      remedy: "Retry the create with a new UUID Idempotency-Key.",
    });
  }
  await assertManufacturingFeature(
    db,
    input.orgId,
    input.table === "mfg_mrp_runs" ? "manufacturingMrp" : "manufacturing",
  );
  await lockManufacturingManageAuthority(db, input.orgId, input.actorId, null);
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${input.orgId} || ':manufacturing-create:' || ${input.table} || ':' || ${key}, 0))`,
  );
  const claim = await claimIdempotentCreate(db, { orgId: input.orgId, table: input.table, key });
  if (claim === "exists") {
    // Resolve actual retained-resource authority before disclosing request-match or replay evidence.
    const existing = await input.load();
    if (existing === null) throw new ManufacturingIdempotencyConflictError();
    const result = await resolveIdempotentReplay(db, {
      orgId: input.orgId,
      table: input.table,
      key,
      match: input.match,
      matchField: "match",
    });
    if (result !== "replay") throw new ManufacturingIdempotencyConflictError();
    return existing;
  }

  await db.execute(sql`savepoint mfg_idempotent_create`);
  try {
    const result = await input.create(key, key, input.match);
    await db.execute(sql`release savepoint mfg_idempotent_create`);
    return result;
  } catch (error) {
    await db.execute(sql`rollback to savepoint mfg_idempotent_create`);
    await db.execute(sql`release savepoint mfg_idempotent_create`);
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    const constraint =
      typeof error === "object" && error !== null && "constraint" in error
        ? String((error as { constraint?: unknown }).constraint)
        : "";
    if (code === "23505" && constraint.endsWith("_pkey"))
      throw new ManufacturingIdempotencyConflictError();
    throw error;
  }
}
