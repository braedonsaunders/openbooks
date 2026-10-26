import "server-only";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/platform/db";
import { canonicalDecimal, compareDecimal } from "@openbooks/engine/money/decimal";
import { decimalNullRefusal } from "../payroll-decimal-refusal";
import { CANONICAL_RATING_KEYS } from "@openbooks/engine/hrm/recruiting/kits";
import { RecruitingError } from "@openbooks/engine/hrm/recruiting/errors";
import { parseClauses } from "@openbooks/engine/hrm/recruiting/offers-signing";
import { validateAvailabilityWindows } from "@openbooks/engine/hrm/recruiting/scheduling";
import { requireCompensation } from "@openbooks/engine/hrm/recruiting/requisitions";
import type { SetupEntity } from "./registry";
import { INTEGRITY_CONTINUES, type SetupIntegrityVerdict } from "./write-shared";

/** Ordered setup integrity rules: Recruiting configuration, job levels and pay bands. */
export async function validateTalentIntegrity(
  entity: SetupEntity,
  body: Record<string, unknown>,
  orgId: string,
  rowId: string | undefined,
  executor: SqlExecutor,
): Promise<SetupIntegrityVerdict> {
  // HR-18 begin: recruiting-depth configuration (0229). Every structured
  // field is validated through the engine service that owns the shape —
  // validateAvailabilityWindows, parseClauses, CANONICAL_RATING_KEYS —
  // and parents prove visibility in this org (the current row merges on
  // edit, so a partial edit validates the stored remainder instead of
  // refusing the untouched structure). Validation only: normalized values
  // reach the columns through the pre-fold (create defaults) and the
  // generic coercion, never by mutating the body after buildRow ran.
  // Setup can never store a row the depth services refuse to read.
  if (entity.key === "hrm-interview-kits") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select pipeline_stage_id as "pipelineStageId", rating_scale as "ratingScale"
          from hrm_interview_kits where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Interview kit not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    const scale = values.ratingScale;
    // Absent on create is defaulted before coercion (see
    // foldRecruitingSetupCreate); present-but-empty is refused here, and
    // anything outside the canonical vocabulary is refused by name — the
    // storage CHECK would otherwise fail without naming the field.
    if (scale !== undefined && scale !== null) {
      const keys = Array.isArray(scale) ? scale.map(String) : [];
      const allowed = new Set<string>(CANONICAL_RATING_KEYS as readonly string[]);
      if (keys.length < 2 || keys.some((key) => !allowed.has(key))) {
        return "The rating scale lists at least two of strong_no, no, yes, strong_yes";
      }
    }
    if (values.pipelineStageId) {
      const stage = await executor.execute(
        sql`
        select 1 from hrm_pipeline_stages where id = ${String(values.pipelineStageId)} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!stage[0]) return "The pipeline stage is not visible in this organization";
    }
  }
  if (entity.key === "hrm-kit-attributes") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select kit_id as "kitId" from hrm_scorecard_attributes where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Scorecard attribute not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    if (
      values.position !== undefined &&
      (!Number.isInteger(Number(values.position)) || Number(values.position) < 0)
    ) {
      return "Attribute position is a zero-based integer ordering the scorecard";
    }
    const kit = await executor.execute(
      sql`
      select 1 from hrm_interview_kits where id = ${String(values.kitId ?? "")} and org_id = ${orgId}
    `,
      "objects",
    );
    if (!kit[0]) return "The parent kit is not visible in this organization";
  }
  if (entity.key === "hrm-kit-questions") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select kit_id as "kitId", attribute_id as "attributeId"
          from hrm_interview_kit_questions where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Kit question not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    if (
      values.position !== undefined &&
      (!Number.isInteger(Number(values.position)) || Number(values.position) < 0)
    ) {
      return "Question position is a zero-based integer ordering the guide";
    }
    const kit = await executor.execute(
      sql`
      select 1 from hrm_interview_kits where id = ${String(values.kitId ?? "")} and org_id = ${orgId}
    `,
      "objects",
    );
    if (!kit[0]) return "The parent kit is not visible in this organization";
    if (values.attributeId) {
      const attribute = await executor.execute(
        sql`
        select 1 from hrm_scorecard_attributes
         where id = ${String(values.attributeId)} and org_id = ${orgId} and kit_id = ${String(values.kitId ?? "")}
      `,
        "objects",
      );
      if (!attribute[0])
        return "The attribute belongs to a different kit — pin the question to one of this kit\u2019s attributes";
    }
  }
  if (entity.key === "hrm-interviewer-pools") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select kit_id as "kitId", availability as "availability"
          from hrm_interviewer_pools where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Interviewer pool not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    if (values.availability !== undefined && values.availability !== null) {
      try {
        validateAvailabilityWindows(values.availability);
      } catch (e) {
        if (e instanceof RecruitingError) return e.message;
        throw e;
      }
    }
    if (values.kitId) {
      const kit = await executor.execute(
        sql`
        select 1 from hrm_interview_kits where id = ${String(values.kitId)} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!kit[0]) return "The default kit is not visible in this organization";
    }
  }
  if (entity.key === "hrm-offer-templates") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select name as "name", clauses as "clauses"
          from hrm_offer_templates where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Offer template not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    if (values.clauses !== undefined && values.clauses !== null) {
      try {
        parseClauses(values.clauses, String(values.name ?? "template"));
      } catch (e) {
        if (e instanceof RecruitingError) return e.message;
        throw e;
      }
    }
  }
  if (entity.key === "hrm-job-descriptions") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select compensation_min::text as "compensationMin", compensation_max::text as "compensationMax",
               compensation_currency as "compensationCurrency", compensation_basis as "compensationBasis"
          from hrm_job_descriptions where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Job description not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    // The pay range copies into a requisition verbatim, so it is held to
    // the requisition's own compensation contract: all four or none.
    const pay = [
      values.compensationMin,
      values.compensationMax,
      values.compensationCurrency,
      values.compensationBasis,
    ];
    const present = pay.filter((value) => value !== undefined && value !== null && value !== "");
    if (present.length > 0 && present.length < pay.length) {
      return "The pay range needs a minimum, maximum, currency and basis together, or none of them";
    }
    if (present.length === pay.length) {
      try {
        requireCompensation({
          min: String(values.compensationMin),
          max: String(values.compensationMax),
          currency: String(values.compensationCurrency),
          basis: values.compensationBasis,
        });
      } catch (e) {
        if (e instanceof RecruitingError) return e.message;
        throw e;
      }
    }
  }
  if (entity.key === "hrm-retention-rules") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select region_scope as "regionScope", basis as "basis", action as "action",
               retain_months as "retainMonths", consent_extension_lead_days as "consentExtensionLeadDays"
          from hrm_retention_rules where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Retention rule not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    if (values.basis !== undefined && !["inactivity", "consent"].includes(String(values.basis))) {
      return "The rule basis is inactivity or consent";
    }
    if (values.action !== undefined && !["anonymize", "delete"].includes(String(values.action))) {
      return "The rule action is anonymize or delete";
    }
    if (
      values.retainMonths !== undefined &&
      (!Number.isInteger(Number(values.retainMonths)) || Number(values.retainMonths) < 1)
    ) {
      return "Retention months is a positive integer";
    }
    if (
      values.consentExtensionLeadDays !== undefined &&
      values.consentExtensionLeadDays !== null &&
      (!Number.isInteger(Number(values.consentExtensionLeadDays)) ||
        Number(values.consentExtensionLeadDays) < 1)
    ) {
      return "Extension lead days is a positive integer, or empty for no extension email";
    }
    const scope = values.regionScope as Record<string, unknown> | null | undefined;
    if (scope !== undefined && scope !== null) {
      if (typeof scope !== "object" || Array.isArray(scope))
        return "The region scope is an object with applies_to all or countries";
      const appliesTo = (scope as Record<string, unknown>).applies_to;
      if (appliesTo !== undefined && appliesTo !== "all" && appliesTo !== "countries") {
        return "The region scope applies_to is all or countries";
      }
      if (appliesTo === "countries") {
        const countries = (scope as Record<string, unknown>).countries;
        if (
          !Array.isArray(countries) ||
          countries.length === 0 ||
          countries.some((code) => typeof code !== "string" || code.trim().length === 0)
        ) {
          return "The region scope names at least one country code";
        }
      }
    }
  }
  // HR-18 end
  // Compensation levels may leave assessment criteria undeclared. Every
  // declared weight remains positive and exact; the family, when
  // named, must be visible in this org. Bands order min <= target <=
  // max and scope to the level's own family — a band that prices a rung
  // against another family's ladder is refused by field name.
  if (entity.key === "hrm-job-levels") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select family_id as "familyId", equal_value_criteria as "equalValueCriteria"
          from hrm_job_levels where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Job level not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    const criteria = values.equalValueCriteria ?? [];
    const allowed = new Set(["skills", "effort", "responsibility", "working_conditions"]);
    if (!Array.isArray(criteria)) {
      return "Equal-value criteria must be a list; leave the weights empty until the approved assessment basis is configured";
    }
    for (const entry of criteria) {
      const row = entry as Record<string, unknown>;
      if (!row || !allowed.has(String(row.criterion)))
        return "Each criterion names skills, effort, responsibility, or working_conditions";
      if (
        typeof row.weight !== "string" ||
        canonicalDecimal(row.weight, Infinity) === null ||
        compareDecimal(row.weight, "0") <= 0
      ) {
        return "Each criterion needs a positive weight";
      }
    }
    if (values.familyId) {
      const family = await executor.execute(
        sql`
        select 1 from hrm_job_families where id = ${String(values.familyId)} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!family[0]) return "The family is not visible in this organization";
    }
    if (
      values.rank !== undefined &&
      (!Number.isInteger(Number(values.rank)) || Number(values.rank) < 1)
    ) {
      return "Rank is a positive integer ordering the ladder";
    }
  }
  if (entity.key === "hrm-pay-bands") {
    let currencyValues = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select currency, employer_subsidiary_id as "employerSubsidiaryId", min::text as min, target::text as target, max::text as max
          from hrm_pay_bands where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Pay band not found";
      currencyValues = { ...(current[0] as Record<string, unknown>), ...body };
    }
    const { organizationCurrencyAvailable } =
      await import("@openbooks/engine/organization/currencies");
    if (
      !(await organizationCurrencyAvailable(
        executor,
        orgId,
        String(currencyValues.currency ?? ""),
        currencyValues.employerSubsidiaryId ? String(currencyValues.employerSubsidiaryId) : null,
      ))
    ) {
      return "Choose an enabled currency for the pay band employer. Foreign currencies require Multi-currency in Company Settings → Features.";
    }
    const amounts: Record<string, string | null> = {};
    for (const key of ["min", "target", "max"]) {
      const raw = currencyValues[key];
      if (key === "target" && (raw === undefined || raw === null || raw === "")) {
        amounts[key] = null;
        continue;
      }
      const exact = canonicalDecimal(raw, 4);
      if (exact === null) return decimalNullRefusal(`Band ${key}`, "an exact amount", raw, 4);
      if (compareDecimal(exact, "0") <= 0) return `Band ${key} must be a positive amount`;
      amounts[key] = exact;
    }
    if (
      compareDecimal(amounts.min!, amounts.max!) > 0 ||
      (amounts.target !== null &&
        (compareDecimal(amounts.min!, amounts.target!) > 0 ||
          compareDecimal(amounts.target!, amounts.max!) > 0))
    ) {
      return "Order the band minimum <= maximum, with any approved target between them";
    }
    if (body.levelId) {
      const level = (
        await executor.execute(
          sql`
        select family_id as "familyId" from hrm_job_levels where id = ${String(body.levelId)} and org_id = ${orgId}
      `,
          "objects",
        )
      )[0] as Record<string, unknown> | undefined;
      if (!level) return "The level is not visible in this organization";
      if (body.familyId && String(body.familyId) !== String(level.familyId ?? "")) {
        return "Scope the band to the level's own family, or to no family for the org-wide ladder";
      }
    }
  }
  return INTEGRITY_CONTINUES;
}
