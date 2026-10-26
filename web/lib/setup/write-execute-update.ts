import "server-only";
import { validateSubcontractLocationConfiguration } from "@openbooks/engine/inventory/subcontract-custody";

import { isUuid } from "../list-params";

import { saveExtensionSettingRow } from "./extension-settings";

import { saveHomeAnnouncementRow } from "./home-announcements";

import { sql } from "drizzle-orm";

import { CurrencyError } from "@openbooks/engine/fx/currencies";

import { withOrgTransaction } from "@openbooks/engine/platform/db";

import { rescopePayScheduleRuns } from "@openbooks/engine/payroll/run-lifecycle";

import {
  buildRow,
  coerceBoolean,
  describeDbError,
  idColumn,
  multirefField,
  pgErrorCode,
  scaleShapeCheckRefusal,
  carrierCheckRefusal,
  shippingCheckRefusal,
  setupAuditReason,
} from "./coerce";

import { normalizeHrmProcessTemplateInput } from "./hrm-process-template";

import { normalizeHrmPipelineStageInput } from "./hrm-pipeline";

import {
  HrmReviewTemplateScaleError,
  normalizeHrmReviewTemplateInput,
} from "./hrm-review-template";

import { normalizeHrmCompensationInput } from "./hrm-compensation";

import { normalizeHrmBenefitPlanInput } from "./hrm-benefits";

import { normalizeHrmLeavePolicyInput } from "./hrm-leave-policy";

import { normalizeHrmDocumentTemplateInput } from "./hrm-document-template";

import { applyRuleSlotColumns } from "./hrm-rule-slots";

import { normalizeTaxReturnFormInput } from "./tax-return-form";

import { saveSetupBook } from "./books";

import {
  deactivateUsageMeter,
  reactivateUsageMeter,
  updateUsageMeter,
  type UsageAggregation,
} from "@openbooks/engine/billing/usage/records";

import { retireUsageRatingPlan } from "@openbooks/engine/billing/usage/rating-plans";

import { UsageBillingError } from "@openbooks/engine/billing/usage/errors";

import { EntitlementError, updateSaasFeature } from "@openbooks/engine/billing";

import { auditSetupChange as audit, loadSetupAuditRow } from "./audit";

import { isFeatureEnabled, subsidiaryFeatureEnabled } from "../features";

import { numberSequenceStoredCols } from "./number-sequence-position";

import {
  bindSetupValue,
  entityForValidation,
  entityPermissionRefusal,
  integrityDatabaseRefusal,
  persistFxRateCols,
  resolveEntity,
  savePayComponentEarningClassification,
  setupDomainRefusal,
  setupEntityEnabled,
  setupRefusalResult,
  setupScopeRefusal,
  SetupWriteRefusal,
  syncMembers,
  writableSetupEntity,
  type SetupActor,
  type SetupWriteResult,
} from "./write-shared";

import { validateEntityIntegrity } from "./write-integrity";

import { setupWriteTransaction } from "./write-transaction";

import { bomCommandOnly, commandOwnedOnly } from "./write-preflight";

import { duplicateConflict, guardLeavePolicyWindow, overlapConflict } from "./write-conflicts";

import { updateVersionedSetupPolicies } from "./write-execute-versioned";

/** Update one setup record; `rawBody.id` addresses the row (PATCH semantics). */
export async function updateSetupRecord(
  actor: SetupActor,
  entityKey: string,
  rawBody: Record<string, unknown>,
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
  const owned = bomCommandOnly(entity);
  if (owned) return owned;
  const commanded = commandOwnedOnly(entity);
  if (commanded) return commanded;
  if (entity.mutationPath)
    return {
      status: 405,
      body: {
        error: `This configuration must be saved through ${entity.mutationPath}, which validates the complete record.`,
      },
    };
  if (entity.allowUpdate === false)
    return {
      status: 405,
      body: {
        error:
          "Configuration history is preserved; create a new record with its effective date to change this policy",
      },
    };
  if (entity.readOnly) return { status: 405, body: { error: "read-only" } };

  let reviewFolded: Record<string, unknown>;
  try {
    reviewFolded = normalizeHrmReviewTemplateInput(
      entity.key,
      normalizeHrmCompensationInput(
        entity.key,
        normalizeHrmProcessTemplateInput(
          entity.key,
          normalizeTaxReturnFormInput(entity.key, rawBody),
        ),
      ),
    );
  } catch (error) {
    if (error instanceof HrmReviewTemplateScaleError) {
      return { status: 400, body: { error: error.message, code: "invalid" } };
    }
    throw error;
  }
  const body = normalizeHrmDocumentTemplateInput(
    entity.key,
    normalizeHrmBenefitPlanInput(
      entity.key,
      normalizeHrmPipelineStageInput(
        entity.key,
        normalizeHrmLeavePolicyInput(entity.key, reviewFolded),
      ),
    ),
  );
  const auditReason = setupAuditReason(entity, body);
  if ("error" in auditReason)
    return { status: 400, body: { error: auditReason.error, code: "invalid" } };
  if (entity.key === "pay-components" && Object.hasOwn(body, "vacationable")) {
    return {
      status: 409,
      body: {
        code: "creation_only_vacation_default",
        error:
          "The component vacation flag is a creation-only default. Change vacation-base inclusion through a dated component statutory treatment in Payroll Setup.",
      },
    };
  }
  const id = String(body.id ?? "");
  if (!id) return { status: 400, body: { error: "id required" } };
  if (entity.dataSource !== "extension-settings" && idColumn(entity) === "id" && !isUuid(id)) {
    return { status: 404, body: { error: "not_found" } };
  }

  if (entity.dataSource === "extension-settings") {
    try {
      return {
        status: 200,
        body: await saveExtensionSettingRow(orgId, actorId, [...actor.permissions], body),
      };
    } catch (error) {
      const status =
        error instanceof Error && "status" in error && error.status === 409 ? 409 : 400;
      return {
        status: status,
        body: { error: error instanceof Error ? error.message : "Invalid module setting" },
      };
    }
  }

  // HR-15: home announcements live in org settings JSON, not a table.
  if (entity.dataSource === "home-announcements") {
    try {
      return { status: 200, body: await saveHomeAnnouncementRow(orgId, id, body) };
    } catch (error) {
      const status =
        error instanceof Error && "status" in error && error.status === 404 ? 404 : 400;
      return {
        status: status,
        body: { error: error instanceof Error ? error.message : "Invalid announcement" },
      };
    }
  }

  const multiCurrency = await isFeatureEnabled(orgId, "multiCurrency");
  const writableEntity = writableSetupEntity(entity, {
    multiSubsidiary: await subsidiaryFeatureEnabled(orgId),
    equipment: await isFeatureEnabled(orgId, "equipment"),
    fieldTickets: await isFeatureEnabled(orgId, "fieldTickets"),
    einvoicing: await isFeatureEnabled(orgId, "einvoicing"),
  });
  // Rate-book currency is Multi-currency configuration. When that switch is
  // off the update descriptor must not require the field, so omitting it
  // keeps the stored book instead of a 400.
  const patchEntity =
    entity.key === "item-rate-books" && !multiCurrency
      ? {
          ...writableEntity,
          fields: writableEntity.fields.filter((field) => field.key !== "currency"),
        }
      : writableEntity;
  // Same folded-slot cover as the create path: the normalizer ran above.
  const built = buildRow(await entityForValidation(patchEntity, orgId), body, {
    forCreate: false,
    coverFoldedSlots: true,
  });
  if ("error" in built) return { status: 400, body: { error: built.error, code: "invalid" } };
  let integrityError: string | null;
  try {
    integrityError = await validateEntityIntegrity(entity, body, orgId, id);
  } catch (error) {
    const refusal = setupDomainRefusal(error) ?? integrityDatabaseRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
  if (integrityError) {
    if (integrityError === "not found") return { status: 404, body: { error: integrityError } };
    // Typed user-correctable failure: the code lets surfaces map
    // stably while the message reads as user language.
    return { status: 400, body: { error: integrityError, code: "invalid" } };
  }

  if (entity.key === "accounting-books") {
    try {
      await setupWriteTransaction(
        entity,
        orgId,
        body,
        id,
        (tx) => saveSetupBook(entity, orgId, actorId, body, tx, { id }),
        scopeOptions,
      );
      return { status: 200, body: { id } };
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return setupRefusalResult(e);
      const message = (e as Error).message;
      const error =
        message === "primary-required" ||
        message === "primary-active-required" ||
        message === "not found"
          ? message
          : describeDbError(e);
      return { status: error === "not found" ? 404 : 400, body: { error } };
    }
  }

  if (entity.key === "item-rate-books") {
    // Rate-book currency is Multi-currency configuration. Turning that
    // switch off must refuse a write; omitting currency keeps the
    // stored book.
    if (body.currency !== undefined && !multiCurrency) {
      return { status: 404, body: { error: "not_found" } };
    }
    try {
      await setupWriteTransaction(
        entity,
        orgId,
        body,
        id,
        (tx) => saveSetupBook(entity, orgId, actorId, body, tx, { id }),
        scopeOptions,
      );
      return { status: 200, body: { id } };
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return setupRefusalResult(e);
      const message = (e as Error).message;
      const error = ["not found", "default-required"].includes(message)
        ? message
        : describeDbError(e);
      return { status: error === "not found" ? 404 : 400, body: { error } };
    }
  }

  if (
    entity.key === "usage-meters" ||
    entity.key === "usage-rating-plans" ||
    entity.key === "saas-features"
  ) {
    try {
      await withOrgTransaction(orgId, () =>
        setupWriteTransaction(
          entity,
          orgId,
          body,
          id,
          async (tx) => {
            const before = await loadSetupAuditRow(entity, orgId, id, tx, true);
            if (!before) throw new SetupWriteRefusal("not found", 404);
            if (entity.key === "saas-features") {
              // The feature type prices every grant ever written: changing it
              // would reinterpret history, so the engine refuses it and the
              // operator creates a new feature instead.
              if (
                body.featureType !== undefined &&
                String(body.featureType) !== String(before.feature_type)
              ) {
                throw new EntitlementError(
                  "entitlement_type_immutable",
                  "A feature type cannot change after creation.",
                  "Create a new feature with the desired type.",
                  { field: "featureType", status: 409 },
                );
              }
              const input = {
                ...(body.name === undefined ? {} : { name: String(body.name) }),
                ...(body.description === undefined
                  ? {}
                  : {
                      description:
                        body.description == null || body.description === ""
                          ? null
                          : String(body.description),
                    }),
                ...(body.unit === undefined
                  ? {}
                  : { unit: body.unit == null || body.unit === "" ? null : String(body.unit) }),
                ...(body.meterKey === undefined
                  ? {}
                  : {
                      meterKey:
                        body.meterKey == null || body.meterKey === ""
                          ? null
                          : String(body.meterKey),
                    }),
              };
              if (Object.keys(input).length) await updateSaasFeature(orgId, actorId, id, input);
              if (body.isActive !== undefined) {
                const active = coerceBoolean(body.isActive);
                if (active !== Boolean(before.is_active)) {
                  await updateSaasFeature(orgId, actorId, id, { isActive: active });
                }
              }
              if (Object.keys(input).length === 0 && body.isActive === undefined) {
                await updateSaasFeature(orgId, actorId, id, {});
              }
            } else if (entity.key === "usage-meters") {
              const input = {
                ...(body.key === undefined ? {} : { key: String(body.key) }),
                ...(body.name === undefined ? {} : { name: String(body.name) }),
                ...(body.unit === undefined ? {} : { unit: String(body.unit) }),
                ...(body.aggregation === undefined
                  ? {}
                  : { aggregation: body.aggregation as UsageAggregation }),
                ...(body.itemId === undefined
                  ? {}
                  : {
                      itemId:
                        body.itemId == null || body.itemId === "" ? null : String(body.itemId),
                    }),
              };
              if (Object.keys(input).length) await updateUsageMeter(orgId, actorId, id, input);
              if (body.isActive !== undefined) {
                const active = coerceBoolean(body.isActive);
                if (active !== Boolean(before.is_active)) {
                  if (active) await reactivateUsageMeter(orgId, actorId, id);
                  else await deactivateUsageMeter(orgId, actorId, id);
                }
              }
              if (Object.keys(input).length === 0 && body.isActive === undefined)
                await updateUsageMeter(orgId, actorId, id, {});
            } else {
              if (body.name !== undefined && String(body.name) !== String(before.name)) {
                throw new UsageBillingError(
                  "usage_plan_name_immutable",
                  "A rating plan name cannot change after creation.",
                  "Create a new usage rating plan with the desired name.",
                  { field: "name", status: 409 },
                );
              }
              if (
                body.currency !== undefined &&
                String(body.currency) !== String(before.currency_code)
              ) {
                throw new UsageBillingError(
                  "usage_plan_currency_immutable",
                  "A rating plan currency cannot change after creation.",
                  "Create a new usage rating plan with the desired currency.",
                  { field: "currency", status: 409 },
                );
              }
              if (body.status === "retired" && before.status === "active")
                await retireUsageRatingPlan(orgId, actorId, id);
              else if (body.status === "active" && before.status === "retired") {
                throw new UsageBillingError(
                  "usage_plan_reactivation_refused",
                  "A retired usage rating plan cannot be reactivated.",
                  "Create a new usage rating plan.",
                  { field: "status", status: 409 },
                );
              }
            }
            await audit(
              {
                orgId,
                table: entity.table,
                rowId: id,
                action: "update",
                changes: { before, after: await loadSetupAuditRow(entity, orgId, id, tx) },
                actorId,
              },
              tx,
            );
          },
          scopeOptions,
        ),
      );
      return { status: 200, body: { id } };
    } catch (error) {
      if (error instanceof SetupWriteRefusal)
        return { status: error.status, body: { error: error.message } };
      if (error instanceof UsageBillingError) {
        return {
          status: error.status,
          body: {
            error: error.message,
            code: error.code,
            remedy: error.remedy,
            field: error.field,
          },
        };
      }
      if (error instanceof EntitlementError) {
        return {
          status: error.status,
          body: {
            error: error.message,
            code: error.code,
            remedy: error.remedy,
            field: error.field,
          },
        };
      }
      return { status: 400, body: { error: describeDbError(error) } };
    }
  }

  const versioned = await updateVersionedSetupPolicies({
    actorId,
    orgId,
    entity,
    body,
    built,
    id,
    scopeOptions,
  });
  if (versioned) return versioned;

  const slottedUpdate = applyRuleSlotColumns(entity.key, body, built.cols);
  if ("error" in slottedUpdate) return { status: 400, body: { error: slottedUpdate.error } };
  const supplementalWageCategoryUpdate = slottedUpdate.cols.find(
    (column) => column.column === "supplemental_wage_category",
  )?.value;
  const statutoryReportingCategoryUpdate = slottedUpdate.cols.find(
    (column) => column.column === "statutory_reporting_category",
  )?.value;
  const statutoryExemptionCategoryUpdate = slottedUpdate.cols.find(
    (column) => column.column === "statutory_exemption_category",
  )?.value;
  let updateCols =
    entity.key === "fx-rates"
      ? slottedUpdate.cols.filter(
          (column) => !["source", "provider_config_id", "imported_at"].includes(column.column),
        )
      : slottedUpdate.cols;
  if (entity.key === "pay-components") {
    updateCols = updateCols.filter(
      (column) =>
        column.column !== "supplemental_wage_category" &&
        column.column !== "statutory_reporting_category" &&
        column.column !== "statutory_exemption_category",
    );
  }
  if (entity.key === "leave-policies") {
    // The change reason rides into the audit image, never into a column —
    // hrm_leave_policies has no reason column.
    updateCols = updateCols.filter((column) => column.column !== "reason");
  }
  if (entity.key === "fx-rates" || entity.key === "consolidated-fx-rates") {
    try {
      updateCols = persistFxRateCols(updateCols);
    } catch (error) {
      return {
        status: 400,
        body: {
          error:
            error instanceof CurrencyError
              ? error.message
              : "Exchange rates must be an exact decimal",
        },
      };
    }
  }
  if (entity.key === "number-sequences") updateCols = numberSequenceStoredCols(updateCols);
  const setParts = updateCols.map((c) => sql`${sql.raw(c.column)} = ${bindSetupValue(c.value)}`);
  if (entity.key === "fx-rates") {
    // Any human edit is an explicit override. Provider synchronization never
    // replaces manual rows, so detach the imported provenance atomically.
    setParts.push(sql`source = 'manual'`);
    setParts.push(sql`provider_config_id = null`);
    setParts.push(sql`imported_at = null`);
  }
  if (entity.actorCols) {
    setParts.push(sql`updated_by = ${actorId}`);
    setParts.push(sql`updated_at = now()`);
  }
  if (setParts.length === 0) return { status: 400, body: { error: "nothing to update" } };

  const orgFilter = entity.orgScoped ? sql` and org_id = ${orgId}` : sql``;
  // A pay-schedule re-scope re-resolves the schedule's uncommitted runs in
  // the same transaction. The outcome (and any warning) travels out through
  // this binding because the transaction callback's boolean cannot carry it.
  let scheduleRescope: {
    reresolved: number;
    untouched: number;
    skipped?: { documentId: string; documentNumber: string | null; reason: string }[];
    warning?: string;
  } | null = null;
  try {
    const found = await setupWriteTransaction(
      entity,
      orgId,
      body,
      id,
      async (tx) => {
        if (entity.key === "stock-locations")
          await validateSubcontractLocationConfiguration(tx, orgId, actorId, body, id);
        const before = await loadSetupAuditRow(entity, orgId, id, tx, true);
        if (!before) return false;
        if (entity.key === "leave-policies") {
          // Window, target, and active-flag edits re-check the resulting
          // window under the advisory lock: ending a policy early, extending
          // it, retargeting it, or reactivating it must observe concurrent
          // writers instead of racing them. Submitted values win; anything
          // omitted keeps the stored row (the drawer always submits full
          // bodies, so it sees no difference).
          const submittedApplies = (body.appliesTo ?? null) as Record<string, unknown> | null;
          await guardLeavePolicyWindow(
            tx,
            orgId,
            {
              leaveTypeId:
                body.leaveTypeId !== undefined
                  ? String(body.leaveTypeId)
                  : String(before.leave_type_id),
              appliesTo:
                submittedApplies ?? ((before.applies_to ?? null) as Record<string, unknown> | null),
              effectiveFrom:
                body.effectiveFrom !== undefined
                  ? String(body.effectiveFrom)
                  : String(before.effective_from).slice(0, 10),
              effectiveTo:
                body.effectiveTo === undefined
                  ? before.effective_to
                    ? String(before.effective_to).slice(0, 10)
                    : null
                  : body.effectiveTo == null || body.effectiveTo === ""
                    ? null
                    : String(body.effectiveTo),
              isActive:
                body.isActive === undefined
                  ? Boolean(before.is_active)
                  : coerceBoolean(body.isActive),
            },
            id,
          );
        }
        const updated = await tx.execute(
          sql`
        update ${sql.raw(entity.table)} set ${sql.join(setParts, sql`, `)}
         where ${sql.raw(idColumn(entity))} = ${id}${orgFilter}
        returning ${sql.raw(idColumn(entity))} as id`,
          "objects",
        );
        if (updated.length === 0) {
          // customer-price-level-assignments: deactivating a never-effective
          // future-start assignment removes the row in
          // customer_price_level_end_date_on_deactivate instead of leaving a
          // live future window on a dead row (same-day revokes keep the row
          // with a revoke instant instead — never delete a started row). The
          // before-image was row-locked above, so a row that was present and
          // is now gone was revoked by this same statement: report the
          // delete, not a missing row. The evidence is the trigger's own
          // audit row (before-image included), so this layer writes no
          // second one.
          if (
            entity.key === "customer-price-level-assignments" &&
            before.is_active === true &&
            updateCols.some((column) => column.column === "is_active" && column.value === false) &&
            !(await loadSetupAuditRow(entity, orgId, id, tx))
          ) {
            return true;
          }
          return false;
        }
        if (
          entity.key === "pay-components" &&
          (body.supplementalWageCategory !== undefined ||
            body.statutoryReportingCategory !== undefined ||
            body.statutoryExemptionCategory !== undefined)
        ) {
          await savePayComponentEarningClassification(tx, orgId, id, {
            supplementalWageCategory: supplementalWageCategoryUpdate,
            statutoryReportingCategory: statutoryReportingCategoryUpdate,
            statutoryExemptionCategory: statutoryExemptionCategoryUpdate,
          });
        }
        const members = multirefField(entity);
        if (members && Array.isArray(body[members.key])) {
          await syncMembers(orgId, id, (body[members.key] as unknown[]).map(String), tx);
        }
        const after = await loadSetupAuditRow(entity, orgId, id, tx);
        await audit(
          {
            orgId: entity.orgScoped ? orgId : null,
            table: entity.table,
            rowId: id,
            action: "update",
            changes: {
              before,
              after,
              ...auditReason,
            },
            actorId,
          },
          tx,
        );
        if (entity.key === "pay-schedules") {
          // Entity and currency re-resolve together on every uncommitted run;
          // committed history stays frozen. A re-scope the runs cannot follow
          // (a subsidiary whose currency disagrees with its payroll pack) keeps
          // the saved schedule and reports the remedy as a warning — the next
          // calculation re-attempts the move, so this never strands a run in
          // silence.
          const beforeSubsidiary =
            before.subsidiary_id == null ? null : String(before.subsidiary_id);
          const afterSubsidiary = after?.subsidiary_id == null ? null : String(after.subsidiary_id);
          if (beforeSubsidiary !== afterSubsidiary && afterSubsidiary) {
            try {
              const scope = await rescopePayScheduleRuns(tx, { orgId, payScheduleId: id, actorId });
              scheduleRescope = scope;
            } catch (e) {
              scheduleRescope = {
                reresolved: 0,
                untouched: 0,
                warning: e instanceof Error ? e.message : String(e),
              };
            }
          }
        }
        return true;
      },
      scopeOptions,
    );
    if (!found) return { status: 404, body: { error: "not_found" } };
    return { status: 200, body: { id, ...(scheduleRescope ? { rescope: scheduleRescope } : {}) } };
  } catch (e) {
    if (e instanceof SetupWriteRefusal) return setupRefusalResult(e);
    const databaseError = e as {
      constraint?: string;
      cause?: { constraint?: string; message?: string };
      message?: string;
    };
    if (
      [
        "asset_category_posted_policy",
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
    // Same storage-authority mapping as POST: an edit that moves a row onto an
    // occupied natural key (codes are editable on several entities) is a
    // duplicate conflict, not a generic save failure. Edits that newly
    // overlap an effective range map the same way.
    if (pgErrorCode(e) === "23505") {
      return duplicateConflict(entity.key);
    }
    if (pgErrorCode(e) === "23P01") {
      return overlapConflict(entity.key);
    }
    const scaleRefusal = scaleShapeCheckRefusal(entity.key, e);
    if (scaleRefusal) return scaleRefusal;
    const carrierRefusal = carrierCheckRefusal(entity.key, e);
    if (carrierRefusal) return carrierRefusal;
    const shippingRefusal = shippingCheckRefusal(entity.key, e);
    if (shippingRefusal) return shippingRefusal;
    return { status: 400, body: { error: describeDbError(e) } };
  }
}
