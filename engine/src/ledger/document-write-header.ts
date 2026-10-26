import { sql, type SQL } from "drizzle-orm";
import { documentTaxDate, staleTaxRateLine } from "../tax/document-tax-date.ts";
import { parseCanadianGoodsSelection } from "@openbooks/engine/tax";
import { db } from "../platform/db.ts";
import {
  subsidiaryScopeAllows,
  subsidiaryVisibleFilter,
} from "../organization/subsidiary-scope.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { withBypassContext } from "../platform/db.ts";
import type { DocKindConfig } from "../records/document-kinds.ts";
import { DOCUMENT_CONTROL_SIDE } from "./posting-control-account.ts";
import { isFeatureEnabled } from "../organization/feature-state.ts";
import {
  findUnownedCustomReferences,
  hiddenCustomFieldRefusal,
  loadCustomFieldAccessDefs,
  loadFieldDefs,
  validateCustomValues,
  type CustomFieldViewer,
} from "../records/custom-fields.ts";
import type { resolveExternalRefPair } from "../records/external-ref.ts";
import { documentWorkDatesRefusal } from "../records/work-period.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import type { DocumentEditInput, DocumentEditCurrent } from "./document-input.ts";
import { EXPLICIT_FX_DOCUMENT_KINDS, type DocumentFxEditPlan } from "./document-fx.ts";
import type {
  DocumentEditContext,
  DocumentEditRunner,
  DocumentTransaction,
  ValidatedHeaderDims,
} from "./document-write-context.ts";

/**
 * Party, subsidiary, header dates and header reference ids: shape, tenant
 * ownership and the caller's subsidiary scope, refused before any write.
 */
export async function assertEditHeaderReferences(args: {
  current: DocumentEditCurrent;
  body: DocumentEditInput;
  ctx: DocumentEditContext;
  cfg: DocKindConfig;
  runner: DocumentEditRunner;
}): Promise<void> {
  const { current, body, ctx, cfg, runner } = args;
  const { orgId } = ctx;
  // Kinds with a party role (vendor/customer) must keep a party — an explicit
  // null would strand the document without the entity its posting depends on.
  if (cfg.partyRole && body.partyId === null) {
    throw new DocumentEditError(
      422,
      `a ${current.kind} requires a ${cfg.partyRole}; the party cannot be removed`,
    );
  }
  // Every document carries its legal entity: posting falls back to the root
  // when it is null, but every subsidiary-scoped list excludes null, so an
  // explicit null would hide a live document from restricted readers while
  // its ledger entries remain. Creation always assigns the root; null is
  // never a legitimate assignment.
  if (body.subsidiaryId === null) {
    throw new DocumentEditError(
      422,
      `a ${current.kind} requires a subsidiary; the subsidiary cannot be removed`,
    );
  }
  if (body.subsidiaryId !== undefined && body.subsidiaryId !== null) {
    if (!isUuid(body.subsidiaryId)) throw new DocumentEditError(422, "invalid subsidiaryId");
    const subsidiary = await runner.execute(
      sql`
      select 1 from subsidiaries
       where id = ${body.subsidiaryId} and org_id = ${orgId}
         and is_active and not is_elimination`,
      "objects",
    );
    if (!subsidiary.length) throw new DocumentEditError(422, "invalid subsidiary");
  }
  // Header dates and reference ids reach DATE/uuid columns uncast: a malformed
  // value dies at the storage layer as a raw 500 instead of a domain error.
  // Fail closed here — once, for every caller (UI routes, public API, MCP,
  // assistant) — covering both shape-invalid strings and impossible days.
  // Explicit nulls keep their existing clear-the-field semantics.
  const headerDates = [
    body.documentDate,
    body.dueDate,
    body.postingDate,
    body.expectedPayDate,
  ] as const;
  const headerDateNames = ["documentDate", "dueDate", "postingDate", "expectedPayDate"] as const;
  for (let i = 0; i < headerDates.length; i++) {
    const value = headerDates[i];
    if (value !== undefined && value !== null && !isIsoCalendarDate(value)) {
      throw new DocumentEditError(422, `invalid ${headerDateNames[i]} — expected YYYY-MM-DD`);
    }
  }
  const workDatesRefusal = documentWorkDatesRefusal(current.kind, body.workCompletedOn, body.lines);
  if (workDatesRefusal) throw new DocumentEditError(422, workDatesRefusal);
  const headerRefs = [
    body.partyId,
    body.paymentCardId,
    body.departmentId,
    body.projectId,
    body.locationId,
    body.classId,
  ] as const;
  const headerRefNames = [
    "partyId",
    "paymentCardId",
    "departmentId",
    "projectId",
    "locationId",
    "classId",
  ] as const;
  for (let i = 0; i < headerRefs.length; i++) {
    const value = headerRefs[i];
    if (value !== undefined && value !== null && !isUuid(value)) {
      throw new DocumentEditError(422, `invalid ${headerRefNames[i]}`);
    }
  }
  // Tenant ownership of every referenced header id. The composite FKs would
  // refuse a foreign id at the write as an unhandled storage error (raw
  // 500); refuse it here with a tenant-opaque 404 that reveals nothing about
  // other tenants' records — same contract as the line-account precheck
  // below. Only ids actually present are looked up.
  const headerOwners: {
    label: string;
    table: "parties" | "payment_cards" | "departments" | "projects" | "locations" | "classes";
    value: string;
  }[] = [];
  if (body.partyId !== undefined && body.partyId !== null)
    headerOwners.push({ label: "party", table: "parties", value: body.partyId });
  if (body.paymentCardId !== undefined && body.paymentCardId !== null)
    headerOwners.push({ label: "payment card", table: "payment_cards", value: body.paymentCardId });
  if (body.departmentId !== undefined && body.departmentId !== null)
    headerOwners.push({ label: "department", table: "departments", value: body.departmentId });
  if (body.projectId !== undefined && body.projectId !== null)
    headerOwners.push({ label: "project", table: "projects", value: body.projectId });
  if (body.locationId !== undefined && body.locationId !== null)
    headerOwners.push({ label: "location", table: "locations", value: body.locationId });
  if (body.classId !== undefined && body.classId !== null)
    headerOwners.push({ label: "class", table: "classes", value: body.classId });
  for (const ref of headerOwners) {
    const owned = await runner.execute(
      sql`select 1 from ${sql.raw(`"${ref.table}"`)} where id = ${ref.value} and org_id = ${orgId}`,
      "objects",
    );
    if (!owned.length)
      throw new DocumentEditError(404, `${ref.label} not found in this organization`);
  }
  // Subsidiary scope of a newly assigned party. The pickers only offer
  // subsidiary-visible parties, so a scoped-out party id arrives only by
  // hand-crafted request: refuse it with the uniform not-found rather than
  // bind a document the caller may not reference. An unchanged party is
  // grandfathered — its binding predates scope and no new reference forms.
  // Null-subsidiary parties are org-wide shared, like the option lists.
  if (body.partyId !== undefined && body.partyId !== null && body.partyId !== current.partyId) {
    if (ctx.customerPartyId === undefined || body.partyId !== ctx.customerPartyId) {
      const partyScope = await runner.execute<{ subsidiary_id: string | null }>(
        sql`
        select subsidiary_id from parties where id = ${body.partyId} and org_id = ${orgId}`,
        "objects",
      );
      const partySubsidiaryId = partyScope[0]?.subsidiary_id ?? null;
      // bypass: user-keyed-lookup — the actor can belong to a different organization.
      const allowed = await withBypassContext(() =>
        actorAllowedSubsidiaryIds(db, orgId, ctx.userId),
      );
      if (!subsidiaryScopeAllows(allowed, partySubsidiaryId, { orgWideNull: true })) {
        throw new DocumentEditError(404, "not found");
      }
    }
  }
}

/**
 * The edited document currency (undefined keeps the stored one), gated by
 * multi-currency, and the explicit-rate capability check.
 */
export async function resolveEditCurrency(args: {
  current: DocumentEditCurrent;
  body: DocumentEditInput;
  orgId: string;
  runner: DocumentEditRunner;
  referenceSubsidiaryId: string | null | undefined;
}): Promise<string | undefined> {
  const { current, body, orgId, runner, referenceSubsidiaryId } = args;
  let currency: string | undefined;
  if (body.currency !== undefined) {
    const code = String(body.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw new DocumentEditError(422, "invalid currency");
    const found = await runner.execute(
      sql`select 1 from currencies where code = ${code}`,
      "objects",
    );
    if (!found[0]) throw new DocumentEditError(422, "invalid currency");
    const entityCurrency = referenceSubsidiaryId
      ? (
          await runner.execute<{ currency: string | null }>(
            sql`
          select nullif(trim(base_currency), '') as currency from subsidiaries
           where org_id = ${orgId} and id = ${referenceSubsidiaryId} and is_active`,
            "objects",
          )
        )[0]?.currency
      : undefined;
    if (!(await isFeatureEnabled(orgId, "multiCurrency")) && code !== entityCurrency) {
      throw new DocumentEditError(404, "not found");
    }
    currency = code;
  }
  // Recording an explicit rate is a multi-currency capability; clearing one
  // stays available so recorded evidence never strands a draft.
  if (body.explicitFx !== undefined && body.explicitFx !== null) {
    if (!(await isFeatureEnabled(orgId, "multiCurrency")))
      throw new DocumentEditError(404, "not found");
    if (!EXPLICIT_FX_DOCUMENT_KINDS.has(current.kind)) {
      throw new DocumentEditError(
        422,
        "an explicit exchange rate can be recorded only on customer invoices, vendor bills, customer credits and vendor credits",
      );
    }
  }
  return currency;
}

/** The merged header custom bag a save writes, or null when the save supplies no custom values. */
export async function mergeSuppliedHeaderCustom(args: {
  current: DocumentEditCurrent;
  body: DocumentEditInput;
  orgId: string;
  headerDefs: Awaited<ReturnType<typeof loadFieldDefs>>;
  headerAccessDefs: Awaited<ReturnType<typeof loadCustomFieldAccessDefs>>;
  customFieldViewer: CustomFieldViewer;
}): Promise<Record<string, unknown> | null> {
  const { current, body, orgId, headerDefs, headerAccessDefs, customFieldViewer } = args;
  let headerCustom: Record<string, unknown> | null = null;
  if (body.custom !== undefined) {
    const supplied = body.custom;
    const existingCustom = current.custom ?? {};
    const hiddenHeader = hiddenCustomFieldRefusal(
      headerAccessDefs.map((def) => ({ ...def, isRequired: false })),
      customFieldViewer,
      supplied,
      existingCustom,
    );
    if (hiddenHeader) {
      throw new DocumentEditError(403, hiddenHeader.message, {
        [hiddenHeader.key]: hiddenHeader.message,
      });
    }
    for (const key of ["withholdingRemittance", "withholdingDeposit"]) {
      if (
        Object.hasOwn(supplied, key) &&
        JSON.stringify(supplied[key]) !== JSON.stringify(existingCustom[key])
      )
        throw new DocumentEditError(
          422,
          "Withholding source evidence is written by the native withholding workflow and cannot be changed as a custom field.",
        );
    }
    const v = validateCustomValues(headerDefs, { ...existingCustom, ...supplied });
    if (!v.ok) throw new DocumentEditError(422, Object.values(v.errors)[0]!, v.errors);
    // Reference custom values are uuid-SHAPED at this point but nothing
    // proves the referenced row belongs to the caller: refuse foreign or
    // dangling ids with a tenant-opaque 404 instead of persisting a
    // cross-tenant pointer. Supplied values only, so legacy bags written
    // before this fence cannot lock unrelated edits.
    const suppliedHeaderCustom: Record<string, unknown> = {};
    for (const key of Object.keys(supplied)) {
      if (v.cleaned[key] !== undefined) suppliedHeaderCustom[key] = v.cleaned[key];
    }
    const unownedHeaderRefs = await findUnownedCustomReferences(
      orgId,
      headerDefs,
      suppliedHeaderCustom,
    );
    if (unownedHeaderRefs.length > 0) {
      const def = unownedHeaderRefs[0]!;
      throw new DocumentEditError(404, `${def.label} not found in this organization`, {
        [def.key]: "not found in this organization",
      });
    }
    headerCustom = { ...existingCustom, ...v.cleaned };
    for (const key of ["withholdingRemittance", "withholdingDeposit"]) {
      if (Object.hasOwn(existingCustom, key)) headerCustom[key] = existingCustom[key];
      else delete headerCustom[key];
    }
    if (Object.prototype.hasOwnProperty.call(supplied, "canadianGoodsTax")) {
      const selection = parseCanadianGoodsSelection(supplied.canadianGoodsTax);
      if (selection) headerCustom.canadianGoodsTax = selection;
      else delete headerCustom.canadianGoodsTax;
    }
    for (const def of headerDefs) {
      if (Object.prototype.hasOwnProperty.call(supplied, def.key) && supplied[def.key] == null) {
        delete headerCustom[def.key];
      }
    }
  }
  return headerCustom;
}

/** A header-only save may not leave line tax computed for another date, entity or currency. */
export async function assertHeaderOnlyEditTaxCurrent(args: {
  id: string;
  current: DocumentEditCurrent;
  body: DocumentEditInput;
  headerCustom: Record<string, unknown> | null;
  currency: string | undefined;
  runner: DocumentEditRunner;
  orgId: string;
}): Promise<void> {
  const { id, current, body, headerCustom, currency, runner, orgId } = args;
  if (
    body.lines === undefined &&
    (current.custom?.canadianGoodsTax || headerCustom?.canadianGoodsTax) &&
    (JSON.stringify(current.custom?.canadianGoodsTax) !==
      JSON.stringify(headerCustom?.canadianGoodsTax ?? current.custom?.canadianGoodsTax) ||
      (body.custom &&
        Object.prototype.hasOwnProperty.call(body.custom, "canadianGoodsTax") &&
        !body.custom.canadianGoodsTax) ||
      (body.documentDate !== undefined && body.documentDate !== current.documentDate) ||
      (body.subsidiaryId !== undefined && body.subsidiaryId !== current.subsidiaryId) ||
      currency !== undefined)
  )
    throw new DocumentEditError(
      422,
      "Save the invoice lines with the changed goods supply assessment, date, currency or selling entity so its native tax can be recalculated",
    );
  // Tax rates are effective-dated by the document date. A header-only date
  // change keeps the stored line tax, so it is refused whenever a calculated
  // line's rate differs on the new date — otherwise the draft would post the
  // old period's tax. Saving the lines with the date recalculates them.
  // A credit correcting an earlier supply keeps that supply's tax date, so
  // its own date change leaves the tax date where it was.
  if (
    body.lines === undefined &&
    body.documentDate !== undefined &&
    body.documentDate !== current.documentDate
  ) {
    const taxDate = await documentTaxDate(runner, orgId, id, body.documentDate);
    const stale = await staleTaxRateLine(runner, orgId, id, taxDate);
    if (stale) {
      throw new DocumentEditError(
        422,
        `Line ${stale.line_number} carries ${stale.code} at ${stale.stored}%, but ${stale.effective === null ? "no rate is" : `${stale.effective}% is`} in effect on ${taxDate} — ` +
          "save the lines together with the new date so their tax is recalculated at the rates in effect on that date",
      );
    }
  }
}

/** Returns the header custom bag with the funding-account override applied. */
export async function applyFundingOverride(args: {
  cfg: DocKindConfig;
  body: DocumentEditInput;
  current: DocumentEditCurrent;
  headerCustom: Record<string, unknown> | null;
  runner: DocumentEditRunner;
  orgId: string;
  ctx: DocumentEditContext;
  referenceSubsidiaryScope: SQL;
}): Promise<Record<string, unknown> | null> {
  const { cfg, body, current, runner, orgId, ctx, referenceSubsidiaryScope } = args;
  let { headerCustom } = args;
  // Structural funding override (the drawer's fundingSource picker: deposit
  // destination, check source, card liability). It is not a registered
  // custom field, so validateCustomValues cannot see it — without an
  // explicit carry the picker silently stops persisting (the save succeeds
  // and the reopen shows '—'). Fence it like a reference: uuid-shaped and
  // owned by this org's reconcilable funding accounts of the kind's type,
  // the exact set the picker lists. An absent key leaves the stored bag
  // untouched; an explicit null/'' clears back to the org default.
  // The bank carry extends to fundingSource='card':
  // with no card instruments on file the drawer offers reconcilable
  // card-liability accounts, saved as the controlAccountId override the
  // engine cardRule already reads first.
  const fundingAccountType =
    cfg?.fundingSource === "bank"
      ? "asset_bank"
      : cfg?.fundingSource === "card"
        ? "liability_card"
        : null;
  const fundingNoun = cfg?.fundingSource === "card" ? "card liability account" : "bank account";
  if (body.custom !== undefined && fundingAccountType) {
    const override = (body.custom as Record<string, unknown>).controlAccountId;
    if (override !== undefined) {
      if (override === null || override === "") {
        if (headerCustom) delete headerCustom.controlAccountId;
      } else {
        if (typeof override !== "string" || !isUuid(override)) {
          throw new DocumentEditError(
            422,
            `${cfg?.fundingSource === "card" ? "card account" : "funding bank"} must be a valid record reference`,
          );
        }
        const owned = await runner.execute<{ id: string }>(
          sql`
          select a.id from accounts a
           where a.org_id = ${orgId} and a.is_active and not a.is_summary
             and a.reconcilable and a.type = ${fundingAccountType} and a.id = ${override}::uuid
             and ${referenceSubsidiaryScope}
             ${ctx.allowedSubsidiaryIds === undefined ? sql`` : subsidiaryVisibleFilter(sql`a.subsidiary_id`, ctx.allowedSubsidiaryIds, { orgWideNull: true })}
           for key share
        `,
          "objects",
        );
        if (!owned[0])
          throw new DocumentEditError(404, `${fundingNoun} not found for this subsidiary`);
        headerCustom = { ...(headerCustom ?? current.custom ?? {}), controlAccountId: override };
      }
    }
  }
  return headerCustom;
}

/** Returns the header custom bag with the receivable/payable account choice applied. */
export async function applyControlAccountChoice(args: {
  body: DocumentEditInput;
  current: DocumentEditCurrent;
  headerCustom: Record<string, unknown> | null;
  runner: DocumentEditRunner;
  orgId: string;
  ctx: DocumentEditContext;
  referenceSubsidiaryScope: SQL;
}): Promise<Record<string, unknown> | null> {
  const { body, current, runner, orgId, ctx, referenceSubsidiaryScope } = args;
  let { headerCustom } = args;
  // Receivable/payable account choice on a party document (invoice, credit
  // memo, bill, vendor credit). Like the funding override it is not a
  // registered custom field, so it is carried explicitly: uuid-shaped, an
  // active posting account of the side's type, visible to the document's
  // legal entity. An explicit null/'' clears the choice so posting resolves
  // the party default, else the organization control account.
  const controlSide = DOCUMENT_CONTROL_SIDE[current.kind];
  if (body.custom !== undefined && controlSide) {
    const choice = (body.custom as Record<string, unknown>).controlAccountId;
    if (choice !== undefined) {
      const noun = controlSide === "ar" ? "receivable account" : "payable account";
      if (choice === null || choice === "") {
        headerCustom = { ...(headerCustom ?? current.custom ?? {}) };
        delete headerCustom.controlAccountId;
      } else {
        if (typeof choice !== "string" || !isUuid(choice)) {
          throw new DocumentEditError(422, `${noun} must be a valid record reference`);
        }
        const accountType = controlSide === "ar" ? "asset_receivable" : "liability_payable";
        const owned = await runner.execute<{ id: string }>(
          sql`
          select a.id from accounts a
           where a.org_id = ${orgId} and a.is_active and not a.is_summary
             and a.type = ${accountType} and a.id = ${choice}::uuid
             and ${referenceSubsidiaryScope}
             ${ctx.allowedSubsidiaryIds === undefined ? sql`` : subsidiaryVisibleFilter(sql`a.subsidiary_id`, ctx.allowedSubsidiaryIds, { orgWideNull: true })}
           for key share
        `,
          "objects",
        );
        if (!owned[0]) {
          throw new DocumentEditError(
            422,
            `choose an active ${noun} available to this document's subsidiary, or clear the choice to use the ${controlSide === "ar" ? "customer's" : "vendor's"} default`,
            { controlAccountId: `not an active ${noun} for this subsidiary` },
          );
        }
        headerCustom = { ...(headerCustom ?? current.custom ?? {}), controlAccountId: choice };
      }
    }
  }
  return headerCustom;
}

/** Write the edited header; absent fields keep their stored values. */
export async function writeEditedHeader(
  tx: DocumentTransaction,
  args: {
    id: string;
    orgId: string;
    userId: string;
    body: DocumentEditInput;
    external: ReturnType<typeof resolveExternalRefPair>;
    headerDims: ValidatedHeaderDims;
    targetSubsidiaryId: string | null;
    currency: string | undefined;
    fxPlan: DocumentFxEditPlan;
    headerCustom: Record<string, unknown> | null;
    totals: { subtotal: string; taxTotal: string; total: string } | null;
  },
): Promise<void> {
  const {
    id,
    orgId,
    userId,
    body,
    external,
    headerDims,
    targetSubsidiaryId,
    currency,
    fxPlan,
    headerCustom,
    totals,
  } = args;
  await tx.execute(sql`
        update documents set
          party_id = ${body.partyId !== undefined ? body.partyId : sql`party_id`},
          payment_card_id = ${body.paymentCardId !== undefined ? body.paymentCardId : sql`payment_card_id`},
          document_date = coalesce(${body.documentDate ?? null}, document_date),
          due_date = ${body.dueDate !== undefined ? body.dueDate : sql`due_date`},
          reference_number = ${body.referenceNumber !== undefined ? body.referenceNumber : sql`reference_number`},
          external_ref = ${external.action === "set" ? external.ref : external.action === "clear" ? null : sql`external_ref`},
          external_source = ${external.action === "set" ? external.source : external.action === "clear" ? null : sql`external_source`},
          memo = ${body.memo !== undefined ? body.memo : sql`memo`},
          posting_date = ${body.postingDate !== undefined ? body.postingDate : sql`posting_date`},
          department_id = ${body.departmentId !== undefined ? body.departmentId : sql`department_id`},
          project_id = ${body.projectId !== undefined ? body.projectId : sql`project_id`},
          location_id = ${body.locationId !== undefined ? body.locationId : sql`location_id`},
          class_id = ${body.classId !== undefined ? body.classId : sql`class_id`},
          extra_dims = ${headerDims ? JSON.stringify(headerDims.cleaned) : sql`extra_dims`}::jsonb,
          subsidiary_id = ${targetSubsidiaryId},
          expected_pay_date = ${body.expectedPayDate !== undefined ? body.expectedPayDate : sql`expected_pay_date`},
          work_completed_on = ${body.workCompletedOn !== undefined ? body.workCompletedOn : sql`work_completed_on`},
          payment_hold_reason = ${body.paymentHoldReason !== undefined ? body.paymentHoldReason : sql`payment_hold_reason`},
          internal_notes = ${body.internalNotes !== undefined ? body.internalNotes : sql`internal_notes`},
          billing_method = ${body.billingMethod !== undefined ? body.billingMethod : sql`billing_method`},
          is_final_invoice = ${body.isFinalInvoice !== undefined ? body.isFinalInvoice : sql`is_final_invoice`},
          currency = ${currency !== undefined ? currency : sql`currency`},
          fx_rate = ${fxPlan.action === "set" ? fxPlan.evidence.rate : fxPlan.action === "clear" ? "1" : sql`fx_rate`},
          document_fx_rate_evidence = ${fxPlan.action === "set" ? JSON.stringify(fxPlan.evidence) : fxPlan.action === "clear" ? null : sql`document_fx_rate_evidence`}::jsonb,
          custom = coalesce(${headerCustom ? JSON.stringify(headerCustom) : null}::jsonb, custom),
          subtotal = coalesce(${totals?.subtotal ?? null}, subtotal),
          tax_total = coalesce(${totals?.taxTotal ?? null}, tax_total),
          total = coalesce(${totals?.total ?? null}, total),
          updated_at = greatest(
            clock_timestamp(),
            updated_at + interval '1 microsecond'
          ),
          updated_by = ${userId}
        where id = ${id} and org_id = ${orgId}
      `);
}
