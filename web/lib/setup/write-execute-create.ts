import "server-only";
import { validateSubcontractLocationConfiguration } from "@openbooks/engine/inventory/subcontract-custody";
import { randomUUID } from "node:crypto";
import { claimSetupCreate, SetupCreateConflict } from "../api/idempotency";
import { isUuid } from "../list-params";
import { createHomeAnnouncementRow } from "./home-announcements";
import { sql } from "drizzle-orm";
import { CurrencyError } from "@openbooks/engine/fx/currencies";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { toSnake } from "./registry";
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
  createUsageMeter,
  deactivateUsageMeter,
  type UsageAggregation,
} from "@openbooks/engine/billing/usage/records";
import {
  createUsageRatingPlan,
  retireUsageRatingPlan,
} from "@openbooks/engine/billing/usage/rating-plans";
import { UsageBillingError } from "@openbooks/engine/billing/usage/errors";
import {
  EntitlementError,
  createSaasFeature,
  type SaasFeatureType,
} from "@openbooks/engine/billing";
import { auditSetupChange as audit, loadSetupAuditRow } from "./audit";
import { createInitialComponentTreatment } from "./initial-component-treatment";
import { isFeatureEnabled, subsidiaryFeatureEnabled } from "../features";
import { numberSequenceStoredCols } from "./number-sequence-position";
import {
  bindSetupValue,
  defaultPayComponentProgramExclusions,
  entityForValidation,
  entityPermissionRefusal,
  foldPayComponentSetupCreate,
  foldRecruitingSetupCreate,
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
import {
  duplicateConflict,
  filingAccountDuplicateConflict,
  guardLeavePolicyWindow,
  overlapConflict,
} from "./write-conflicts";

/**
 * Create one setup record (the POST semantics of /api/admin/setup/[entity]).
 *
 * Every create carries an idempotency key that becomes the new row's id (or,
 * for home announcements, the announcement id): the HTTP route passes the
 * caller's `Idempotency-Key` header, while direct command callers (assistant
 * tools, imports) omit it and each call mints a fresh key. A retried key
 * replays the original result with no second row, audit event, or side
 * effect; a changed payload or cross-org collision is refused as 409.
 *
 * `extension-settings` declares allowCreate: false, so its creates stay 405
 * above — it is explicitly refused, never silently exempted from the claim.
 */
export async function createSetupRecord(
  actor: SetupActor,
  entityKey: string,
  rawBody: Record<string, unknown>,
  options: { requestId?: string } = {},
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
  if (entity.allowCreate === false)
    return { status: 405, body: { error: "This configuration is declared by its module" } };
  if (entity.mutationPath)
    return {
      status: 405,
      body: {
        error: `This configuration must be saved through ${entity.mutationPath}, which validates the complete record.`,
      },
    };
  if (entity.readOnly) return { status: 405, body: { error: "read-only" } };
  const requestId = options.requestId ?? randomUUID();
  if (!isUuid(requestId)) {
    return { status: 400, body: { error: "Idempotency-Key must be a UUID", code: "invalid" } };
  }

  // HR-15: home announcements create into org settings JSON.
  if (entity.dataSource === "home-announcements") {
    try {
      return {
        status: 200,
        body: await createHomeAnnouncementRow(orgId, rawBody, { id: requestId }),
      };
    } catch (error) {
      if (error instanceof Error && (error as { status?: unknown }).status === 409) {
        return { status: 409, body: { error: error.message, code: "idempotency-conflict" } };
      }
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message : "Invalid announcement" },
      };
    }
  }

  // HR-18: recruiting-depth create defaults fold before the generic coercion.
  // Pay-component levy exclusions fold on the same boundary.
  const recruitingBody = foldPayComponentSetupCreate(
    entity.key,
    foldRecruitingSetupCreate(entity.key, rawBody),
  );
  // The review-template fold is the one input boundary that refuses: a
  // scale bound no decimal reading accepts fails here as a 400 before
  // buildRow or the storage CHECK ever sees it.
  let reviewFolded: Record<string, unknown>;
  try {
    reviewFolded = normalizeHrmReviewTemplateInput(
      entity.key,
      normalizeHrmCompensationInput(
        entity.key,
        normalizeHrmProcessTemplateInput(
          entity.key,
          normalizeTaxReturnFormInput(entity.key, recruitingBody),
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
  const multiCurrency = await isFeatureEnabled(orgId, "multiCurrency");
  const writableEntity = writableSetupEntity(entity, {
    multiSubsidiary: await subsidiaryFeatureEnabled(orgId),
    equipment: await isFeatureEnabled(orgId, "equipment"),
    fieldTickets: await isFeatureEnabled(orgId, "fieldTickets"),
    einvoicing: await isFeatureEnabled(orgId, "einvoicing"),
  });
  // Rate-book currency is Multi-currency configuration. When that switch is
  // off the create descriptor must not require the field, so omitting it
  // can fall through to the org base instead of a 400.
  const createEntity =
    entity.key === "item-rate-books" && !multiCurrency
      ? {
          ...writableEntity,
          fields: writableEntity.fields.filter((field) => field.key !== "currency"),
        }
      : writableEntity;
  // The writer normalizes slot fields into their folded objects before this
  // point, so a present fold covers its slots' requiredness and columns.
  const built = buildRow(await entityForValidation(createEntity, orgId), body, {
    forCreate: true,
    coverFoldedSlots: true,
  });
  if ("error" in built) return { status: 400, body: { error: built.error, code: "invalid" } };
  let integrityError: string | null;
  try {
    integrityError = await validateEntityIntegrity(entity, body, orgId);
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

  // Request-controlled match image for the book entities: submitted values
  // only. The selected/active flags derive from concurrent table state
  // (first-book auto-promotion), so comparing them would turn a genuine
  // retry into a conflict; the claim compares this image against the stored
  // one, never against the derived row.
  const setupBookMatch = (): Record<string, unknown> => ({
    code: String(body.code),
    name: String(body.name),
    ...(entity.key === "accounting-books"
      ? { is_primary: body.isPrimary === undefined ? null : coerceBoolean(body.isPrimary) }
      : { is_default: body.isDefault === undefined ? null : coerceBoolean(body.isDefault) }),
    is_active: body.isActive === undefined ? null : coerceBoolean(body.isActive),
    ...(entity.key === "accounting-books" || body.currency === undefined
      ? {}
      : { currency: String(body.currency) }),
    org_id: orgId,
    created_by: actorId,
    updated_by: actorId,
  });

  if (entity.key === "accounting-books") {
    try {
      const id = await setupWriteTransaction(
        entity,
        orgId,
        body,
        undefined,
        (tx) =>
          saveSetupBook(entity, orgId, actorId, body, tx, {
            idempotencyKey: requestId,
            match: setupBookMatch(),
          }),
        { ...scopeOptions, idempotencyKey: requestId },
      );
      return { status: 200, body: { id } };
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return setupRefusalResult(e);
      if (e instanceof SetupCreateConflict)
        return { status: e.status, body: { error: e.message, code: e.code } };
      return { status: 400, body: { error: describeDbError(e) } };
    }
  }

  if (entity.key === "item-rate-books") {
    // Rate-book currency is Multi-currency configuration. Turning that
    // switch off must refuse a new write; omitting currency keeps the
    // org base so a book can still be created and stored books stay.
    if (body.currency !== undefined && !multiCurrency) {
      return { status: 404, body: { error: "not_found" } };
    }
    try {
      const id = await setupWriteTransaction(
        entity,
        orgId,
        body,
        undefined,
        (tx) =>
          saveSetupBook(entity, orgId, actorId, body, tx, {
            idempotencyKey: requestId,
            match: setupBookMatch(),
          }),
        { ...scopeOptions, idempotencyKey: requestId },
      );
      return { status: 200, body: { id } };
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return setupRefusalResult(e);
      if (e instanceof SetupCreateConflict)
        return { status: e.status, body: { error: e.message, code: e.code } };
      return { status: 400, body: { error: describeDbError(e) } };
    }
  }

  // Natural-key uniqueness (these tables mostly lack a DB unique constraint).
  // The check selects ids so a retried idempotency key passes through: when
  // the duplicate row IS this key's own row, the claim inside the transaction
  // replays an exact retry (200) or refuses a changed payload (409) instead
  // of misreporting the retry as a natural-key duplicate.
  if (
    entity.naturalKey &&
    entity.key !== "usage-meters" &&
    entity.key !== "usage-rating-plans" &&
    entity.key !== "saas-features"
  ) {
    const col = toSnake(entity.naturalKey);
    const val = String(body[entity.naturalKey] ?? "");
    const orgFilter = entity.orgScoped ? sql` and org_id = ${orgId}` : sql``;
    // Derived rules are effective-dated versions: the same code is allowed
    // again when it starts on a different date, while the storage unique key
    // still rejects two definitions beginning on the same date.
    const effectiveFilter =
      entity.key === "pay-derived-rules"
        ? sql` and effective_from = ${String(body.effectiveFrom ?? "")}`
        : sql``;
    const dup = await db.execute(
      sql`
      select id from ${sql.raw(entity.table)}
       where ${sql.raw(col)} = ${val}${orgFilter}${effectiveFilter} limit 1`,
      "objects",
    );
    if (dup.length > 0 && !(dup as { id: unknown }[]).some((row) => String(row.id) === requestId)) {
      // Filing accounts share one account-number namespace across programs,
      // entities and archived rows: name the row the server sees, or the
      // operator stares at a list that does not show it.
      if (entity.key === "payroll-filing-accounts") {
        return filingAccountDuplicateConflict(orgId, val);
      }
      return duplicateConflict(entity.key);
    }
  }

  // Rule-slot entities: generated slot columns are never written and the
  // folded rule objects always are (see hrm-rule-slots.ts).
  const slotted = applyRuleSlotColumns(entity.key, body, built.cols);
  if ("error" in slotted) return { status: 400, body: { error: slotted.error } };
  const supplementalWageCategory = slotted.cols.find(
    (column) => column.column === "supplemental_wage_category",
  )?.value;
  const statutoryReportingCategory = slotted.cols.find(
    (column) => column.column === "statutory_reporting_category",
  )?.value;
  const statutoryExemptionCategory = slotted.cols.find(
    (column) => column.column === "statutory_exemption_category",
  )?.value;
  let cols =
    entity.key === "fx-rates"
      ? slotted.cols.filter(
          (column) => !["source", "provider_config_id", "imported_at"].includes(column.column),
        )
      : [...slotted.cols];
  if (entity.key === "pay-components") {
    cols = cols.filter(
      (column) =>
        column.column !== "supplemental_wage_category" &&
        column.column !== "statutory_reporting_category" &&
        column.column !== "statutory_exemption_category",
    );
  }
  if (entity.key === "leave-policies") {
    // The change reason rides into the audit image, never into a column —
    // hrm_leave_policies has no reason column.
    cols = cols.filter((column) => column.column !== "reason");
  }
  if (entity.key === "fx-rates" || entity.key === "consolidated-fx-rates") {
    try {
      cols = persistFxRateCols(cols);
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
  if (entity.key === "number-sequences") cols = numberSequenceStoredCols(cols);
  if (entity.key === "fx-rates") cols.push({ column: "source", value: "manual" });
  if (entity.orgScoped) cols.push({ column: "org_id", value: orgId });
  if (entity.actorCols) {
    cols.push({ column: "created_by", value: actorId });
    cols.push({ column: "updated_by", value: actorId });
  }
  // The idempotency key becomes the row id, claimed atomically
  // (on conflict do nothing) at each insert below; a lost race re-resolves
  // the claim in the same transaction instead of reporting success for a row
  // it did not write.
  cols.push({ column: "id", value: requestId });

  // Request-controlled match image for the replay comparison: the exact
  // coerced columns the insert stores (actor/org context included, so a
  // different actor reusing the key fails closed), plus join-table members
  // where the entity has them. Derived values never enter here — version
  // closures and book promotions compute theirs after the claim.
  const setupCreateMatch = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const match: Record<string, unknown> = { ...extra };
    for (const column of cols) {
      if (column.column === "id") continue;
      match[column.column] = column.value;
    }
    return match;
  };

  const colSql = sql.raw(cols.map((c) => c.column).join(", "));
  const valSql = sql.join(
    cols.map((c) => sql`${bindSetupValue(c.value)}`),
    sql`, `,
  );

  if (
    entity.key === "usage-meters" ||
    entity.key === "usage-rating-plans" ||
    entity.key === "saas-features"
  ) {
    const match = setupCreateMatch();
    const claimMatch = {
      orgId,
      table: entity.table,
      key: requestId,
      match,
      orgScoped: entity.orgScoped,
    };
    try {
      const id = await withOrgTransaction(orgId, () =>
        setupWriteTransaction(
          entity,
          orgId,
          body,
          undefined,
          async (tx) => {
            const claim = await claimSetupCreate(tx, claimMatch);
            if (claim.kind === "replay") return claim.id;
            const created =
              entity.key === "usage-meters"
                ? await createUsageMeter(orgId, actorId, {
                    key: String(body.key),
                    name: String(body.name),
                    unit: String(body.unit),
                    aggregation: body.aggregation as UsageAggregation,
                    itemId: body.itemId == null || body.itemId === "" ? null : String(body.itemId),
                  })
                : entity.key === "saas-features"
                  ? await createSaasFeature(orgId, actorId, {
                      key: String(body.key),
                      name: String(body.name),
                      description:
                        body.description == null || body.description === ""
                          ? null
                          : String(body.description),
                      type: body.featureType as SaasFeatureType,
                      unit: body.unit == null || body.unit === "" ? null : String(body.unit),
                      meterKey:
                        body.meterKey == null || body.meterKey === ""
                          ? null
                          : String(body.meterKey),
                      isActive:
                        body.isActive === undefined ? undefined : coerceBoolean(body.isActive),
                    })
                  : await createUsageRatingPlan(orgId, actorId, {
                      name: String(body.name),
                      currency: String(body.currency),
                    });
            const rowId = String(created.id);
            if (
              entity.key === "usage-meters" &&
              body.isActive !== undefined &&
              !coerceBoolean(body.isActive)
            ) {
              await deactivateUsageMeter(orgId, actorId, rowId);
            }
            if (entity.key === "usage-rating-plans" && body.status === "retired") {
              await retireUsageRatingPlan(orgId, actorId, rowId);
            }
            await audit(
              {
                orgId,
                table: entity.table,
                rowId,
                action: "insert",
                changes: { after: await loadSetupAuditRow(entity, orgId, rowId, tx), match },
                actorId,
                requestId,
              },
              tx,
            );
            return rowId;
          },
          { ...scopeOptions, idempotencyKey: requestId },
        ),
      );
      return { status: 200, body: { id } };
    } catch (error) {
      if (error instanceof SetupWriteRefusal)
        return { status: error.status, body: { error: error.message } };
      if (error instanceof SetupCreateConflict)
        return { status: error.status, body: { error: error.message, code: error.code } };
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
      if (pgErrorCode(error) === "23505") return duplicateConflict(entity.key);
      return { status: 400, body: { error: describeDbError(error) } };
    }
  }

  if (entity.key === "pay-derived-rules") {
    // A direct create of a later active version follows the same timeline rule
    // as an edit: close the currently-effective active row before inserting the
    // successor, and keep both operations plus their evidence atomic.
    const match = setupCreateMatch();
    const claimMatch = {
      orgId,
      table: entity.table,
      key: requestId,
      match,
      orgScoped: entity.orgScoped,
    };
    try {
      const newId = await setupWriteTransaction(
        entity,
        orgId,
        body,
        undefined,
        async (tx) => {
          // The claim resolves before the version closure below, so an exact
          // retry returns without closing (or re-closing) the prior version.
          const claim = await claimSetupCreate(tx, claimMatch);
          if (claim.kind === "replay") return claim.id;
          const effectiveFrom = String(body.effectiveFrom);
          const prior = coerceBoolean(body.isActive)
            ? await tx.execute(
                sql`
              select * from pay_derived_rules
               where org_id = ${orgId} and code = ${String(body.code)}
                 and is_active
                 and effective_from < ${effectiveFrom}::date
                 and (effective_to is null or effective_to >= ${effectiveFrom}::date)
               for update`,
                "objects",
              )
            : [];
          for (const row of prior) {
            const closed = await tx.execute(
              sql`
            update pay_derived_rules
               set effective_to = (${effectiveFrom}::date - 1),
                   updated_at = now(), updated_by = ${actorId}
             where id = ${String(row.id)} and org_id = ${orgId}
            returning *`,
              "objects",
            );
            await audit(
              {
                orgId,
                table: entity.table,
                rowId: String(row.id),
                action: "update",
                changes: { before: row, after: closed[0] },
                actorId,
              },
              tx,
            );
          }
          const inserted = await tx.execute(
            sql`
          insert into ${sql.raw(entity.table)} (${colSql}) values (${valSql})
          -- A concurrent create claim is verified against its audited payload below before replaying.
          on conflict (id) do nothing
          returning ${sql.raw(idColumn(entity))} as id`,
            "objects",
          );
          const insertedRow = inserted[0];
          if (!insertedRow) {
            // Lost the same-key insert race: the winner's row (and its insert
            // audit) is visible now, so re-resolve the claim in this same
            // transaction — replay, or refuse.
            const raced = await claimSetupCreate(tx, claimMatch);
            if (raced.kind === "replay") return raced.id;
            throw new Error("not found");
          }
          const id = String(insertedRow.id);
          await audit(
            {
              orgId: entity.orgScoped ? orgId : null,
              table: entity.table,
              rowId: id,
              action: "insert",
              changes: { after: await loadSetupAuditRow(entity, orgId, id, tx), match },
              actorId,
              requestId,
            },
            tx,
          );
          return id;
        },
        { ...scopeOptions, idempotencyKey: requestId },
      );
      return { status: 200, body: { id: newId } };
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return setupRefusalResult(e);
      if (e instanceof SetupCreateConflict)
        return { status: e.status, body: { error: e.message, code: e.code } };
      if (pgErrorCode(e) === "23505" || pgErrorCode(e) === "23P01") {
        return duplicateConflict(entity.key);
      }
      return { status: 400, body: { error: describeDbError(e) } };
    }
  }

  try {
    const members = multirefField(entity);
    const memberIds =
      members && Array.isArray(body[members.key])
        ? [...new Set((body[members.key] as unknown[]).map(String).filter((v) => isUuid(v)))]
        : undefined;
    const match = setupCreateMatch({
      ...(auditReason.reason === undefined ? {} : { auditReason: auditReason.reason }),
      ...(memberIds === undefined ? {} : { members: memberIds }),
      ...(entity.key === "pay-components"
        ? {
            earningClassification: {
              supplementalWageCategory: supplementalWageCategory ?? null,
              statutoryReportingCategory: statutoryReportingCategory ?? null,
              statutoryExemptionCategory: statutoryExemptionCategory ?? null,
            },
          }
        : {}),
    });
    const claimMatch = {
      orgId,
      table: entity.table,
      key: requestId,
      match,
      orgScoped: entity.orgScoped,
    };
    const newId = await setupWriteTransaction(
      entity,
      orgId,
      body,
      undefined,
      async (tx) => {
        if (entity.key === "stock-locations")
          await validateSubcontractLocationConfiguration(tx, orgId, actorId, body);
        // The claim resolves before the insert and the member sync below, so
        // an exact retry returns having written neither.
        const claim = await claimSetupCreate(tx, claimMatch);
        if (claim.kind === "replay") return claim.id;
        if (entity.key === "leave-policies") {
          // Same-type policy creates serialize here (the guard holds the
          // advisory lock for the rest of this transaction): the loser
          // preflights against the winner's committed row and is refused by
          // name instead of racing to the storage exclusion.
          await guardLeavePolicyWindow(
            tx,
            orgId,
            {
              leaveTypeId: String(body.leaveTypeId),
              appliesTo: (body.appliesTo ?? null) as Record<string, unknown> | null,
              effectiveFrom: String(body.effectiveFrom),
              effectiveTo:
                body.effectiveTo == null || body.effectiveTo === ""
                  ? null
                  : String(body.effectiveTo),
              isActive: body.isActive === undefined ? true : coerceBoolean(body.isActive),
            },
            null,
          );
        }
        const inserted = await tx.execute(
          sql`
        insert into ${sql.raw(entity.table)} (${colSql}) values (${valSql})
        -- A concurrent create claim is verified against its audited payload below before replaying.
        on conflict (id) do nothing
        returning ${sql.raw(idColumn(entity))} as id${entity.key === "pay-components" ? sql`, vacationable` : sql``}`,
          "objects",
        );
        const insertedRow = inserted[0];
        if (!insertedRow) {
          // Lost the same-key insert race: re-resolve the claim in this same
          // transaction — replay, or refuse.
          const raced = await claimSetupCreate(tx, claimMatch);
          if (raced.kind === "replay") return raced.id;
          throw new Error("not found");
        }
        const id = String(insertedRow.id);
        if (
          entity.key === "pay-components" &&
          (supplementalWageCategory !== undefined ||
            statutoryReportingCategory !== undefined ||
            statutoryExemptionCategory !== undefined)
        ) {
          await savePayComponentEarningClassification(tx, orgId, id, {
            supplementalWageCategory,
            statutoryReportingCategory,
            statutoryExemptionCategory,
          });
        }
        if (entity.key === "pay-components") {
          await createInitialComponentTreatment(tx, {
            orgId,
            actorId,
            componentId: id,
            vacationable: insertedRow.vacationable,
            programExclusions: defaultPayComponentProgramExclusions(body),
            requestId,
          });
        }
        if (members && Array.isArray(body[members.key])) {
          await syncMembers(orgId, id, (body[members.key] as unknown[]).map(String), tx);
        }
        await audit(
          {
            orgId: entity.orgScoped ? orgId : null,
            table: entity.table,
            rowId: id,
            action: "insert",
            changes: {
              after: await loadSetupAuditRow(entity, orgId, id, tx),
              match,
              ...auditReason,
            },
            actorId,
            requestId,
          },
          tx,
        );
        return id;
      },
      { ...scopeOptions, idempotencyKey: requestId },
    );
    return { status: 200, body: { id: newId } };
  } catch (e) {
    if (e instanceof SetupWriteRefusal) return setupRefusalResult(e);
    if (e instanceof SetupCreateConflict)
      return { status: e.status, body: { error: e.message, code: e.code } };
    const databaseError = e as {
      constraint?: string;
      cause?: { constraint?: string; message?: string };
      message?: string;
    };
    if (
      (databaseError.cause?.constraint ?? databaseError.constraint) ===
      "depreciation_book_posted_policy"
    ) {
      return {
        status: 409,
        body: { error: databaseError.cause?.message ?? databaseError.message },
      };
    }
    // The natural-key preflight above is an autocommit read, so two concurrent
    // creates can both pass it; the storage UNIQUE constraint is the authority
    // and surfaces here as a deterministic 409, with no partial row or audit
    // (the insert and its audit share one transaction).
    if (pgErrorCode(e) === "23505") {
      // A lost storage race on filing accounts names the winning row exactly
      // like the preflight does — the operator sees one answer either way.
      if (entity.key === "payroll-filing-accounts") {
        return filingAccountDuplicateConflict(orgId, String(body[entity.naturalKey!] ?? ""));
      }
      return duplicateConflict(entity.key);
    }
    // Effective-range exclusion constraints (SQLSTATE 23P01) arbitrate overlap
    // races the same way: typed 409, never raw Postgres text.
    if (pgErrorCode(e) === "23P01") {
      return overlapConflict(entity.key);
    }
    // A storage CHECK the earlier layers should have proved (the review
    // scale shape) still refuses by name with the remedy — the CHECK
    // itself stays intact; only its surfacing changes.
    const scaleRefusal = scaleShapeCheckRefusal(entity.key, e);
    if (scaleRefusal) return scaleRefusal;
    const carrierRefusal = carrierCheckRefusal(entity.key, e);
    if (carrierRefusal) return carrierRefusal;
    const shippingRefusal = shippingCheckRefusal(entity.key, e);
    if (shippingRefusal) return shippingRefusal;
    return { status: 400, body: { error: describeDbError(e) } };
  }
}
