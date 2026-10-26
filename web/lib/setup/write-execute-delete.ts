import "server-only";
import { isUuid } from "../list-params";
import { deleteHomeAnnouncementRow } from "./home-announcements";
import { sql } from "drizzle-orm";
import {
  assertStockLocationDeletionAllowed,
  WarehouseRefusal,
} from "@openbooks/engine/inventory/warehouses";
import { jobDescriptionDeleteRefusal } from "@openbooks/engine/hrm/recruiting/job-descriptions";
import { describeDbError, idColumn, pgErrorCode, setupAuditReason } from "./coerce";
import { auditSetupChange as audit, loadSetupAuditRow } from "./audit";
import {
  entityPermissionRefusal,
  resolveEntity,
  setupEntityEnabled,
  setupRefusalResult,
  setupScopeRefusal,
  SetupWriteRefusal,
  syncMembers,
  type SetupActor,
  type SetupWriteResult,
} from "./write-shared";
import { validateEntityIntegrity } from "./write-integrity";
import { setupWriteTransaction } from "./write-transaction";
import { bomCommandOnly, CARRIER_DELETE_REFUSAL, commandOwnedOnly } from "./write-preflight";

/** Delete (or archive) one setup record by id (DELETE semantics). */
export async function deleteSetupRecord(
  actor: SetupActor,
  entityKey: string,
  id: string,
  options: { reason?: string; auditReason?: string } = {},
): Promise<SetupWriteResult> {
  const { orgId, id: actorId } = actor;
  const scopeOptions = { allowedSubsidiaryIds: actor.allowedSubsidiaryIds };
  const entity = resolveEntity(entityKey);
  if (!entity) return { status: 404, body: { error: "unknown setup entity" } };
  if (!(await setupEntityEnabled(entity, orgId)))
    return { status: 404, body: { error: "unknown setup entity" } };
  const permissionRefusal = entityPermissionRefusal(actor, entity);
  if (permissionRefusal) return permissionRefusal;
  const scopeRefusal = setupScopeRefusal(actor, entity);
  if (scopeRefusal) return scopeRefusal;
  const auditReason = setupAuditReason({ ...entity, fields: [] }, options);
  if ("error" in auditReason)
    return { status: 400, body: { error: auditReason.error, code: "invalid" } };
  const owned = bomCommandOnly(entity);
  if (owned) return owned;
  const commanded = commandOwnedOnly(entity);
  if (commanded) return commanded;
  if (entity.key === "carriers") return CARRIER_DELETE_REFUSAL;
  if (entity.allowDelete === false)
    return { status: 405, body: { error: "Module setting history is preserved" } };
  if (entity.mutationPath)
    return {
      status: 405,
      body: {
        error: `This configuration must be saved through ${entity.mutationPath}, which validates the complete record.`,
      },
    };
  if (entity.readOnly) return { status: 405, body: { error: "read-only" } };
  if (entity.key === "accounting-books") {
    return { status: 405, body: { error: "archive-only" } };
  }

  // HR-15: home announcements delete from org settings JSON.
  if (entity.dataSource === "home-announcements") {
    try {
      await deleteHomeAnnouncementRow(orgId, id);
      return { status: 200, body: { ok: true } };
    } catch (error) {
      const status =
        error instanceof Error && "status" in error && error.status === 404 ? 404 : 400;
      return {
        status: status,
        body: { error: error instanceof Error ? error.message : "Invalid announcement" },
      };
    }
  }

  if (!id) return { status: 400, body: { error: "id required" } };
  if (idColumn(entity) === "id" && !isUuid(id)) {
    // A row no caller in this organization can see refuses exactly like the
    // update path's unknown row, so operators meet one wording.
    return { status: 404, body: { error: "not found" } };
  }

  const orgFilter = entity.orgScoped ? sql` and org_id = ${orgId}` : sql``;
  try {
    const found = await setupWriteTransaction(
      entity,
      orgId,
      undefined,
      id,
      async (tx) => {
        if (
          [
            "hrm-review-templates",
            "hrm-review-template-sections",
            "hrm-review-template-questions",
          ].includes(entity.key)
        ) {
          const refusal = await validateEntityIntegrity(entity, {}, orgId, id, tx);
          if (refusal) throw new SetupWriteRefusal(refusal, 409);
        }
        if (entity.key === "item-rate-books") {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`item-rate-books:${orgId}`}, 0))`,
          );
        }
        const before = await loadSetupAuditRow(entity, orgId, id, tx, true);
        if (!before) return false;
        if (entity.archiveOnDelete) {
          if (!entity.hasActive)
            throw new SetupWriteRefusal("This configuration has no retirement state", 409);
          if (before.is_active === false) return true;
          const refusal = await validateEntityIntegrity(entity, { isActive: false }, orgId, id, tx);
          if (refusal) throw new SetupWriteRefusal(refusal, 409);
          const retired = await tx.execute<Record<string, unknown>>(
            sql`update ${sql.raw(entity.table)}
          set is_active=false ${entity.actorCols ? sql`, updated_by=${actorId}, updated_at=now()` : sql``}
          where ${sql.raw(idColumn(entity))}=${id}${orgFilter} returning *`,
            "objects",
          );
          if (retired.length !== 1) return false;
          await audit(
            {
              orgId: entity.orgScoped ? orgId : null,
              table: entity.table,
              rowId: id,
              action: "update",
              changes: {
                before,
                after: retired[0],
                reason: auditReason.reason ?? "Archive configuration record",
              },
              actorId,
            },
            tx,
          );
          return true;
        }
        if (entity.key === "stock-locations")
          await assertStockLocationDeletionAllowed(tx, orgId, id);
        if (entity.key === "item-rate-books" && before.is_default)
          throw new Error("default-required");
        if (entity.key === "hrm-job-descriptions") {
          const refusal = await jobDescriptionDeleteRefusal(tx, orgId, id);
          if (refusal) throw new SetupWriteRefusal(refusal, 409);
        }
        if (entity.key === "account-groups") {
          const pinned = await tx.execute(
            sql`select 1 from account_group_members where group_id = ${id} and org_id = ${orgId} limit 1`,
            "objects",
          );
          if (pinned.length > 0)
            throw new SetupWriteRefusal(
              "account group still has pinned accounts — unpin or reassign them before deleting the group",
              409,
            );
        }
        // Memberships belong to this group. External references still refuse the
        // parent deletion and roll these removals back with the audit transaction.
        if (entity.key === "tax-groups") await syncMembers(orgId, id, [], tx);
        const deleted = await tx.execute(
          sql`
        delete from ${sql.raw(entity.table)}
         where ${sql.raw(idColumn(entity))} = ${id}${orgFilter}
        returning ${sql.raw(idColumn(entity))} as id`,
          "objects",
        );
        if (deleted.length === 0) return false;
        // The audit is part of the delete transaction. If audit_log rejects the
        // event, the setup row must roll back with it rather than disappearing
        // without evidence.
        await audit(
          {
            orgId: entity.orgScoped ? orgId : null,
            table: entity.table,
            rowId: id,
            action: "delete",
            changes: { before, ...auditReason },
            actorId,
          },
          tx,
        );
        return true;
      },
      scopeOptions,
    );
    // The delete touched no row in this organization — the same unknown-row
    // wording as the update path, never a bare machine code.
    if (!found) return { status: 404, body: { error: "not found" } };
    return { status: 200, body: { ok: true } };
  } catch (e) {
    if (e instanceof WarehouseRefusal) {
      return { status: e.status, body: { error: e.message, code: e.code, remedy: e.remedy } };
    }
    if (e instanceof SetupWriteRefusal) return setupRefusalResult(e);
    if (e instanceof Error && e.message === "default-required") {
      return { status: 409, body: { error: "default-required" } };
    }
    const databaseError = e as {
      constraint?: string;
      cause?: { constraint?: string; message?: string };
      message?: string;
    };
    if (
      [
        "pay_component_historical_policy",
        "depreciation_book_posted_policy",
        "time_type_historical_policy",
      ].includes(databaseError.cause?.constraint ?? databaseError.constraint ?? "")
    ) {
      return {
        status: 409,
        body: { error: databaseError.cause?.message ?? databaseError.message },
      };
    }
    // Foreign-key violation → the record is referenced elsewhere.
    if (pgErrorCode(e) === "23503") {
      return { status: 409, body: { error: "in-use", code: "in-use" } };
    }
    return { status: 400, body: { error: describeDbError(e) } };
  }
}
