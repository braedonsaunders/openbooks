import "server-only";
import { sql } from "drizzle-orm";
import { accountLocalizationWriteError } from "@openbooks/engine/chart/accounting-contexts";
import type { SetupEntityValidationHook } from "./types";

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * A localization's account, context and subsidiary belong to the company,
 * and its localized number is not used by another account wherever a report
 * could show both (the same scope, or organization-wide beside a subsidiary).
 * Storage separately refuses same-scope overlaps.
 */
export const validateAccountLocalizationWrite: SetupEntityValidationHook = async ({
  orgId,
  body,
  rowId,
  executor,
}) => {
  let values: Record<string, unknown> = body;
  if (rowId) {
    const current = (
      await executor.execute<Record<string, unknown>>(
        sql`
      select context_id as "contextId", account_id as "accountId", subsidiary_id as "subsidiaryId",
             localized_number as "localizedNumber", localized_name as "localizedName",
             effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"
        from account_localizations where org_id = ${orgId} and id = ${rowId}`,
        "objects",
      )
    )[0];
    if (!current) return "Localization not found";
    values = { ...current, ...body };
  }
  return accountLocalizationWriteError(executor, orgId, {
    id: rowId ?? null,
    contextId: String(values.contextId ?? ""),
    accountId: String(values.accountId ?? ""),
    subsidiaryId: text(values.subsidiaryId),
    localizedNumber: text(values.localizedNumber),
    localizedName: text(values.localizedName),
    effectiveFrom: String(values.effectiveFrom ?? ""),
    effectiveTo: text(values.effectiveTo),
  });
};

/** A dependency pairs two different segments and names a value of each. */
export const validateSegmentDependencyWrite: SetupEntityValidationHook = async ({
  orgId,
  body,
  rowId,
  executor,
}) => {
  let values: Record<string, unknown> = body;
  if (rowId) {
    const current = (
      await executor.execute<Record<string, unknown>>(
        sql`
      select segment_id as "segmentId", value_id as "valueId", controlling_segment_id as "controllingSegmentId",
             allowed_value_id as "allowedValueId", effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"
        from segment_value_dependencies where org_id = ${orgId} and id = ${rowId}`,
        "objects",
      )
    )[0];
    if (!current) return "Dependency not found";
    values = { ...current, ...body };
  }
  const segmentId = text(values.segmentId);
  const controllingId = text(values.controllingSegmentId);
  const valueId = text(values.valueId);
  const allowedId = text(values.allowedValueId);
  if (!segmentId || !controllingId || !valueId || !allowedId)
    return "Choose the value, the controlling segment and the value it is allowed with.";
  if (segmentId === controllingId)
    return "A segment cannot depend on itself; choose a different controlling segment.";
  const from = text(values.effectiveFrom);
  const to = text(values.effectiveTo);
  if (from && to && to < from) return "The end date must be on or after the start date.";
  const owned = (
    await executor.execute<{ value_ok: boolean; allowed_ok: boolean }>(
      sql`
    select public.segment_definition_has_value(${orgId}, ${segmentId}::uuid, ${valueId}::uuid) as value_ok,
           public.segment_definition_has_value(${orgId}, ${controllingId}::uuid, ${allowedId}::uuid) as allowed_ok`,
      "objects",
    )
  )[0];
  if (!owned?.value_ok) return "Choose a value of the segment this dependency restricts.";
  if (!owned.allowed_ok) return "Choose an allowed value of the controlling segment.";
  return null;
};
