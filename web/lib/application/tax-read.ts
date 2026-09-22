import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { computeTaxReturn, TaxReturnError } from "@openbooks/engine/src/tax-returns/return.ts";
import { normalizeMoneyValue } from "../cash/core";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { invalidInput } from "./errors";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Indirect-tax return forms for this org — the same rows `list_tax_return_forms`
 * and the /tax filing screen read (`tax_return_forms` + registration count).
 * Read-only; gated on `reports.read` exactly like the filing screen.
 */
export async function listApplicationTaxReturnForms(context: ApplicationContext) {
  assertApplicationPermission(context, "reports.read");
  const rows = await db.execute<{
    code: string;
    name: string;
    country: string | null;
    submission_channel: string;
    is_active: boolean;
    registrations: number;
  }>(sql`
    select f.code, f.name, f.country, f.submission_channel, f.is_active,
           (select count(*)::int from tax_registrations r
             where r.org_id = f.org_id and r.return_form_code = f.code) as registrations
      from tax_return_forms f
     where f.org_id = ${context.authz.user.orgId}
     order by f.is_active desc, f.country, f.code`);
  return {
    total: rows.rows.length,
    forms: rows.rows.map((row) => ({
      code: row.code,
      name: row.name,
      country: row.country,
      submissionChannel: row.submission_channel,
      active: row.is_active,
      registrations: row.registrations,
    })),
  };
}

export interface TaxReturnReadInput {
  formCode: string;
  from: string;
  to: string;
  subsidiaryIds?: string[];
  registrationId?: string;
  presentationCurrency?: string;
  rateType?: string;
  rateDate?: string;
}

/**
 * One filing entity's computed return — the SAME engine the /tax filing
 * screen, the export route, and the `tax_return` assistant tool use
 * (`computeTaxReturn`: clamped to the form's filing window,
 * registration-aware, one repeatable-read snapshot). Box values are exact
 * decimal strings via `normalizeMoneyValue` — never floats.
 */
export async function getApplicationTaxReturn(context: ApplicationContext, input: TaxReturnReadInput) {
  assertApplicationPermission(context, "reports.read");
  const formCode = (input.formCode ?? "").trim();
  if (!formCode || formCode.length > 40) {
    throw invalidInput("formCode is required, e.g. CA_GST34");
  }
  if (!input.from || !DATE_RE.test(input.from) || !input.to || !DATE_RE.test(input.to)) {
    throw invalidInput("from and to dates (YYYY-MM-DD) are required");
  }
  const subsidiaryIds = (input.subsidiaryIds ?? []).map((id) => id.trim()).filter(Boolean);
  // Mirror the filing screen: an explicitly scoped filing entity is checked
  // per subsidiary; anything else is the org-wide return, which restricted
  // callers may never blend — fail closed just like guardSubsidiaryScope.
  if (subsidiaryIds.length > 0) {
    for (const id of subsidiaryIds) assertSubsidiaryAccess(context, id);
  } else {
    assertSubsidiaryAccess(context, null);
  }
  const registrationId = input.registrationId?.trim() || undefined;
  const presentationCurrency = input.presentationCurrency?.trim().toUpperCase() || undefined;
  if (presentationCurrency && !CURRENCY_RE.test(presentationCurrency)) {
    throw invalidInput("presentationCurrency must be an ISO 4217 code, e.g. CAD");
  }
  const rateDate = input.rateDate?.trim() || undefined;
  if (rateDate && !DATE_RE.test(rateDate)) {
    throw invalidInput("rateDate must be YYYY-MM-DD");
  }
  const rateType = input.rateType?.trim() || undefined;
  let result;
  try {
    result = await computeTaxReturn(
      context.authz.user.orgId,
      formCode,
      input.from,
      input.to,
      {},
      {
        ...(subsidiaryIds.length > 0 || registrationId
          ? { filingEntity: { subsidiaryIds, ...(registrationId ? { registrationId } : {}) } }
          : {}),
        ...(presentationCurrency || rateType || rateDate
          ? {
              translation: {
                presentationCurrency: presentationCurrency ?? "",
                ...(rateType ? { rateType } : {}),
                ...(rateDate ? { rateDate } : {}),
              },
            }
          : {}),
      },
    );
  } catch (error) {
    // The engine refuses unknown forms, uncovered periods, and unresolvable
    // scopes by name — surface that refusal as a 422 with its message intact,
    // never as success or a bare 500.
    if (error instanceof TaxReturnError) throw invalidInput(error.message);
    throw error;
  }
  return {
    formCode: result.formCode,
    formName: result.formName,
    from: result.from,
    to: result.to,
    currency: result.functionalCurrency,
    registrationNumber: result.registrationNumber,
    submissionChannel: result.submissionChannel,
    subsidiaryIds: result.subsidiaryIds,
    registrationId: result.registrationId,
    boxes: result.boxes.map((box) => ({
      lineCode: box.lineCode,
      label: box.label,
      value: normalizeMoneyValue(String(box.value)),
      computed: box.computed,
      editable: box.editable,
      pdfField: box.pdfField,
    })),
    translation: result.translation
      ? {
          presentationCurrency: result.translation.presentationCurrency,
          rateType: result.translation.rateType,
          rateDate: result.translation.rateDate,
          entities: result.translation.entities.map((entity) => ({
            subsidiaryId: entity.subsidiaryId,
            name: entity.name,
            currency: entity.currency,
            // A policy rate, not money: pass the engine's exact decimal
            // string through untouched — money normalization would force
            // ledger precision and refuse legitimate rate precision.
            fxRate: String(entity.fxRate),
            rateAsOf: entity.rateAsOf,
            boxes: entity.boxes.map((box) => ({
              lineCode: box.lineCode,
              label: box.label,
              value: normalizeMoneyValue(String(box.value)),
              computed: box.computed,
              editable: box.editable,
              pdfField: box.pdfField,
            })),
          })),
        }
      : null,
  };
}
