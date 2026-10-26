import "server-only";
import { isUuid } from "../list-params";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/platform/db";
import { compileFormula } from "@openbooks/engine/assets/depreciation-formula";
import { collidingSequenceKind } from "@openbooks/engine/records/numbering";
import type { SetupEntity } from "./registry";
import { carrierTrackingTemplateProblem } from "./coerce";
import { isFeatureEnabled, subsidiaryFeatureEnabled } from "../features";
import { loadNumberSequenceKindOptions } from "./number-sequence-kinds";
import { storedSequencePosition } from "./number-sequence-position";
import { INTEGRITY_CONTINUES, type SetupIntegrityVerdict } from "./write-shared";

/** Ordered setup integrity rules: Derived pay rules, putaway, carriers, time types, numbering, depreciation methods and tax return forms. */
export async function validateOperationsIntegrity(
  entity: SetupEntity,
  body: Record<string, unknown>,
  orgId: string,
  rowId: string | undefined,
  executor: SqlExecutor,
): Promise<SetupIntegrityVerdict> {
  if (entity.key === "pay-derived-rules") {
    // Equipment attribution is a Features-gated write. Turning Equipment off
    // must stop a new unit link or equipment_charge trigger without wiping
    // rules that already carry one.
    const current = rowId
      ? (
          await executor.execute(
            sql`
          select trigger, equipment_unit_id from pay_derived_rules
           where id = ${rowId} and org_id = ${orgId}`,
            "objects",
          )
        )[0]
      : null;
    if (rowId && !current) return "not found";
    const submittedUnit = Boolean(body.equipmentUnitId);
    const submittedChargeTrigger = body.trigger === "equipment_charge";
    const changingUnit = submittedUnit && body.equipmentUnitId !== current?.equipment_unit_id;
    const changingTrigger = submittedChargeTrigger && current?.trigger !== "equipment_charge";
    if (
      (changingUnit || changingTrigger || (!rowId && (submittedUnit || submittedChargeTrigger))) &&
      !(await isFeatureEnabled(orgId, "equipment", executor))
    ) {
      return "not found";
    }
  }
  if (
    entity.key === "putaway-rules" &&
    body.strategy === "bulk-zone" &&
    (body.capacityQuantity === undefined ||
      body.capacityQuantity === null ||
      body.capacityQuantity === "")
  ) {
    return "A bulk-zone putaway rule needs a capacity: enter the most the zone may hold of the item";
  }
  if (entity.key === "carriers") {
    const problem = carrierTrackingTemplateProblem(body.trackingUrlTemplate);
    if (problem) return problem;
  }
  if (
    entity.key === "time-types" &&
    body.showOnFieldTicket !== undefined &&
    !(await isFeatureEnabled(orgId, "fieldTickets", executor))
  ) {
    return "not found";
  }
  if (entity.key === "number-sequences") {
    const current = rowId
      ? ((
          await executor.execute(
            sql`
          select document_kind, subsidiary_id, allocated_through, prefix, padding from number_sequences
           where id = ${rowId} and org_id = ${orgId}`,
            "objects",
          )
        )[0] as
          | {
              document_kind: string;
              subsidiary_id: string | null;
              allocated_through: number;
              prefix: string;
              padding: number;
            }
          | undefined)
      : null;
    if (rowId && !current) return "not found";
    if (body.nextNumber !== undefined) {
      // The storage guard refuses a backward move too; this names the
      // smallest next number the operator may choose.
      const position = storedSequencePosition(
        typeof body.nextNumber === "string" && body.nextNumber.trim() !== ""
          ? Number(body.nextNumber)
          : body.nextNumber,
        Number(current?.allocated_through ?? 0),
      );
      if ("error" in position) return position.error;
    }
    const documentKind = String(body.documentKind ?? current?.document_kind ?? "");
    const allowedKinds = new Set(
      (await loadNumberSequenceKindOptions(orgId, executor)).map((option) => option.value),
    );
    if (!allowedKinds.has(documentKind)) return "Choose a valid document or custom record type";

    const submittedSubsidiaryId = body.subsidiaryId || null;
    if (submittedSubsidiaryId) {
      if (!(await subsidiaryFeatureEnabled(orgId, executor)))
        return "Subsidiaries are not enabled for this organization";
      if (!isUuid(String(submittedSubsidiaryId))) return "Choose a valid subsidiary";
      const subsidiary = await executor.execute(
        sql`
        select 1 from subsidiaries
         where id = ${String(submittedSubsidiaryId)} and org_id = ${orgId}
           and is_active and not is_elimination`,
        "objects",
      );
      if (!subsidiary.length) return "Choose an active subsidiary from this organization";
    }
    // Two kinds on one series issue the same strings from independent
    // counters (PAY-00001 naming both a vendor payment and a pay run), so a
    // series an unrelated kind already holds is refused — naming both kinds
    // and the remedy. Checked only when the series itself is submitted (or on
    // create): a counter-only edit to an already-colliding row stays
    // writable, or the collision could never be edited away.
    if (body.prefix !== undefined || body.padding !== undefined || !rowId) {
      const seriesPrefix =
        body.prefix !== undefined ? String(body.prefix) : (current?.prefix ?? "");
      const seriesPaddingRaw = body.padding !== undefined ? body.padding : (current?.padding ?? 5);
      const seriesPadding =
        typeof seriesPaddingRaw === "number" ? seriesPaddingRaw : Number(seriesPaddingRaw);
      if (Number.isSafeInteger(seriesPadding) && seriesPadding >= 0) {
        const clash = await collidingSequenceKind(executor, orgId, {
          documentKind,
          prefix: seriesPrefix,
          padding: seriesPadding,
        });
        if (clash) {
          return (
            `"${documentKind}" and "${clash}" would both issue ${seriesPrefix || "(no prefix)"}${"0".repeat(Math.min(seriesPadding, 12))}… — ` +
            `two document kinds cannot share one prefix and number width while each keeps its own counter. ` +
            `Change one kind's prefix in Setup → Number sequences so every number names its kind.`
          );
        }
      }
    }
  }
  if (entity.key === "depreciation-methods") {
    const current = rowId
      ? (
          await executor.execute(
            sql`select formula from depreciation_methods where id=${rowId} and org_id=${orgId}`,
            "objects",
          )
        )[0]
      : null;
    if (rowId && !current) return "not found";
    const formula = String(body.formula ?? current?.formula ?? "").trim();
    if (!formula || formula.length > 2048) return "invalid-depreciation-formula";
    try {
      compileFormula(formula);
    } catch {
      return "invalid-depreciation-formula";
    }
  }
  if (entity.key === "tax-return-forms" && body.submissionUrl) {
    try {
      const url = new URL(String(body.submissionUrl));
      if (url.protocol !== "https:" && url.protocol !== "http:") return "invalid-url";
    } catch {
      return "invalid-url";
    }
  }
  return INTEGRITY_CONTINUES;
}
