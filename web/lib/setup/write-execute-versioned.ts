import "server-only";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { toSnake } from "./registry";

import { describeDbError, idColumn, multirefField, pgErrorCode } from "./coerce";

import { applyRuleSlotColumns } from "./hrm-rule-slots";

import { auditSetupChange as audit, loadSetupAuditRow } from "./audit";

import {
  bindSetupValue,
  comparableSetupValue,
  setupRefusalResult,
  SetupWriteRefusal,
  syncMembers,
  type SetupActor,
  type SetupWriteResult,
} from "./write-shared";

import { setupWriteTransaction } from "./write-transaction";

import { duplicateConflict } from "./write-conflicts";

import type { Coerced } from "./coerce";

import type { SetupEntity } from "./types";

/**
 * Versioned policy updates for pay-derived rules and recognition rules.
 *
 * A used recognition rule is priced history: the edit creates a successor
 * version instead of rewriting the row obligations already pin. Split from
 * the update module so each write module stays within the line bound.
 */
export async function updateVersionedSetupPolicies(args: {
  actorId: string;
  orgId: string;
  entity: SetupEntity;
  body: Record<string, unknown>;
  built: { cols: Coerced[] };
  id: string;
  scopeOptions: { allowedSubsidiaryIds: SetupActor["allowedSubsidiaryIds"] };
}): Promise<SetupWriteResult | null> {
  const { actorId, orgId, entity, body, built, id, scopeOptions } = args;
  if (entity.key === "pay-derived-rules") {
    // A rule is a policy snapshot. Once its effective window has been used by
    // payroll, changing its pricing/filter columns would restate that period.
    // Close the previous window and insert a successor instead. Activation and
    // a deliberate window close remain in-place operations; they do not alter
    // the policy that historical periods resolve.
    const policyColumns = [
      "name",
      "component_id",
      "trigger",
      "time_type_id",
      "project_id",
      "department_id",
      "equipment_unit_id",
      "item_id",
      "trade_id",
      "job_title",
      "billable_only",
      "included_job_titles",
      "excluded_job_titles",
      "quantity_mode",
      "rate_mode",
      "rate_value",
      "costing_mode",
      "effective_from",
      "sequence",
    ];
    const builtByColumn = new Map(built.cols.map((column) => [column.column, column.value]));
    try {
      const versionId = await setupWriteTransaction(
        entity,
        orgId,
        body,
        id,
        async (tx) => {
          const currentRes = await tx.execute(
            sql`
          select * from pay_derived_rules
           where id = ${id} and org_id = ${orgId}
           for update`,
            "objects",
          );
          const current = currentRes[0] as Record<string, unknown> | undefined;
          if (!current) throw new Error("not found");

          const valueFor = (column: string) =>
            builtByColumn.has(column) ? builtByColumn.get(column) : current[column];
          const changedPolicy = policyColumns.some(
            (column) =>
              comparableSetupValue(valueFor(column)) !== comparableSetupValue(current[column]),
          );

          if (!changedPolicy) {
            const updated = await tx.execute(
              sql`
            update pay_derived_rules set
              ${sql.join(
                built.cols.map(
                  (column) => sql`${sql.raw(column.column)} = ${bindSetupValue(column.value)}`,
                ),
                sql`, `,
              )},
              updated_at = now(), updated_by = ${actorId}
             where id = ${id} and org_id = ${orgId}
            returning id`,
              "objects",
            );
            if (!updated.length) throw new Error("not found");
            await audit(
              {
                orgId,
                table: entity.table,
                rowId: id,
                action: "update",
                changes: { before: current, after: await loadSetupAuditRow(entity, orgId, id, tx) },
                actorId,
              },
              tx,
            );
            return id;
          }

          const effectiveFrom = String(valueFor("effective_from") ?? "");
          const priorEffectiveFrom = String(current.effective_from ?? "");
          if (!effectiveFrom || effectiveFrom <= priorEffectiveFrom) {
            throw new Error("effective-from-must-follow-current");
          }
          const effectiveTo = valueFor("effective_to");
          if (effectiveTo != null && String(effectiveTo) < effectiveFrom) {
            throw new Error("effective-to-before-effective-from");
          }

          // If the old row is open (or reaches into the successor's start), its
          // inclusive range ends the day before the new version begins. A lapsed
          // row is left untouched so its original historical window remains an
          // exact record of what was configured.
          const priorEffectiveTo =
            current.effective_to == null ? null : String(current.effective_to);
          const closesPrior = priorEffectiveTo == null || priorEffectiveTo >= effectiveFrom;
          if (closesPrior) {
            await tx.execute(sql`
            update pay_derived_rules
               set effective_to = (${effectiveFrom}::date - 1),
                   updated_at = now(), updated_by = ${actorId}
             where id = ${id} and org_id = ${orgId}
          `);
          }

          const successorColumns = [
            "org_id",
            "code",
            ...policyColumns.slice(0, policyColumns.indexOf("effective_from")),
            "effective_from",
            "effective_to",
            "sequence",
            "is_active",
            "created_by",
            "updated_by",
          ];
          const successorValues = successorColumns.map((column) => {
            if (column === "org_id") return sql`${orgId}`;
            if (column === "code") return sql`${String(current.code)}`;
            if (column === "effective_to") return sql`${effectiveTo ?? null}`;
            if (column === "created_by" || column === "updated_by") return sql`${actorId}`;
            if (column === "is_active") return sql`${valueFor("is_active")}`;
            if (column === "included_job_titles" || column === "excluded_job_titles") {
              const titles = valueFor(column);
              return sql`${typeof titles === "string" ? titles : JSON.stringify(titles)}::jsonb`;
            }
            return sql`${bindSetupValue(valueFor(column) ?? null)}`;
          });
          const inserted = await tx.execute(
            sql`
          insert into pay_derived_rules (${sql.raw(successorColumns.join(", "))})
          values (${sql.join(successorValues, sql`, `)})
          returning id`,
            "objects",
          );
          if (inserted.length !== 1)
            throw new Error("a successor derived rule version could not be created");
          const successorId = String(inserted[0]!.id);

          // Request match image for the successor insert audit, mirroring the
          // POST path: the exact coerced columns the insert stores (actor
          // context included), so the evidence names the request it came from.
          const successorMatch: Record<string, unknown> = {};
          for (const column of successorColumns) {
            if (column === "org_id") successorMatch[column] = orgId;
            else if (column === "code") successorMatch[column] = String(current.code);
            else if (column === "created_by" || column === "updated_by")
              successorMatch[column] = actorId;
            else if (column === "effective_to") successorMatch[column] = effectiveTo ?? null;
            else successorMatch[column] = valueFor(column) ?? null;
          }

          if (closesPrior) {
            await audit(
              {
                orgId,
                table: entity.table,
                rowId: id,
                action: "update",
                changes: { before: current, after: await loadSetupAuditRow(entity, orgId, id, tx) },
                actorId,
              },
              tx,
            );
          }
          await audit(
            {
              orgId,
              table: entity.table,
              rowId: successorId,
              action: "insert",
              changes: {
                after: await loadSetupAuditRow(entity, orgId, successorId, tx),
                match: successorMatch,
              },
              actorId,
            },
            tx,
          );
          return successorId;
        },
        scopeOptions,
      );
      return { status: 200, body: { id: versionId } };
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return setupRefusalResult(e);
      const code = pgErrorCode(e);
      if (code === "23505" || code === "23P01") {
        return duplicateConflict(entity.key);
      }
      const message = (e as Error).message;
      if (message === "not found") return { status: 404, body: { error: message } };
      if (message === "effective-from-must-follow-current") {
        return {
          status: 400,
          body: { error: "A changed derived rule must start after its current effective date" },
        };
      }
      if (message === "effective-to-before-effective-from") {
        return { status: 400, body: { error: "effectiveTo cannot precede effectiveFrom" } };
      }
      return { status: 400, body: { error: describeDbError(e) } };
    }
  }

  if (entity.key === "recognition-rules") {
    // A rule is priced history once any obligation references it: rebuilding
    // that obligation's unposted schedule (or snapshotting it for amendment)
    // reads the pinned rule row, so changing the policy in place would
    // silently reprice and retime earned revenue. A policy edit on a used
    // rule therefore creates a successor version (same code, version + 1)
    // that new obligations use; items repoint at the successor while
    // existing obligations keep their pinned row. Name and active-flag edits
    // — and any edit to an unused rule — stay in place.
    const policyColumns = [
      "method",
      "is_forecast",
      "recognition_periods",
      "start_date_source",
      "end_date_source",
      "period_offset",
      "start_offset_days",
      "initial_amount_percent",
      "deferred_account_id",
      "recognized_account_id",
    ];
    const builtByColumn = new Map(built.cols.map((column) => [column.column, column.value]));
    try {
      const versionId = await setupWriteTransaction(
        entity,
        orgId,
        body,
        id,
        async (tx) => {
          const currentRes = await tx.execute(
            sql`
          select * from recognition_rules
           where id = ${id} and org_id = ${orgId}
           for update`,
            "objects",
          );
          const current = currentRes[0] as Record<string, unknown> | undefined;
          if (!current) throw new Error("not found");

          // Omission is not a change: buildRow materializes unsubmitted
          // nullable fields as explicit nulls, so only a submitted field can
          // move the policy. A submitted blank that buildRow omits likewise
          // leaves the stored value alone.
          const valueFor = (column: string) => {
            const key = entity.fields.find((f) => toSnake(f.key) === column)?.key;
            if (key === undefined || body[key] === undefined) return current[column];
            if (!builtByColumn.has(column)) return current[column];
            return builtByColumn.get(column);
          };
          const changedPolicy = policyColumns.some(
            (column) =>
              comparableSetupValue(valueFor(column)) !== comparableSetupValue(current[column]),
          );
          const used =
            (
              await tx.execute(
                sql`
          select 1 from performance_obligations
           where org_id = ${orgId} and recognition_rule_id = ${id}
           limit 1`,
                "objects",
              )
            ).length > 0;

          if (!changedPolicy || !used) {
            const slotted = applyRuleSlotColumns(entity.key, body, built.cols);
            if ("error" in slotted) throw new SetupWriteRefusal(slotted.error, 400);
            // Write exactly the submitted fields: an omitted nullable field
            // must not be nulled out as a side effect of an unrelated edit.
            // (The drawer always submits full bodies, so it sees no change.)
            const submittedCols = slotted.cols.filter((c) => {
              const key = entity.fields.find((f) => toSnake(f.key) === c.column)?.key;
              return key !== undefined && body[key] !== undefined;
            });
            const setParts = submittedCols.map(
              (c) => sql`${sql.raw(c.column)} = ${bindSetupValue(c.value)}`,
            );
            if (entity.actorCols) {
              setParts.push(sql`updated_by = ${actorId}`);
              setParts.push(sql`updated_at = now()`);
            }
            if (setParts.length === 0) throw new SetupWriteRefusal("nothing to update", 400);
            const before = await loadSetupAuditRow(entity, orgId, id, tx, true);
            if (!before) throw new Error("not found");
            const updated = await tx.execute(
              sql`
            update ${sql.raw(entity.table)} set ${sql.join(setParts, sql`, `)}
             where ${sql.raw(idColumn(entity))} = ${id} and org_id = ${orgId}
            returning ${sql.raw(idColumn(entity))} as id`,
              "objects",
            );
            if (updated.length === 0) throw new Error("not found");
            const members = multirefField(entity);
            if (members && Array.isArray(body[members.key])) {
              await syncMembers(orgId, id, (body[members.key] as unknown[]).map(String), tx);
            }
            const after = await loadSetupAuditRow(entity, orgId, id, tx);
            await audit(
              {
                orgId,
                table: entity.table,
                rowId: id,
                action: "update",
                changes: { before, after },
                actorId,
              },
              tx,
            );
            return id;
          }

          // The successor id is client-generated so the old row can be closed
          // first: at most one unsurpassed row may carry the code (the partial
          // unique index), while the old row's forward link needs its target.
          // The self-reference is deferrable, so both constraints are checked
          // at commit, when the chain is whole again.
          const successorId = randomUUID();
          await tx.execute(sql`SET CONSTRAINTS recognition_rules_superseded_by_fkey DEFERRED`);
          await tx.execute(sql`
          update recognition_rules
             set superseded_by = ${successorId},
                 is_active = false,
                 updated_at = now(), updated_by = ${actorId}
           where id = ${id} and org_id = ${orgId}`);
          const successorColumns = [
            "id",
            "org_id",
            "code",
            "version",
            "name",
            "method",
            "is_forecast",
            "recognition_periods",
            "start_date_source",
            "end_date_source",
            "period_offset",
            "start_offset_days",
            "initial_amount_percent",
            "deferred_account_id",
            "recognized_account_id",
            "is_active",
            "created_by",
            "updated_by",
          ];
          const version = Number(current.version ?? 1) + 1;
          const successorValues = successorColumns.map((column) => {
            if (column === "id") return sql`${successorId}`;
            if (column === "org_id") return sql`${orgId}`;
            if (column === "code") return sql`${String(current.code)}`;
            if (column === "version") return sql`${version}`;
            if (column === "created_by" || column === "updated_by") return sql`${actorId}`;
            return sql`${valueFor(column) ?? null}`;
          });
          const inserted = await tx.execute(
            sql`
          insert into recognition_rules (${sql.raw(successorColumns.join(", "))})
          values (${sql.join(successorValues, sql`, `)})
          returning id`,
            "objects",
          );
          if (inserted.length !== 1)
            throw new Error("a successor rule version could not be created");
          await tx.execute(sql`
          update items
             set recognition_rule_id = ${successorId},
                 updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and recognition_rule_id = ${id}`);

          // Request match image for the successor insert audit, mirroring the
          // POST path: the exact coerced columns the insert stores (actor
          // context included), so the evidence names the request it came from.
          const successorMatch: Record<string, unknown> = {};
          for (const column of successorColumns) {
            if (column === "id") continue;
            if (column === "org_id") successorMatch[column] = orgId;
            else if (column === "code") successorMatch[column] = String(current.code);
            else if (column === "version") successorMatch[column] = version;
            else if (column === "created_by" || column === "updated_by")
              successorMatch[column] = actorId;
            else successorMatch[column] = valueFor(column) ?? null;
          }

          await audit(
            {
              orgId,
              table: entity.table,
              rowId: id,
              action: "update",
              changes: { before: current, after: await loadSetupAuditRow(entity, orgId, id, tx) },
              actorId,
            },
            tx,
          );
          await audit(
            {
              orgId,
              table: entity.table,
              rowId: successorId,
              action: "insert",
              changes: {
                after: await loadSetupAuditRow(entity, orgId, successorId, tx),
                match: successorMatch,
              },
              actorId,
            },
            tx,
          );
          return successorId;
        },
        scopeOptions,
      );
      return { status: 200, body: { id: versionId } };
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return setupRefusalResult(e);
      const code = pgErrorCode(e);
      if (code === "23505" || code === "23P01") {
        return duplicateConflict(entity.key);
      }
      const message = (e as Error).message;
      if (message === "not found") return { status: 404, body: { error: message } };
      return { status: 400, body: { error: describeDbError(e) } };
    }
  }
  return null;
}
