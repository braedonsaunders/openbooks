import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { InventoryError, InventoryIdempotencyConflictError } from "./contracts.ts";
const INVENTORY_ACTION_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const INVENTORY_ACTION_OPERATION_RE = /^[a-z][a-z0-9_.-]{2,99}$/;
const INVENTORY_ACTION_SOURCE = "api";
const RIVAL_POLL_START_MS = 25;
const RIVAL_POLL_MAX_MS = 250;
const RIVAL_POLL_BUDGET_MS = 45_000;

export interface IdempotentInventoryAction<T> {
  /** Namespaced verb stored beside the key, e.g. "inventory.receive". */
  operation: string;
  /** Stable client-supplied retry identity. Required — no default. */
  idempotencyKey: string | null | undefined;
  /** The exact request payload; key reuse with different input conflicts. */
  request: unknown;
  execute: () => Promise<T>;
}

type StoredInventoryKeyRow = {
  requestHash: string;
  response: unknown;
  completedAt: Date | null;
};

/**
 * Key-stable JSON encoding for request hashing: object keys sort, undefined
 * children drop, bigint/Date coerce — so two structurally equal payloads hash
 * equal regardless of property order.
 */
function canonicalInventoryJson(value: unknown): string {
  const encode = (v: unknown): unknown => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        throw new InventoryError("inventory action request is not JSON serializable");
      }
      return v;
    }
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(encode);
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const child = (v as Record<string, unknown>)[k];
        if (child !== undefined) out[k] = encode(child);
      }
      return out;
    }
    throw new InventoryError("inventory action request is not JSON serializable");
  };
  return JSON.stringify(encode(value));
}

export function inventoryRequestHash(value: unknown): string {
  return createHash("sha256").update(canonicalInventoryJson(value), "utf8").digest("hex");
}

/**
 * Read the key row from committed state without pinning anything: outside an
 * ambient transaction this is one isolated pooled read under the caller's RLS
 * context, so a waiter holds no client between polls.
 */
async function readCommittedInventoryKeyRow(
  orgId: string,
  actorId: string,
  operation: string,
  idempotencyKey: string,
): Promise<StoredInventoryKeyRow | null> {
  const r = (await db.execute<StoredInventoryKeyRow>(sql`
    select request_hash as "requestHash", response, completed_at as "completedAt"
      from application_idempotency_keys
     where org_id = ${orgId}
       and actor_id = ${actorId}
       and source = ${INVENTORY_ACTION_SOURCE}
       and operation = ${operation}
       and idempotency_key = ${idempotencyKey}
     limit 1`));
  return r.rows[0] ?? null;
}

/** Whether the claim advisory lock for this tuple is currently held. */
async function inventoryClaimLockHeld(
  orgId: string,
  operation: string,
  idempotencyKey: string,
): Promise<boolean> {
  const r = (await db.execute<{ held: boolean }>(sql`
    select exists (
      select 1 from pg_locks
       where locktype = 'advisory'
         and classid = hashtext(${orgId})::integer
         and objid = hashtext(${`${INVENTORY_ACTION_SOURCE}|${operation}|${idempotencyKey}`})::integer
    ) as held`));
  return !!r.rows[0]?.held;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute one mutating inventory action exactly once per (org, actor,
 * operation, key). Concurrent duplicates serialize on the claim advisory lock
 * and the table's unique identity index; the command and its stored response
 * commit atomically, so every replay after a commit returns byte-identical
 * evidence.
 */
export async function executeIdempotentInventoryAction<T>(
  orgId: string,
  actorId: string,
  action: IdempotentInventoryAction<T>,
): Promise<{ replayed: boolean; value: T }> {
  if (!INVENTORY_ACTION_OPERATION_RE.test(action.operation)) {
    throw new InventoryError(`invalid inventory action operation name: ${action.operation}`);
  }
  if (!action.idempotencyKey || !INVENTORY_ACTION_KEY_RE.test(action.idempotencyKey)) {
    // Fail closed: without a stable key a retried action would duplicate the
    // accounting unit, so a missing/invalid key never reaches the ledger.
    throw new InventoryError(
      "inventory actions require an idempotencyKey of 8-200 characters using letters, numbers, '.', '_', ':', or '-'",
    );
  }
  const { operation, idempotencyKey } = action;
  const hash = inventoryRequestHash(action.request);

  const assertMatchingPayload = (row: StoredInventoryKeyRow): void => {
    if (row.requestHash !== hash) {
      throw new InventoryIdempotencyConflictError(
        "idempotencyKey was already used with different input",
      );
    }
  };

  // Committed fast path: a finished attempt replays without opening any
  // transaction, and key reuse with different input fails closed first.
  const prior = await readCommittedInventoryKeyRow(orgId, actorId, operation, idempotencyKey);
  if (prior) {
    assertMatchingPayload(prior);
    if (prior.completedAt && prior.response !== null) {
      return { replayed: true, value: prior.response as T };
    }
  }

  // Claim the key and run the command. Returns undefined when a concurrent
  // attempt owns the claim; that transaction performed no writes, so releasing
  // it is free of side effects. withOrgTransaction pins ONE client whose
  // context makes nested db.transaction calls (receiveInventory, the voucher
  // posting, …) join this same transaction, so the command and its stored
  // response commit atomically — a crash can never leave money moved without
  // replay evidence.
  const claimAndExecute = (): Promise<{ replayed: boolean; value: T } | undefined> =>
    withOrgTransaction(orgId, async () => {
      const gate = (await db.execute<{ acquired: boolean }>(sql`
        select pg_try_advisory_xact_lock(
                 hashtext(${orgId}),
                 hashtext(${`${INVENTORY_ACTION_SOURCE}|${operation}|${idempotencyKey}`})
               ) as acquired`));
      if (!gate.rows[0]?.acquired) return undefined;

      const inserted = (await db.execute<{ id: string }>(sql`
        insert into application_idempotency_keys
          (org_id, actor_id, source, operation, idempotency_key, request_hash, expires_at)
        values
          (${orgId}, ${actorId}, ${INVENTORY_ACTION_SOURCE}, ${operation}, ${idempotencyKey}, ${hash},
           now() + interval '30 days')
        on conflict (org_id, actor_id, source, operation, idempotency_key)
        do nothing
        returning id`));
      if (inserted.rows.length === 0) return undefined;

      const value = await action.execute();
      let serialized: string;
      try {
        serialized = canonicalInventoryJson(value);
      } catch {
        throw new InventoryError("inventory action returned a non-JSON result");
      }
      await db.execute(sql`
        update application_idempotency_keys
           set response = ${serialized}::jsonb,
               completed_at = now()
         where org_id = ${orgId}
           and actor_id = ${actorId}
           and source = ${INVENTORY_ACTION_SOURCE}
           and operation = ${operation}
           and idempotency_key = ${idempotencyKey}`);
      return { replayed: false, value };
    });

  const claimed = await claimAndExecute();
  if (claimed) return claimed;

  // Lost the claim race: wait out the rival without pinning a client. The
  // response and completion stamp commit atomically, so a poll either sees
  // nothing yet or the final result — never a torn state.
  const deadline = Date.now() + RIVAL_POLL_BUDGET_MS;
  let delay = RIVAL_POLL_START_MS;
  for (;;) {
    const row = await readCommittedInventoryKeyRow(orgId, actorId, operation, idempotencyKey);
    if (row) {
      assertMatchingPayload(row);
      if (row.completedAt && row.response !== null) {
        return { replayed: true, value: row.response as T };
      }
    } else if (!(await inventoryClaimLockHeld(orgId, operation, idempotencyKey))) {
      // No committed row and nobody holds the claim lock: the rival rolled
      // back without executing durably, so the key was never burned. Take over.
      const retry = await claimAndExecute();
      if (retry) return retry;
      continue;
    }
    if (Date.now() + delay >= deadline) break;
    await sleep(Math.min(delay, Math.max(1, deadline - Date.now())) * (0.5 + Math.random()));
    delay = Math.min(delay * 2, RIVAL_POLL_MAX_MS);
  }
  throw new InventoryIdempotencyConflictError(
    "an identical inventory action is still in progress",
  );
}

export function normalizeMovementIdempotencyKey(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 500) {
    throw new InventoryError("inventory movement idempotency key must be between 1 and 500 characters");
  }
  return normalized;
}
