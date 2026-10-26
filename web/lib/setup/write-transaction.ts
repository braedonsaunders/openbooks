import "server-only";
import { lockAndCheckOrgFeature } from "@openbooks/engine/organization/features";
import { setupReferenceSubsidiarySource } from "./subsidiary-scope";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { lockLedgerSetupFence } from "@openbooks/engine/organization/ledger-setup";
import {
  setupEntitySubsidiaryField,
  setupEntitySubsidiaryReferenceFields,
  toSnake,
  type SetupEntity,
} from "./registry";
import { idColumn } from "./coerce";
import { featureGateLockKey, isFeatureEnabled } from "../features";
import {
  setupEntityEnabled,
  SetupWriteRefusal,
  typedSetupRefusal,
  type SetupTransaction,
} from "./write-shared";
import { validateEntityIntegrity } from "./write-integrity";

/** Recheck authoritative entity and field gates on the same transaction/connection
 * that writes configuration. Take this fence before any row or book locks. */
export async function setupWriteTransaction<T>(
  entity: SetupEntity,
  orgId: string,
  body: Record<string, unknown> | undefined,
  rowId: string | undefined,
  write: (tx: SetupTransaction) => Promise<T>,
  options: { idempotencyKey?: string; allowedSubsidiaryIds?: ReadonlySet<string> | null } = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    // Keep a policy change ordered with revaluation and consolidation pricing.
    // Ledger setup is locked before feature and organization state.
    if (
      [
        "fx-rate-age-policies",
        "fx-rate-types",
        "account-translation-policies",
        "subsidiary-accounting-preferences",
        "segment-balancing-policies",
        "gl-audit-number-policies",
        "segment-definitions",
      ].includes(entity.key)
    )
      await lockLedgerSetupFence(tx, orgId, "exclusive");
    // Same-key retries serialize here, before any create effect: the second
    // claimant blocks until the first commits, then replays off its audit.
    if (options.idempotencyKey) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"setup-create:" + options.idempotencyKey}, 0))`,
      );
    }
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${featureGateLockKey(orgId)}, 0))`,
    );
    if (!(await setupEntityEnabled(entity, orgId, tx)))
      throw new SetupWriteRefusal("unknown setup entity", 404);
    if (
      entity.key === "stock-locations" &&
      body &&
      body.inventoryOwnership !== undefined &&
      body.inventoryOwnership !== "owned" &&
      !(await lockAndCheckOrgFeature(tx, orgId, "consignment"))
    )
      throw new SetupWriteRefusal(
        "Turn on Consignment in Company Settings → Features before configuring external ownership",
        422,
      );
    const allowedSubsidiaryIds = options.allowedSubsidiaryIds;
    if (allowedSubsidiaryIds !== undefined && allowedSubsidiaryIds !== null) {
      const scopeField = setupEntitySubsidiaryField(entity);
      const allowed = new Set([...allowedSubsidiaryIds].map((id) => id.toLowerCase()));
      if (scopeField) {
        const column = toSnake(scopeField.key);
        let current: unknown;
        if (rowId) {
          const selected = await tx.execute<Record<string, unknown>>(
            sql`
            select ${sql.raw(column)} from ${sql.raw(entity.table)}
             where ${sql.raw(idColumn(entity))} = ${rowId}
               ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
             for update`,
            "objects",
          );
          if (!selected[0]) throw new SetupWriteRefusal("not found", 404);
          current = selected[0][column];
        }
        const requested =
          body && body[scopeField.key] !== undefined ? body[scopeField.key] : current;
        if (typeof requested !== "string" || !allowed.has(requested.toLowerCase())) {
          throw new SetupWriteRefusal("subsidiary is outside your allowed scope", 403);
        }
      }
      for (const field of setupEntitySubsidiaryReferenceFields(entity)) {
        const column = toSnake(field.key);
        let current: unknown;
        if (rowId && (!body || body[field.key] === undefined)) {
          const selected = await tx.execute<Record<string, unknown>>(
            sql`
            select ${sql.raw(column)} from ${sql.raw(entity.table)}
             where ${sql.raw(idColumn(entity))} = ${rowId}
               ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
             for update`,
            "objects",
          );
          if (!selected[0]) throw new SetupWriteRefusal("not found", 404);
          current = selected[0][column];
        }
        const requested = body && body[field.key] !== undefined ? body[field.key] : current;
        if (requested == null && !scopeField) {
          throw new SetupWriteRefusal(
            "Choose an owning record in your allowed employer scope",
            403,
          );
        }
        if (requested != null) {
          const target = setupReferenceSubsidiarySource(field.ref!, "scope_owner");
          const visible = await tx.execute<{ subsidiary_id: string | null }>(
            sql`
            select ${target.subsidiary} as subsidiary_id from ${target.from}
             where ${target.id}=${String(requested)} and ${target.org}=${orgId} for share
          `,
            "objects",
          );
          const sharedCustomer =
            field.ref === "einvoice-customers" && visible[0]?.subsidiary_id === null;
          if (
            !visible[0] ||
            (!sharedCustomer && !allowed.has(String(visible[0].subsidiary_id ?? "").toLowerCase()))
          ) {
            throw new SetupWriteRefusal(
              "The owning record is outside your allowed employer scope",
              403,
            );
          }
        }
      }
    }
    if (body) {
      let problem: string | null;
      try {
        problem = await validateEntityIntegrity(entity, body, orgId, rowId, tx);
      } catch (error) {
        const refusal = typedSetupRefusal(error);
        if (refusal) throw refusal;
        throw error;
      }
      if (problem) throw new SetupWriteRefusal(problem, problem === "not found" ? 404 : 400);
      if (
        entity.key === "item-rate-books" &&
        body.currency !== undefined &&
        !(await isFeatureEnabled(orgId, "multiCurrency", tx))
      ) {
        throw new SetupWriteRefusal("not found", 404);
      }
    }
    return write(tx);
  });
}
