import { sql, type SQL } from "drizzle-orm";
import { documentTaxDate } from "../tax/document-tax-date.ts";
import { amortizationLineRefusal } from "../amortization/source-fields.ts";
import { db } from "../platform/db.ts";
import {
  cmp,
  fitsLedgerRange,
  ledgerSideTotals,
  normalizeDecimal,
  normalizeMoney,
  wholeDigits,
} from "../money/money.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { computeBillTotalsWithProvider, taxProfileMap } from "./document-totals.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { postingPreconditionHooks } from "../journal/posting-preconditions.ts";
import {
  findUnownedCustomReferences,
  loadFieldDefs,
  validateCustomValues,
} from "../records/custom-fields.ts";
import { segmentRegistry, validateExtraDims } from "../organization/segments.ts";
import { businessToday } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { PROVIDER_COMMIT_KINDS } from "@openbooks/engine/tax";
import { decimalNullRefusal } from "../money/decimal-refusal.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import type {
  DocumentLineInput,
  DocumentEditInput,
  DocumentEditCurrent,
} from "./document-input.ts";
import type { EntryPlan } from "../journal/entry-allocation-plan.ts";
import {
  documentTaxProviderAddresses,
  orgBaseCurrency,
  type DocumentEditContext,
  type DocumentEditRunner,
  type PreparedDocumentLine,
  type PreparedDocumentTotals,
} from "./document-write-context.ts";
import { planDocumentEntryAllocations } from "./document-write-allocations.ts";
import {
  NATIVE_LINE_CUSTOM_KEYS,
  stripSubmittedLineProvenance,
  submittedLineIdentities,
} from "./document-write-provenance.ts";

/** Exact numeric(19,4) money string, or null when the value is not canonical. */
function exactMoney(value: unknown): string | null {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) return null;
  try {
    return normalizeMoney(exact);
  } catch {
    return null;
  }
}

/** unit_price columns are numeric(28,8): a saved line reads back at storage
 * scale, so validation must accept it — otherwise no saved document can ever
 * be re-saved. Line amounts and totals stay 4dp (exactMoney above). */
function exactUnitPrice(value: unknown): string | null {
  const exact = canonicalDecimal(value, 8);
  if (exact === null) return null;
  // Twenty whole digits fit numeric(28,8); anything wider dies in Postgres.
  if (wholeDigits(exact) > 20) return null;
  try {
    return normalizeDecimal(exact, 8);
  } catch {
    return null;
  }
}

/**
 * Draft-line validation for the generic editor. Negative and zero lines are
 * legitimate (the tax engine computes signed bases) and pass through untouched;
 * the only rejections are what the calculator cannot use — a missing account,
 * or an amount that is not an exact decimal within ledger scale — and each
 * names its line so the editor can point at the cell.
 */
export function validateEditableDocumentLines(lines: DocumentLineInput[]): DocumentLineInput[] {
  const amounts: string[] = [];
  const out = lines.map((l, i) => {
    const n = i + 1;
    if (
      l.withholdingTreatment != null &&
      !["labour", "materials", "excluded"].includes(l.withholdingTreatment)
    )
      throw new DocumentEditError(
        422,
        `Line ${n}: choose labour, materials or excluded for withholding`,
      );
    if (!l.accountId) {
      throw new DocumentEditError(422, `Line ${n}: an account is required`);
    }
    if (l.amount === undefined || l.amount === null || String(l.amount).trim() === "") {
      throw new DocumentEditError(422, `Line ${n}: an amount is required`);
    }
    const exactAmount = exactMoney(l.amount);
    if (exactAmount === null) {
      throw new DocumentEditError(
        422,
        decimalNullRefusal(`Line ${n} amount`, "an exact decimal amount", l.amount, 4),
      );
    }
    // document_lines.amount is numeric(19,4): the format check above admits
    // any magnitude, so a pasted 16-digit figure died in Postgres with a
    // storage error (a 500). Refuse it here with the line number, through
    // the one shared ledger bound the script paths use.
    if (!fitsLedgerRange(exactAmount)) {
      throw new DocumentEditError(
        422,
        `Line ${n}: amount is out of range — at most 15 whole digits fit the ledger`,
      );
    }
    if (l.withholdingMaterialsCost != null) {
      const cost = exactMoney(l.withholdingMaterialsCost);
      if (cost === null)
        throw new DocumentEditError(
          422,
          decimalNullRefusal(
            `Line ${n} direct materials cost`,
            "an exact decimal amount",
            l.withholdingMaterialsCost,
            4,
          ),
        );
      if (!fitsLedgerRange(cost) || cmp(cost, "0") < 0 || cmp(cost, exactAmount) > 0) {
        throw new DocumentEditError(
          422,
          `Line ${n}: direct materials cost must be nonnegative and no greater than the net line amount`,
        );
      }
    }
    amounts.push(exactAmount);
    // Quantity is informational beside the amount, but it persists into the
    // numeric(28,8) column verbatim: junk or blank text died in Postgres with
    // a storage error (a 500), and anything past 8dp was silently rounded to
    // the column scale. Validate at the column's own scale — the same 8dp
    // contract the billing invoice writer (lib/bills.ts
    // persistInvoiceQuantity) already enforces — and refuse magnitudes the
    // column cannot hold (twenty whole digits) with the line number.
    if (l.quantity !== undefined && l.quantity !== null) {
      const exact = canonicalDecimal(l.quantity, 8);
      if (exact === null) {
        throw new DocumentEditError(
          422,
          decimalNullRefusal(`Line ${n} quantity`, "an exact decimal quantity", l.quantity, 8),
        );
      }
      if (wholeDigits(exact) > 20) {
        throw new DocumentEditError(
          422,
          `Line ${n}: quantity is out of range — at most 20 whole digits fit the ledger`,
        );
      }
    }
    return l;
  });
  // In-range lines can still sum past the stored document total, which is
  // numeric(19,4) like every other money column: refuse the debit/credit
  // side totals by name instead of dying in Postgres.
  const { debits, credits } = ledgerSideTotals(amounts);
  if (!fitsLedgerRange(debits)) {
    throw new DocumentEditError(
      422,
      `draft debit total is out of range — at most 15 whole digits fit the ledger`,
    );
  }
  if (!fitsLedgerRange(credits)) {
    throw new DocumentEditError(
      422,
      `draft credit total is out of range — at most 15 whole digits fit the ledger`,
    );
  }
  return out;
}

/**
 * Line-level marketplace collector check. Pure so the refusal text — the
 * entire product of a failed save — is pinned by unit tests: an unknown or
 * inactive name refuses with the setup remedy that resolves it. Blank input
 * never reaches this helper (the merchant collects), and kind gating stays
 * at the call site, where the document kind is in scope.
 */
export function marketplaceFacilitatorNameRefusal(
  name: string,
  activeNames: Set<string>,
): string | null {
  if (!activeNames.has(name)) {
    return `marketplace facilitator "${name}" is not configured — add it in Setup → Taxes → Marketplace facilitators`;
  }
  return null;
}

/**
 * Silent single-warehouse default: a stocked line with no explicit warehouse
 * takes the org's only active location, so nobody answers a question with
 * one possible answer. Several locations (or a non-stocked item) leave the
 * line blank for the picker, and the stamped id flows through the same
 * ownership checks as an explicitly chosen one. This only ever fills blanks,
 * matching what the posting reader would resolve the line to. Runs before
 * the totals preflight on creates (whose precomputed lines the writer reuses
 * verbatim) and again on every edit; filling blanks twice is idempotent.
 */
export async function stampSingleWarehouseDefault<
  Line extends { itemId?: string | null; stockLocationId?: string | null },
>(orgId: string, lines: Line[]): Promise<Line[]> {
  if (!lines.some((l) => (l.stockLocationId ?? "") === "")) return lines;
  const inventory = postingPreconditionHooks.require("inventory");
  const active = await inventory.activeStockLocations(orgId);
  const singleDefault = active.length === 1 ? active[0]!.id : null;
  if (!singleDefault) return lines;
  const profiled = await inventory.profiledItemIds(
    orgId,
    lines.map((l) => l.itemId).filter((v): v is string => typeof v === "string" && v.length > 0),
  );
  return lines.map((l) =>
    (l.stockLocationId ?? "") === "" && l.itemId && profiled.has(l.itemId)
      ? { ...l, stockLocationId: singleDefault }
      : l,
  );
}

/**
 * Resolve provider tax before a create writer mints its draft row. The result
 * is an internal hand-off to applyDocumentEdit; callers must never accept it
 * from an HTTP payload. Provider failures become request-state errors while no
 * document or dependent rows exist yet.
 */
export async function precomputeDocumentTotalsForCreate(
  orgId: string,
  kind: string,
  body: Pick<
    DocumentEditInput,
    "lines" | "currency" | "documentDate" | "partyId" | "subsidiaryId" | "custom"
  >,
): Promise<PreparedDocumentTotals | null> {
  if (!body.lines) return null;
  let currency = body.currency;
  if (currency !== undefined) {
    currency = String(currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new DocumentEditError(422, "invalid currency");
    const found = await db.execute(
      sql`select 1 from currencies where code = ${currency}`,
      "objects",
    );
    if (!found[0]) throw new DocumentEditError(422, "invalid currency");
  } else {
    currency = await orgBaseCurrency(orgId);
  }
  const documentDate = body.documentDate ?? (await businessToday(orgId));
  try {
    return await computeBillTotalsWithProvider(
      validateEditableDocumentLines(body.lines),
      await taxProfileMap(orgId, documentDate),
      {
        orgId,
        kind,
        currency,
        documentDate,
        partyId: body.partyId,
        subsidiaryId: body.subsidiaryId,
        taxProviderAddresses: documentTaxProviderAddresses(body.custom),
        canadianGoodsTax: body.custom?.canadianGoodsTax,
      },
    );
  } catch (error) {
    if (error instanceof DocumentEditError) throw error;
    throw new DocumentEditError(422, error instanceof Error ? error.message : String(error));
  }
}

/** The submitted lines of a save, validated and priced; every field is null when no lines were submitted. */
export interface EditedLines {
  totals: { subtotal: string; taxTotal: string; total: string } | null;
  /** Entry-mode distribution plan for this save (null when the feature is off). */
  entryPlan: EntryPlan | null;
  /** Stable line identities aligned with body.lines order; null marks a new line. */
  submittedLineKeys: (string | null)[] | null;
  preparedLines: PreparedDocumentLine[] | null;
}

/**
 * Pre-validate and prepare lines before touching the DB, so a bad line fails
 * without a partial write. Normalizes body.lines in place.
 */
export async function prepareEditedLines(args: {
  id: string;
  current: DocumentEditCurrent;
  body: DocumentEditInput;
  ctx: DocumentEditContext;
  runner: DocumentEditRunner;
  referenceSubsidiaryScope: SQL;
  currency: string | undefined;
  headerCustom: Record<string, unknown> | null;
  lineDefs: Awaited<ReturnType<typeof loadFieldDefs>>;
  segments: Awaited<ReturnType<typeof segmentRegistry>>;
}): Promise<EditedLines> {
  const {
    id,
    current,
    body,
    ctx,
    runner,
    referenceSubsidiaryScope,
    currency,
    headerCustom,
    lineDefs,
    segments,
  } = args;
  const { orgId } = ctx;
  if (!body.lines) {
    return { totals: null, entryPlan: null, submittedLineKeys: null, preparedLines: null };
  }
  refuseGenericLineEdit(current);
  // Native provenance is never caller-supplied (echoed or forged): strip
  // it here and from the validated output; trusted evidence is re-attached
  // from the locked rows in the write transaction.
  body.lines = stripSubmittedLineProvenance(body.lines);
  // Stable line identities ride the save for provenance matching. Shape and
  // duplicates fail here; ownership is proven under the document lock in
  // the write transaction (a pre-lock check could go stale).
  const submittedLineKeys = submittedLineIdentities(body.lines);
  // Native withholding inputs survive a partial line edit by stable identity.
  // The later document revision lock fences this snapshot against a concurrent edit.
  body.lines = await carryStoredWithholdingInputs(runner, orgId, id, body.lines, submittedLineKeys);
  // Silent single-warehouse default (also stamped on creates before the
  // totals preflight — see stampSingleWarehouseDefault).
  body.lines = await stampSingleWarehouseDefault(orgId, body.lines);
  await assertLineReferencesOwned({
    runner,
    current,
    ctx,
    body: { lines: body.lines },
    referenceSubsidiaryScope,
  });
  // Allocation kernel, entry mode: explode distribution lines BEFORE totals
  // + tax so every child is taxed as its own real line. A null plan means
  // the feature is off and the submitted lines are saved untouched.
  const entryPlan = await planDocumentEntryAllocations({
    orgId,
    documentId: id,
    kind: current.kind,
    documentDate: body.documentDate ?? current.documentDate,
    header: body,
    lines: body.lines,
    unsplitDistributionGroups: body.unsplitDistributionGroups,
  });
  const linesForTotals: DocumentLineInput[] = validateEditableDocumentLines(
    entryPlan ? entryPlan.lines : body.lines,
  );
  const computed = await computeEditedLineTotals({
    id,
    current,
    body,
    ctx,
    runner,
    currency,
    headerCustom,
    linesForTotals,
    entryPlan,
  });
  let totals: { subtotal: string; taxTotal: string; total: string } = {
    subtotal: normalizeMoney(computed.subtotal),
    taxTotal: normalizeMoney(computed.taxTotal),
    total: normalizeMoney(computed.total),
  };
  // A transfer moves one amount between two accounts; its two legs carry the
  // same amount, so the document total is that amount — NOT the summed legs.
  if (current.kind === "transfer" && computed.lines.length > 0) {
    const amt = normalizeMoney(computed.lines[0]!.amount);
    totals = { subtotal: amt, taxTotal: "0.0000", total: amt };
  }
  const preparedLines = await validatePreparedLines({
    runner,
    orgId,
    current,
    computed,
    lineDefs,
    segments,
    entryPlan,
  });
  return { totals, entryPlan, submittedLineKeys, preparedLines };
}

/**
 * Line sets with their own writers refuse the generic delete-and-reinsert, at
 * the service boundary. Project charge and field ticket lines carry an
 * immutable rate snapshot (rate version, base quantity, cost/bill amounts, rate
 * components, equipment unit and operator) that the generic column set would
 * drop; createProjectCharge / addTicketLine own them.
 */
function refuseGenericLineEdit(current: DocumentEditCurrent): void {
  if (current.kind === "project_charge" || current.kind === "field_ticket") {
    throw new DocumentEditError(
      422,
      `${current.kind} lines carry an immutable rate snapshot and cannot be edited here; ` +
        `change them on the source record`,
    );
  }
  // Internal billing lines carry their rule's accounts and are validated
  // against the rule's method by their own writer.
  if (current.kind === "internal_billing") {
    throw new DocumentEditError(
      422,
      "internal billing lines are edited in Internal billing, which applies the rule in effect",
    );
  }
}

/** Lines with their stored withholding inputs carried onto identity-matched submissions. */
async function carryStoredWithholdingInputs(
  runner: DocumentEditRunner,
  orgId: string,
  id: string,
  lines: DocumentLineInput[],
  submittedLineKeys: (string | null)[],
): Promise<DocumentLineInput[]> {
  const storedWithholding = await runner.execute<{
    id: string;
    withholdingTreatment: DocumentLineInput["withholdingTreatment"];
    withholdingMaterialsCost: string | null;
  }>(
    sql`select id, withholding_treatment as "withholdingTreatment", withholding_materials_cost::text as "withholdingMaterialsCost"
      from document_lines where org_id = ${orgId} and document_id = ${id}`,
    "objects",
  );
  const withholdingById = new Map(storedWithholding.map((line) => [line.id, line]));
  return lines.map((line, index) => {
    const source = submittedLineKeys?.[index]
      ? withholdingById.get(submittedLineKeys[index]!)
      : undefined;
    if (source)
      return {
        ...line,
        withholdingTreatment:
          line.withholdingTreatment === undefined
            ? source.withholdingTreatment
            : line.withholdingTreatment,
        withholdingMaterialsCost:
          line.withholdingMaterialsCost === undefined
            ? source.withholdingMaterialsCost
            : line.withholdingMaterialsCost,
      };
    if (
      storedWithholding.some((stored) => stored.withholdingMaterialsCost != null) &&
      line.withholdingMaterialsCost === undefined
    ) {
      throw new DocumentEditError(
        422,
        `Line ${index + 1}: reload the bill and keep its line identity, or enter its direct materials cost explicitly; the stored cost cannot be matched`,
      );
    }
    return line;
  });
}

/** Every line account and reference id is well formed and owned by the tenant. */
async function assertLineReferencesOwned(args: {
  runner: DocumentEditRunner;
  current: DocumentEditCurrent;
  ctx: DocumentEditContext;
  body: { lines: DocumentLineInput[] };
  referenceSubsidiaryScope: SQL;
}): Promise<void> {
  const { runner, current, ctx, body, referenceSubsidiaryScope } = args;
  const { orgId } = ctx;
  // Line accounts are the tenant's chart of accounts. The lines FK is
  // tenant-coherent, so a foreign account dies at the re-insert as an
  // unhandled storage error; refuse it here with a domain 404 that
  // reveals nothing about other tenants' charts. Scoped to org ownership
  // only: posting-time postability (active, non-summary) keeps its own
  // domain errors later, so drafts holding a since-deactivated account
  // still save.
  const lineAccountIds = [
    ...new Set(
      body.lines
        .map((l) => l.accountId)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];
  const malformedLineAccounts = lineAccountIds.filter((v) => !isUuid(v));
  const usableLineAccounts =
    malformedLineAccounts.length === 0 && lineAccountIds.length > 0
      ? await runner.execute<{ id: string }>(
          sql`
          select a.id from accounts a
           where a.org_id = ${orgId} and a.id = any(${`{${lineAccountIds.join(",")}}`}::uuid[])
             and ${referenceSubsidiaryScope}
             ${ctx.allowedSubsidiaryIds === undefined ? sql`` : subsidiaryVisibleFilter(sql`a.subsidiary_id`, ctx.allowedSubsidiaryIds, { orgWideNull: true })}
           for key share`,
          "objects",
        )
      : [];
  if (malformedLineAccounts.length > 0 || usableLineAccounts.length !== lineAccountIds.length) {
    throw new DocumentEditError(404, "account not found for this subsidiary");
  }
  // Line dimension references ride the same uncast path into the re-insert:
  // a malformed id dies as 22P02 and a foreign id as 23503, both unhandled
  // storage errors. Shape-check every submitted reference first, then prove
  // tenant ownership batched per table (same contract as line accounts).
  const lineRefDefs = [
    { key: "partyId", label: "party", table: "parties" },
    { key: "departmentId", label: "department", table: "departments" },
    { key: "projectId", label: "project", table: "projects" },
    { key: "locationId", label: "location", table: "locations" },
    { key: "classId", label: "class", table: "classes" },
    { key: "itemId", label: "item", table: "items" },
    { key: "stockLocationId", label: "stock location", table: "stock_locations" },
    {
      key: "amortizationTemplateId",
      label: "amortization template",
      table: "expense_amortization_templates",
    },
  ] as const;
  for (let i = 0; i < body.lines.length; i++) {
    const line = body.lines[i]!;
    for (const def of lineRefDefs) {
      const value = line[def.key];
      if (value !== undefined && value !== null && !isUuid(value)) {
        throw new DocumentEditError(422, `Line ${i + 1}: invalid ${def.key}`);
      }
    }
    const amortizationRefusal = amortizationLineRefusal(current.kind, line);
    if (amortizationRefusal)
      throw new DocumentEditError(422, `Line ${i + 1}: ${amortizationRefusal}`);
  }
  for (const def of lineRefDefs) {
    const ids = [
      ...new Set(
        body.lines
          .map((l) => l[def.key])
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      ),
    ];
    if (ids.length === 0) continue;
    const owned = new Set(
      (
        await runner.execute<{ id: string }>(
          sql`
        select id from ${sql.raw(`"${def.table}"`)}
         where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`,
          "objects",
        )
      ).map((r) => r.id),
    );
    const foreign = ids.find((v) => !owned.has(v));
    if (foreign !== undefined) {
      const lineNumber = body.lines.findIndex((l) => l[def.key] === foreign) + 1;
      throw new DocumentEditError(
        404,
        `Line ${lineNumber}: ${def.label} not found in this organization`,
      );
    }
  }
}

/**
 * Totals and per-line tax for the submitted lines: every line reaches the
 * calculator exactly as submitted (signed bases included) or fails closed with
 * a 422 naming it. The create-path preflight is reused while the line set is unchanged.
 */
async function computeEditedLineTotals(args: {
  id: string;
  current: DocumentEditCurrent;
  body: DocumentEditInput;
  ctx: DocumentEditContext;
  runner: DocumentEditRunner;
  currency: string | undefined;
  headerCustom: Record<string, unknown> | null;
  linesForTotals: DocumentLineInput[];
  entryPlan: EntryPlan | null;
}): Promise<PreparedDocumentTotals> {
  const { id, current, body, ctx, runner, currency, headerCustom, linesForTotals, entryPlan } =
    args;
  const { orgId } = ctx;
  let computed: Awaited<ReturnType<typeof computeBillTotalsWithProvider>>;
  // An explosion changes the line set the totals were precomputed for (and
  // taxes every child individually), so a structural change always
  // recomputes instead of reusing the create-path preflight.
  if (ctx.precomputedTotals && !entryPlan?.exploded) {
    computed = ctx.precomputedTotals;
  } else {
    try {
      // Tax prices on the tax date: the corrected supply's date for a
      // correcting credit, otherwise the document's own date.
      const taxDate = await documentTaxDate(
        runner,
        orgId,
        id,
        body.documentDate ?? current.documentDate,
      );
      computed = await computeBillTotalsWithProvider(
        validateEditableDocumentLines(linesForTotals),
        await taxProfileMap(orgId, taxDate),
        {
          orgId,
          kind: current.kind,
          currency:
            currency ??
            (
              await runner.execute<{ currency: string }>(
                sql`
              select currency from documents where id = ${id} and org_id = ${orgId}`,
                "objects",
              )
            )[0]?.currency ??
            (await orgBaseCurrency(orgId)),
          documentDate: taxDate,
          partyId: body.partyId !== undefined ? body.partyId : current.partyId,
          subsidiaryId: body.subsidiaryId !== undefined ? body.subsidiaryId : current.subsidiaryId,
          taxProviderAddresses: documentTaxProviderAddresses(headerCustom ?? current.custom),
          canadianGoodsTax: (headerCustom ?? current.custom)?.canadianGoodsTax,
        },
      );
    } catch (error) {
      throw new DocumentEditError(422, error instanceof Error ? error.message : String(error));
    }
  }
  return computed;
}

/** Validate each priced line (custom values, dimensions, prices, marketplace) into its prepared shape. */
async function validatePreparedLines(args: {
  runner: DocumentEditRunner;
  orgId: string;
  current: DocumentEditCurrent;
  computed: PreparedDocumentTotals;
  lineDefs: Awaited<ReturnType<typeof loadFieldDefs>>;
  segments: Awaited<ReturnType<typeof segmentRegistry>>;
  entryPlan: EntryPlan | null;
}): Promise<PreparedDocumentLine[]> {
  const { runner, orgId, current, computed, lineDefs, segments, entryPlan } = args;
  const preparedLines: PreparedDocumentLine[] = [];
  // Marketplace collection is a sales-document concept: posting routes a
  // flagged line's tax to the facilitator's clearing account instead of the
  // merchant's liability. The provider-commit kind map is the one source of
  // truth for that sales set, so cash kinds join both surfaces with one entry.
  const marketplaceAdmitted = PROVIDER_COMMIT_KINDS[current.kind] !== undefined;
  let activeFacilitators: Set<string> | null = null;
  validateEditableDocumentLines(computed.lines);
  for (let i = 0; i < computed.lines.length; i++) {
    const l = computed.lines[i]! as (typeof computed.lines)[number] & DocumentLineInput;
    const facilitatorName =
      typeof l.marketplaceFacilitator === "string" ? l.marketplaceFacilitator.trim() : "";
    if (facilitatorName !== "") {
      if (!marketplaceAdmitted) {
        throw new DocumentEditError(
          422,
          `Line ${i + 1}: marketplace tax applies to sales documents only — a ${current.kind} line cannot name a marketplace facilitator`,
        );
      }
      if (activeFacilitators === null) {
        activeFacilitators = new Set(
          (
            await runner.execute<{ name: string }>(
              sql`
            select name from marketplace_facilitators where org_id = ${orgId} and is_active`,
              "objects",
            )
          ).map((row) => row.name),
        );
      }
      const refusal = marketplaceFacilitatorNameRefusal(facilitatorName, activeFacilitators);
      if (refusal !== null) throw new DocumentEditError(422, `Line ${i + 1}: ${refusal}`);
    }
    const lv = validateCustomValues(lineDefs, l.custom);
    if (!lv.ok)
      throw new DocumentEditError(422, `Line ${i + 1}: ${Object.values(lv.errors)[0]}`, lv.errors);
    // A tenant definition colliding with a native key cannot smuggle a
    // caller value past the input strip above: native keys never survive
    // into the persisted bag except from the locked rows below.
    for (const key of NATIVE_LINE_CUSTOM_KEYS) delete lv.cleaned[key];
    // Lines are replaced wholesale, so the whole submitted line bag is
    // newly supplied: refuse foreign or dangling reference ids here, the
    // same tenant-opaque 404 the native line-ref precheck above returns.
    const unownedLineRefs = await findUnownedCustomReferences(orgId, lineDefs, lv.cleaned);
    if (unownedLineRefs.length > 0) {
      const def = unownedLineRefs[0]!;
      throw new DocumentEditError(
        404,
        `Line ${i + 1}: ${def.label} not found in this organization`,
        { [def.key]: "not found in this organization" },
      );
    }
    const lineDims = validateExtraDims(l.extraDims ?? {}, segments);
    if (!lineDims.ok) throw new DocumentEditError(422, `Line ${i + 1}: ${lineDims.error}`);
    let unitPrice: string | null = null;
    if (l.unitPrice != null && String(l.unitPrice).trim() !== "") {
      unitPrice = exactUnitPrice(l.unitPrice);
      if (unitPrice === null) {
        throw new DocumentEditError(422, `Line ${i + 1}: unit price is not a valid amount`);
      }
    }
    const amount = exactMoney(l.amount);
    if (amount === null) {
      throw new DocumentEditError(
        422,
        decimalNullRefusal(`Line ${i + 1} amount`, "an exact decimal amount", l.amount, 4),
      );
    }
    // Entry-mode stamps ride the planned line by index: computed lines
    // preserve the input order, so the i-th planned line stamps the i-th
    // prepared line (nulls when the feature is off or the line stayed plain).
    const stamp = entryPlan?.lines[i];
    preparedLines.push({
      accountId: l.accountId!,
      itemId: l.itemId ?? null,
      description: l.description ?? null,
      quantity: l.quantity ?? null,
      unit: l.unit ?? null,
      unitPrice,
      amount,
      taxCodeId: l.taxCodeId ?? null,
      taxGroupId: l.taxGroupId ?? null,
      taxInputAmount: l.taxInputAmount,
      taxAmount: l.taxAmount,
      taxOverridden: l.taxOverridden === true,
      withholdingTreatment: l.withholdingTreatment ?? null,
      withholdingMaterialsCost:
        l.withholdingMaterialsCost == null ? null : normalizeMoney(l.withholdingMaterialsCost),
      taxComponents: l.taxComponents,
      providerQuote: l.providerQuote,
      nativeGoodsTax: l.nativeGoodsTax,
      marketplaceFacilitator: facilitatorName !== "" ? facilitatorName : null,
      partyId: l.partyId ?? null,
      departmentId: l.departmentId ?? null,
      projectId: l.projectId ?? null,
      locationId: l.locationId ?? null,
      classId: l.classId ?? null,
      workFrom: l.workFrom,
      workTo: l.workTo,
      amortizationTemplateId: l.amortizationTemplateId ?? null,
      amortizationStartOn: l.amortizationStartOn ?? null,
      amortizationEndOn: l.amortizationEndOn ?? null,
      stockLocationId: l.stockLocationId ?? null,
      extraDims: lineDims.cleaned,
      custom: lv.cleaned,
      distributionGroupId: stamp?.distributionGroupId ?? null,
      distributionRuleId: stamp?.distributionRuleId ?? null,
      distributionVersionId: stamp?.distributionVersionId ?? null,
      distributionLocked: stamp?.distributionLocked ?? false,
    });
  }
  return preparedLines;
}
