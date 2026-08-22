import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/src/db.ts";
import type { ApplicationContext } from "./context";
import { conflict, invalidInput } from "./errors";
import {
  NonJsonValueError,
  requestHash,
  toJsonValue,
} from "./idempotency-core";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
const OPERATION_NAME = /^[a-z][a-z0-9_.-]{2,99}$/;

/**
 * Execute one mutating command exactly once for an actor/key tuple.
 * Concurrent duplicate requests serialize on the unique index. The command
 * and stored response commit atomically; failures roll back both.
 */
export async function executeIdempotent<T>(args: {
  context: ApplicationContext;
  operation: string;
  idempotencyKey: string;
  request: unknown;
  execute: () => Promise<T>;
}): Promise<{ replayed: boolean; value: T }> {
  if (!OPERATION_NAME.test(args.operation)) {
    throw new Error(`invalid application operation name: ${args.operation}`);
  }
  if (!IDEMPOTENCY_KEY.test(args.idempotencyKey)) {
    throw invalidInput(
      "idempotencyKey must be 8-200 characters using letters, numbers, '.', '_', ':', or '-'",
    );
  }

  const context = args.context;
  let hash: string;
  try {
    hash = requestHash(args.request);
  } catch (error) {
    if (error instanceof NonJsonValueError) {
      throw invalidInput("request is not JSON serializable");
    }
    throw error;
  }
  return withOrgTransaction(context.authz.user.orgId, async () => {
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into application_idempotency_keys
        (org_id, actor_id, source, operation, idempotency_key, request_hash,
         expires_at)
      values
        (${context.authz.user.orgId}, ${context.authz.user.id}, ${context.source},
         ${args.operation}, ${args.idempotencyKey}, ${hash},
         now() + interval '30 days')
      on conflict (org_id, actor_id, source, operation, idempotency_key)
      do nothing
      returning id
    `));

    if (inserted.rows.length === 0) {
      const prior = (await db.execute<{ requestHash: string; response: T | null; completedAt: Date | null }>(sql`
        select request_hash as "requestHash", response, completed_at as "completedAt"
          from application_idempotency_keys
         where org_id = ${context.authz.user.orgId}
           and actor_id = ${context.authz.user.id}
           and source = ${context.source}
           and operation = ${args.operation}
           and idempotency_key = ${args.idempotencyKey}
         for update
      `));
      const row = prior.rows[0];
      if (!row) throw conflict("idempotency state changed; retry the request");
      if (row.requestHash !== hash) {
        throw conflict("idempotencyKey was already used with different input");
      }
      if (!row.completedAt || row.response === null) {
        throw conflict("an identical operation is still in progress");
      }
      return { replayed: true, value: row.response };
    }

    const value = await args.execute();
    let serializable;
    try {
      serializable = toJsonValue(value);
    } catch (error) {
      if (error instanceof NonJsonValueError) {
        throw new Error("application operation returned a non-JSON value");
      }
      throw error;
    }
    await db.execute(sql`
      update application_idempotency_keys
         set response = ${JSON.stringify(serializable)}::jsonb,
             completed_at = now()
       where id = ${inserted.rows[0]!.id} and org_id = ${context.authz.user.orgId}
    `);
    return { replayed: false, value };
  });
}
