import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, type SqlExecutor } from "../platform/db.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { abs, add, cmp, fromUnits, mulRate, neg, toUnits } from "../money/money.ts";
import {
  IncomeTaxProvisionError,
  spotRateToPresentation,
} from "./income-tax-provision.ts";
import { countryTaxPackForReturn, packTaxCodesForReturn, taxReturnPackBox } from "../country-tax-packs/index.ts";
import { taxRegistrationFormProblem, taxReturnPack } from "../tax/seed-tax-forms.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { buildFilingCalendar, type FilingFrequency } from "../tax/nexus.ts";

// A return is a statutory report, not a best-effort dashboard query. By
// default computeTaxReturn opens its own repeatable-read snapshot through a
// dedicated handle, so its read level never depends on whatever transaction
// the caller happens to hold. A caller that already owns the authoritative
// unit of work (markTaxFilingFiled's withOrg transaction) instead passes its
// own executor via ComputeTaxReturnOptions.runner: the recompute then runs on
// the caller's pinned connection and the whole verify-and-write unit holds
// exactly one pool connection. A second handle here would pin a second pool
// client for the duration — with OPENBOOKS_DB_POOL_MAX=1 every mark-filed
// would block to the statement timeout, and N concurrent filings would
// deadlock a pool of N.
const returnDb = drizzle({ client: pool });
export type TaxReturnRunner = SqlExecutor;

/**
 * Configurable government tax return computation.
 *
 * A return is a set of boxes (tax_report_lines) belonging to a form
 * (tax_return_forms). Each box is either GL-MAPPED — its raw value is summed
 * from the ledger for a tax code (tax amount) or the taxable base — or COMPUTED,
 * an arithmetic `formula` over other boxes' line codes (e.g. GST34 line
 * 109 = "105 - 108"). Every box carries a `sign` so credits (collected tax) show
 * as positive on the return. Both kinds, and the forms themselves, are edited in
 * the Setup UI; openbooks owns the ledger, so the box math is the reusable core
 * that every submission channel (facsimile print, file upload, e-file, portal
 * hand-key) builds on.
 *
 * `assembleReturn` is pure — no database — so the arithmetic is fully unit-tested.
 */

export interface TaxReturnBoxDef {
  lineCode: string;
  label: string;
  /** +1 keeps the ledger sign; -1 flips it (credits → positive on the return). */
  sign: number;
  sequence: number;
  /** Arithmetic over sibling line codes; when set the box is computed, not GL-mapped. */
  formula: string | null;
  /** True for manual ADJUSTMENT boxes (no formula, no GL source): the filer types
   *  the amount (e.g. GST34 lines 104/107). */
  editable: boolean;
  /** AcroForm field name this box fills on an uploaded official PDF (optional). */
  pdfField: string | null;
}

export interface TaxReturnBox {
  lineCode: string;
  label: string;
  /** Final base-currency value at numeric(19,4), sign applied. */
  value: string;
  computed: boolean;
  /** True when the filer supplies this box's amount (an adjustment). */
  editable: boolean;
  /** AcroForm field to fill on the official-PDF overlay (null when unmapped). */
  pdfField: string | null;
}

export class TaxReturnError extends Error {
  readonly name = "TaxReturnError";
}

/**
 * Which document family a taxable-base box sums when the library does not
 * describe the box: a one-sided code decides for itself; a both-sides code has
 * no declared side (null) and contributes both families.
 */
export function taxableBaseSideForCode(appliesTo: string | undefined): "sales" | "purchases" | null {
  if (appliesTo === "sales") return "sales";
  if (appliesTo === "purchases") return "purchases";
  return null;
}

/**
 * Evaluate a box `formula` — `+`/`-`, `abs(...)`, and `max(...)` over line-code
 * references, numeric literals and parentheses — against already-computed box
 * values, in exact money math. `abs` is required by returns such as UK VAT100
 * box 5 and New Zealand GST101A box 15, which report the unsigned difference
 * between tax collected and credits. `max` supports one-sided boxes such as
 * GST34's refund/payment split. Anything else is a configuration error, not
 * silent 0.
 */
export function evalFormula(
  expr: string,
  values: Map<string, string>,
  boxCodes: ReadonlySet<string>,
): string {
  // A token is an alphanumeric run (box code OR number literal) or an operator.
  // Box codes are frequently digit-leading with letters ("5a", "4C", "3.1A"),
  // so a token may start with a digit yet still be a reference; parseTerm below
  // classifies it (box code wins over numeric literal).
  const tokens = expr.match(/[A-Za-z0-9_][\w.]*|[(),+\-]/g);
  if (!tokens || tokens.join("").replace(/\s/g, "") !== expr.replace(/\s/g, "")) {
    throw new TaxReturnError(`invalid formula "${expr}"`);
  }
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const boxRef = (tok: string): string => {
    // A token that names a box (line codes are often numeric, e.g. "105") is a
    // reference, not a literal, and must already be computed (sequence order).
    const v = values.get(tok);
    if (v === undefined) {
      throw new TaxReturnError(`formula "${expr}" references unknown or not-yet-computed box "${tok}"`);
    }
    return v;
  };

  // expr := term (('+' | '-') term)*
  const parseExpr = (): string => {
    let acc = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const rhs = parseTerm();
      acc = op === "+" ? add(acc, rhs) : add(acc, neg(rhs));
    }
    return acc;
  };
  // term := '(' expr ')' | '-' term | 'abs' '(' expr ')' | 'max' '(' expr ',' expr ')' | boxCode | numberLiteral
  const parseTerm = (): string => {
    const tok = next();
    if (tok === undefined) throw new TaxReturnError(`unexpected end of formula "${expr}"`);
    if (tok === "(") {
      const inner = parseExpr();
      if (next() !== ")") throw new TaxReturnError(`unbalanced parentheses in "${expr}"`);
      return inner;
    }
    if (tok === "-") return neg(parseTerm());
    if (tok === "+") return parseTerm();
    if (tok === "abs") {
      if (next() !== "(") throw new TaxReturnError(`abs must be followed by parentheses in "${expr}"`);
      const inner = parseExpr();
      if (next() !== ")") throw new TaxReturnError(`unbalanced abs parentheses in "${expr}"`);
      return abs(inner);
    }
    if (tok === "max") {
      if (next() !== "(") throw new TaxReturnError(`max must be followed by parentheses in "${expr}"`);
      const left = parseExpr();
      if (next() !== ",") throw new TaxReturnError(`max requires two comma-separated arguments in "${expr}"`);
      const right = parseExpr();
      if (next() !== ")") throw new TaxReturnError(`unbalanced max parentheses in "${expr}"`);
      return cmp(left, right) >= 0 ? left : right;
    }
    // Box code wins over numeric-literal reading, so "105 - 108" references
    // boxes 105 and 108 rather than the numbers.
    if (boxCodes.has(tok)) return boxRef(tok);
    if (/^\d+(?:\.\d+)?$/.test(tok)) return fromUnits(toUnits(tok));
    return boxRef(tok);
  };

  const result = parseExpr();
  if (pos !== tokens.length) throw new TaxReturnError(`trailing tokens in formula "${expr}"`);
  return result;
}

/**
 * Assemble the final return from box definitions and the GL-summed raw values
 * for the GL-mapped boxes. Pure. Boxes evaluate in `sequence` order (then line
 * code); a computed box may only reference boxes that come before it.
 */
export function assembleReturn(
  boxes: TaxReturnBoxDef[],
  glRawByLineCode: Map<string, string>,
  adjustments: Map<string, string> = new Map(),
): TaxReturnBox[] {
  const ordered = [...boxes].sort(
    (a, b) => a.sequence - b.sequence || a.lineCode.localeCompare(b.lineCode),
  );
  const boxCodes = new Set(boxes.map((b) => b.lineCode));
  const values = new Map<string, string>();
  const result: TaxReturnBox[] = [];
  for (const box of ordered) {
    // Normalize to numeric(19,4) and apply the sign in one step, so a box with
    // no ledger activity is "0.0000" and every value prints at ledger precision.
    const signed = (v: string) => (box.sign < 0 ? neg(v) : fromUnits(toUnits(v)));
    let value: string;
    if (box.formula && box.formula.trim()) {
      value = signed(evalFormula(box.formula, values, boxCodes));
    } else if (box.editable) {
      // Adjustment box: the filer's typed amount (already in the sign the form
      // shows), defaulting to zero. Not sign-flipped — it's entered as displayed.
      value = fromUnits(toUnits(adjustments.get(box.lineCode) ?? "0"));
    } else {
      value = signed(glRawByLineCode.get(box.lineCode) ?? "0");
    }
    values.set(box.lineCode, value);
    result.push({
      lineCode: box.lineCode,
      label: box.label,
      value,
      computed: Boolean(box.formula?.trim()),
      editable: box.editable,
      pdfField: box.pdfField,
    });
  }
  return result;
}

/** A row of tax_report_lines as configured (before GL sums). */
export interface TaxReportLineRow {
  lineCode: string;
  label: string;
  sign: number;
  sequence: number;
  taxCodeId: string | null;
  basis: string | null;
  formula: string | null;
  pdfField?: string | null;
}

/** Where a GL-mapped box pulls its raw value from (one per contributing row). */
export interface TaxReturnGlSource {
  lineCode: string;
  taxCodeId: string;
  basis: string;
}

/** Shared economic-activity window for return sums and the unmapped-code
 * refusal. A code remains return-relevant after deactivation: posted evidence
 * is historical and must not disappear from the same period's sum or guard.
 * Voided source documents, on the other hand, are not economic activity. */
function journalReturnActivityPredicate(input: {
  from: string;
  to: string;
  primaryBookId: string;
  scopeIds: string[] | null;
}): ReturnType<typeof sql> {
  const lineScope = input.scopeIds
    ? sql`and l.subsidiary_id = any(${uuidArray(input.scopeIds)}::uuid[])`
    : sql``;
  return sql`
    and e.status in ('posted', 'reversed')
    and e.posting_date between ${input.from} and ${input.to}
    and e.book_id = ${input.primaryBookId}
    and (vd.id is null or vd.status <> 'voided')
    ${lineScope}
  `;
}

/**
 * Plan a return from its configured rows. Several rows may share a line code —
 * a box like GST34 line 103 sums GST + every HST rate — so rows collapse to one
 * box per line code (label/sign/formula from the box's defining row, sequence
 * from the earliest), and every GL-mapped row becomes a source whose sum is
 * accumulated into that box. Pure, so the grouping is unit-tested.
 */
export function planReturn(rows: TaxReportLineRow[]): {
  boxes: TaxReturnBoxDef[];
  glSources: TaxReturnGlSource[];
} {
  const byLine = new Map<string, TaxReturnBoxDef>();
  const glSources: TaxReturnGlSource[] = [];
  const hasGl = new Set<string>();
  for (const row of rows) {
    const existing = byLine.get(row.lineCode);
    if (!existing) {
      byLine.set(row.lineCode, {
        lineCode: row.lineCode,
        label: row.label,
        sign: row.sign,
        sequence: row.sequence,
        formula: row.formula,
        editable: false,
        pdfField: row.pdfField ?? null,
      });
    } else {
      existing.sequence = Math.min(existing.sequence, row.sequence);
      if (!existing.formula && row.formula) existing.formula = row.formula;
      if (!existing.pdfField && row.pdfField) existing.pdfField = row.pdfField;
    }
    if (!row.formula?.trim() && row.taxCodeId && row.basis) {
      glSources.push({ lineCode: row.lineCode, taxCodeId: row.taxCodeId, basis: row.basis });
      hasGl.add(row.lineCode);
    }
  }
  // A box with neither a formula nor any GL source is a manual adjustment box.
  for (const box of byLine.values()) {
    box.editable = !box.formula?.trim() && !hasGl.has(box.lineCode);
  }
  return { boxes: [...byLine.values()], glSources };
}

export interface TaxReturnResult {
  formCode: string;
  formName: string;
  from: string;
  to: string;
  submissionChannel: string;
  watermark: string | null;
  /**
   * The org's own registration number for this return's form (e.g. the CRA
   * business number on a GST34), from the active tax_registrations row whose
   * form and effective window cover the period — null when unregistered. The
   * facsimile prints this identity verbatim and must never invent one.
   */
  registrationNumber: string | null;
  boxes: TaxReturnBox[];
  /**
   * The currency `boxes` are denominated in: the filing entity's functional
   * currency, or the presentation currency when the return is a translated
   * consolidated view (`translation` non-null). A return never mixes
   * currencies unit-for-unit — multi-currency scopes translate per entity or
   * fail closed.
   */
  functionalCurrency: string;
  /** The subsidiary set the return sums: the filing entity, or every org
   *  subsidiary when unscoped. */
  subsidiaryIds: string[];
  /** The pinned registration's id, when the caller pinned one; otherwise the
   *  auto-matched registration's id (null when unregistered). */
  registrationId: string | null;
  /** Null for a single-currency return; the per-entity translation evidence
   *  for a translated consolidated view. */
  translation: TaxReturnTranslation | null;
}

/**
 * The filing entity a return is prepared for: the subsidiary set whose
 * functional amounts are summed, plus the registration that identifies the
 * filing. A return is a statutory report of ONE legal filer in its own
 * functional currency — never an org-wide blend of per-subsidiary functionals.
 */
export interface TaxReturnFilingEntity {
  /**
   * Subsidiaries forming the filing entity. Omit (or pass an empty set with
   * a `registrationId`) for the whole org.
   */
  subsidiaryIds: string[];
  /**
   * Pin the registration whose number travels on the return. It must belong
   * to this org, name this form, and be active; when omitted the existing
   * form+effective-window match applies.
   */
  registrationId?: string | null;
}

/**
 * The declared translation policy for a consolidated (multi-currency) return
 * view: which rate source and which effective date every entity translates
 * at. The policy travels with the computed view and every applied rate is
 * reported back in {@link TaxReturnTranslation}, so a translated total is
 * always auditable to its evidence — never a silent blend.
 */
export interface TaxReturnTranslationPolicy {
  /** Currency the consolidated view is denominated in (e.g. the org base). */
  presentationCurrency: string;
  /** fx_rates `rate_type` to translate at (default 'spot'). */
  rateType?: string;
  /**
   * Rate effective date: an ISO date (rates apply `as_of <= date`, newest
   * wins), or omitted for the period end (`to`). Adjustments passed by the
   * filer are denominated in the presentation currency and applied once,
   * after translation.
   */
  rateDate?: string;
}

export interface ComputeTaxReturnOptions {
  filingEntity?: TaxReturnFilingEntity;
  translation?: TaxReturnTranslationPolicy;
  /**
   * Run the return on the caller's executor instead of opening a dedicated
   * repeatable-read snapshot (markTaxFilingFiled passes its pinned withOrg
   * connection). The caller owns consistency: reads see the caller's
   * transaction, and no second pool connection is held.
   */
  runner?: TaxReturnRunner;
}

/** One filing entity's component of a translated consolidated view. */
export interface TaxReturnTranslatedEntity {
  subsidiaryId: string;
  name: string;
  /** The entity's functional currency — what `boxes` are denominated in. */
  currency: string;
  /** The policy rate (entity → presentation) applied to every box below. */
  fxRate: string;
  /** Effective date of the applied rate row. */
  rateAsOf: string;
  /** The entity's boxes in functional currency (before translation and
   *  before presentation-denominated adjustments). */
  boxes: TaxReturnBox[];
}

/** Translation evidence for a consolidated return view. */
export interface TaxReturnTranslation {
  presentationCurrency: string;
  rateType: string;
  rateDate: string;
  /** Contributing entities only: an entity with no return-relevant activity
   *  contributes zero at any rate and is omitted rather than forcing a rate
   *  lookup that could fail closed on irrelevant coverage. */
  entities: TaxReturnTranslatedEntity[];
}

/**
 * Compute a configured tax return for a period. Loads the form + its boxes,
 * sums the ledger for each GL-mapped box (tax amount, or the taxable base the
 * tax applied to), then assembles computed boxes on top. Postings are counted
 * once posted and dated within [from, to].
 */
// ---------------------------------------------------------------------------
// Filing-entity scope: a return sums ONE legal filer's functional amounts.
//
// journal_lines.amount is stored in the line's subsidiary functional currency
// (the kernel converts each line at posting), so summing lines across
// subsidiaries with different base currencies adds unlike units. The return
// therefore resolves its subsidiary scope first, measures which functional
// currencies hold return-relevant activity, and either sums a single currency
// or translates per entity at a declared policy rate — never a silent blend.
// ---------------------------------------------------------------------------

const RETURN_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RETURN_CURRENCY_RE = /^[A-Z]{3}$/;
const RETURN_RATE_TYPE_RE = /^[a-z][a-z0-9_]{1,31}$/;

interface ReturnScope {
  /** Subsidiary ids whose lines are summed ([] with legacy=true: no predicate). */
  ids: string[];
  currencyById: Map<string, string>;
  nameById: Map<string, string>;
  rootId: string | null;
  /** Degenerate org with no subsidiaries: keep the historical unpredicated reads. */
  legacy: boolean;
  /** True when the caller explicitly scoped a filing entity. */
  explicit: boolean;
}

/**
 * Resolve the subsidiary set a return sums: the caller's filing entity, or
 * every org subsidiary when unscoped (the historical org-wide return, which
 * stays single-currency or fails closed below). Unknown, cross-org and
 * elimination subsidiaries fail closed — an elimination entity is a
 * consolidation adjustment holder, never a legal filer.
 */
async function resolveReturnScope(
  runner: TaxReturnRunner,
  orgId: string,
  filingEntity?: TaxReturnFilingEntity,
): Promise<ReturnScope> {
  const subRes = (await runner.execute<{
    id: string; name: string; base_currency: string; is_elimination: boolean; parent_id: string | null;
  }>(sql`
    select id, name, base_currency, is_elimination, parent_id
      from subsidiaries where org_id = ${orgId}`));
  const currencyById = new Map(subRes.rows.map((r) => [r.id, r.base_currency]));
  const nameById = new Map(subRes.rows.map((r) => [r.id, r.name]));
  const rootId = subRes.rows.find((r) => r.parent_id === null)?.id ?? null;
  if (subRes.rows.length === 0) {
    return { ids: [], currencyById, nameById, rootId, legacy: true, explicit: false };
  }
  const requested = filingEntity?.subsidiaryIds;
  if (!requested || (requested.length === 0 && filingEntity?.registrationId)) {
    return {
      ids: subRes.rows.map((r) => r.id),
      currencyById,
      nameById,
      rootId,
      legacy: false,
      explicit: false,
    };
  }
  if (requested.length === 0) {
    throw new TaxReturnError("filing entity must name at least one subsidiary");
  }
  const ids = [...new Set(requested)];
  try {
    uuidArray(ids);
  } catch (e) {
    throw new TaxReturnError(
      `filing entity names an invalid subsidiary id (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const unknown = ids.filter((id) => !currencyById.has(id));
  if (unknown.length > 0) {
    throw new TaxReturnError(
      `filing entity references subsidiaries outside this organization: ${unknown.join(", ")}`,
    );
  }
  const elimination = ids.filter(
    (id) => subRes.rows.find((r) => r.id === id)?.is_elimination,
  );
  if (elimination.length > 0) {
    const names = elimination.map((id) => nameById.get(id) ?? id);
    throw new TaxReturnError(
      `filing entity cannot include elimination ${names.length > 1 ? "entities" : "entity"} ${names.join(", ")} — only legal filers report returns`,
    );
  }
  return { ids, currencyById, nameById, rootId, legacy: false, explicit: true };
}

/** Validate a caller-supplied translation policy (fail-closed shapes). */
function resolveTranslationPolicy(
  policy: TaxReturnTranslationPolicy | undefined,
  periodEnd: string,
): { presentationCurrency: string; rateType: string; rateDate: string } | null {
  if (!policy) return null;
  if (!policy.presentationCurrency || !RETURN_CURRENCY_RE.test(policy.presentationCurrency)) {
    throw new TaxReturnError(
      `translation presentationCurrency "${policy.presentationCurrency ?? "(none)"}" is not a valid 3-letter currency code`,
    );
  }
  const rateType = policy.rateType ?? "spot";
  if (!RETURN_RATE_TYPE_RE.test(rateType)) {
    throw new TaxReturnError(
      `translation rateType "${policy.rateType}" is not a valid rate source`,
    );
  }
  const rateDate = policy.rateDate ?? periodEnd;
  if (!RETURN_ISO_DATE_RE.test(rateDate)) {
    throw new TaxReturnError(
      `translation rateDate "${policy.rateDate}" is not an ISO date (YYYY-MM-DD)`,
    );
  }
  return { presentationCurrency: policy.presentationCurrency, rateType, rateDate };
}

/**
 * Subsidiaries holding return-relevant posted activity in the window: journal
 * lines carrying one of the return's tax codes (primary book), plus posted
 * documents with matching taxable-base lines. Precise to the return's own
 * predicates — an idle foreign subsidiary with no tax activity must not force
 * the whole return into translation. Also reports whether NULL-subsidiary
 * legacy documents with base activity exist (the kernel stamps every document
 * it posts, so these predate stamping and attribute to the root fallback).
 */
async function findReturnContributors(
  runner: TaxReturnRunner,
  orgId: string,
  scope: ReturnScope,
  window: { from: string; to: string; bookId: string },
  sourceCodeIds: string[],
  baseCodeIds: string[],
  explicitScope: boolean,
): Promise<{ ids: string[]; nullSubsidiaryDocs: boolean }> {
  if (scope.legacy || sourceCodeIds.length === 0) {
    return { ids: [], nullSubsidiaryDocs: true };
  }
  const scopeIds = uuidArray(scope.ids);
  const sourceArray = uuidArray(sourceCodeIds);
  const basePredicate =
    baseCodeIds.length === 0
      ? sql`false`
      : sql`exists (
           select 1 from document_lines dl
            where dl.org_id = d.org_id and dl.document_id = d.id
              and (dl.tax_code_id = any(${uuidArray(baseCodeIds)}::uuid[])
                or exists (
                  select 1 from document_line_tax_components c
                   where c.org_id = dl.org_id and c.document_line_id = dl.id
                     and c.tax_code_id = any(${uuidArray(baseCodeIds)}::uuid[]))))`;
  const rows = (await runner.execute<{ id: string }>(sql`
    select distinct l.subsidiary_id as id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${orgId} and l.tax_code_id = any(${sourceArray}::uuid[])
       and e.status in ('posted', 'reversed')
       and e.posting_date between ${window.from} and ${window.to}
       and e.book_id = ${window.bookId}
       and l.subsidiary_id = any(${scopeIds}::uuid[])
     union
    select distinct d.subsidiary_id as id
      from documents d
     where d.org_id = ${orgId} and d.status = 'posted'
       and coalesce(d.posting_date, d.document_date) between ${window.from} and ${window.to}
       and d.subsidiary_id is not null
       and d.subsidiary_id = any(${scopeIds}::uuid[])
       and (${basePredicate})
  `));
  // Journal lines always carry a subsidiary; only the taxable-base document
  // branch can meet unattributed legacy documents.
  const nullDocs =
    baseCodeIds.length === 0 || (explicitScope && !(scope.rootId && scope.ids.includes(scope.rootId)))
      ? { rows: [] as { one: number }[] }
      : await runner.execute<{ one: number }>(sql`
        select 1 as one from documents d
         where d.org_id = ${orgId} and d.status = 'posted'
           and coalesce(d.posting_date, d.document_date) between ${window.from} and ${window.to}
           and d.subsidiary_id is null
           and (${basePredicate})
         limit 1`);
  return { ids: rows.rows.map((r) => r.id), nullSubsidiaryDocs: nullDocs.rows.length > 0 };
}

async function clampTaxReturnWindowInSnapshot(
  runner: TaxReturnRunner,
  orgId: string,
  formCode: string,
  from: string,
  to: string,
  pinnedId?: string | null,
): Promise<{ from: string; to: string }> {
  const registrations = await runner.execute<{
    id: string;
    jurisdiction_id: string;
    jurisdiction_name: string;
    jurisdiction_code: string;
    country: string;
    filing_frequency: FilingFrequency;
    return_form_code: string | null;
    registration_number: string | null;
    effective_from: string | null;
    effective_to: string | null;
  }>(sql`
    select r.id, r.jurisdiction_id, j.name as jurisdiction_name, j.code as jurisdiction_code,
           j.country, r.filing_frequency, r.return_form_code, r.registration_number,
           r.effective_from::text, r.effective_to::text
      from tax_registrations r
      join tax_jurisdictions j on j.id = r.jurisdiction_id and j.org_id = r.org_id
     where r.org_id = ${orgId} and r.is_active and r.return_form_code = ${formCode}
  `);
  const regs = registrations.rows.map((r) => ({
    id: r.id,
    jurisdictionId: r.jurisdiction_id,
    jurisdictionName: r.jurisdiction_name,
    jurisdictionCode: r.jurisdiction_code,
    country: r.country,
    filingFrequency: r.filing_frequency,
    returnFormCode: r.return_form_code,
    registrationNumber: r.registration_number,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  }));
  const overlapping = (reg: (typeof regs)[number]) =>
    buildFilingCalendar([reg], from, to).find(
      (o) => o.periodStart <= to && o.periodEnd >= from,
    );
  // A pinned registration resolves FIRST: the window clamps to ITS filing
  // obligation, never to a sibling registration's. An unknown, inactive or
  // malformed pin is left for resolveReturnRegistration, which owns the named
  // refusal — clamping must not invent a refusal the resolver already names.
  if (pinnedId) {
    let pinOk = true;
    try {
      uuidArray([pinnedId]);
    } catch {
      pinOk = false;
    }
    const pin = pinOk ? regs.find((r) => r.id === pinnedId) : undefined;
    if (!pin) return { from, to };
    const match = overlapping(pin);
    return match
      ? { from: match.reportableFrom, to: match.reportableTo }
      : { from, to };
  }
  // Unpinned: group matches by registration so sibling registrations sharing
  // one form can never silently win by calendar sort order. One registration
  // keeps the historical first-obligation clamp; several fail closed by name.
  const matches = regs.flatMap((reg) => {
    const match = overlapping(reg);
    return match ? [{ reg, match }] : [];
  });
  if (matches.length === 0) return { from, to };
  if (matches.length === 1) {
    const only = matches[0]!;
    return { from: only.match.reportableFrom, to: only.match.reportableTo };
  }
  const choices = [...matches]
    .sort(
      (a, b) =>
        a.match.reportableFrom.localeCompare(b.match.reportableFrom) ||
        labelFor(a.reg).localeCompare(labelFor(b.reg)),
    )
    .map(
      (m) =>
        `${labelFor(m.reg)} (${m.match.reportableFrom} to ${m.match.reportableTo})`,
    );
  throw new TaxReturnError(
    `tax return "${formCode}" has ${matches.length} registrations active in this period — choose one: ${choices.join(", ")}`,
  );
}

/** Human name for a registration in a refusal: its number, else its jurisdiction. */
function labelFor(reg: { registrationNumber: string | null; jurisdictionCode: string }): string {
  return reg.registrationNumber ?? reg.jurisdictionCode;
}

/**
 * Sum every GL-mapped box for one subsidiary scope. The accumulation is the
 * historical logic unchanged: tax_collected/tax_paid match the immutable
 * component-account evidence first (then-current mapping for legacy/manual
 * journals), tax_amount sums every tax line for the code, and taxable_base
 * boxes convert each document line at its posted header rate. The scope only
 * adds subsidiary predicates — journal_lines.subsidiary_id is NOT NULL and
 * every line's subsidiary belongs to the org, so an all-subsidiaries scope
 * reads exactly the historical row set.
 */
async function sumReturnGlRaw(
  runner: TaxReturnRunner,
  opts: {
    orgId: string;
    formCode: string;
    from: string;
    to: string;
    primaryBookId: string;
    orgTaxCollected: string | null;
    orgTaxPaid: string | null;
    glSources: TaxReturnGlSource[];
    /** Subsidiary ids to sum; null omits the predicate (degenerate org). */
    scopeIds: string[] | null;
    /** Attribute NULL-subsidiary legacy documents to the in-scope root. */
    nullDocArm: boolean;
  },
): Promise<Map<string, string>> {
  const { orgId, formCode, from, to, primaryBookId, orgTaxCollected, orgTaxPaid, glSources } = opts;
  const journalActivity = journalReturnActivityPredicate({
    from, to, primaryBookId, scopeIds: opts.scopeIds,
  });
  const docScope =
    opts.scopeIds === null
      ? sql``
      : opts.nullDocArm
        ? sql`and (d.subsidiary_id = any(${uuidArray(opts.scopeIds)}::uuid[]) or d.subsidiary_id is null)`
        : sql`and d.subsidiary_id = any(${uuidArray(opts.scopeIds)}::uuid[])`;
  // A void means the transaction never happened: lines of a voided document
  // are excluded outright — the in-window original (status 'reversed') and
  // its reversal, which the void posts in a later period outside the box
  // window. Manual tax adjustments carry no document and still net inside.
  const glRaw = new Map<string, string>();
  const baseCodesByLineCode = new Map<string, string[]>();
  for (const src of glSources) {
    if (src.basis !== "taxable_base") continue;
    const codes = baseCodesByLineCode.get(src.lineCode) ?? [];
    codes.push(src.taxCodeId);
    baseCodesByLineCode.set(src.lineCode, codes);
  }
  for (const src of glSources) {
    let total: string;
    if (src.basis === "tax_collected" || src.basis === "tax_paid") {
      const orgFallback = src.basis === "tax_collected" ? orgTaxCollected : orgTaxPaid;
      const acctCol = src.basis === "tax_collected" ? sql`tc.collected_account_id` : sql`tc.paid_account_id`;
      const r = (await runner.execute<{ total: string }>(sql`
        select coalesce(sum(l.amount), 0)::text as total
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          join tax_codes tc on tc.id = l.tax_code_id and tc.org_id = l.org_id
          left join documents vd on vd.id = e.source_document_id and vd.org_id = l.org_id
         where l.org_id = ${orgId} and l.tax_code_id = ${src.taxCodeId}
           ${journalActivity}
           and (
             exists (
               select 1
                 from document_lines dl
                 join document_line_tax_components c
                   on c.document_line_id = dl.id and c.org_id = dl.org_id
                 join documents sd
                   on sd.id = dl.document_id and sd.org_id = dl.org_id
                where dl.document_id = e.source_document_id
                  and dl.org_id = l.org_id
                  and c.tax_code_id = l.tax_code_id
                  and (
                    ${src.basis === "tax_collected" ? sql`c.collected_account_id = l.account_id` : sql`c.paid_account_id = l.account_id`}
                    or (
                      ${src.basis === "tax_collected" ? sql`c.collected_account_id is null and sd.kind in ('customer_invoice', 'customer_credit')` : sql`c.paid_account_id is null and sd.kind in ('vendor_bill', 'vendor_credit', 'expense_report', 'check', 'card_charge', 'card_refund')`}
                    )
                  )
             )
             or (
               not exists (
                 select 1
                   from document_lines dl
                   join document_line_tax_components c
                     on c.document_line_id = dl.id and c.org_id = dl.org_id
                  where dl.document_id = e.source_document_id
                    and dl.org_id = l.org_id
                    and c.tax_code_id = l.tax_code_id
               )
               and l.account_id = coalesce(${acctCol}, ${orgFallback})
             )
           )`));
      total = r.rows[0]?.total ?? "0";
    } else if (src.basis === "tax_amount") {
      const r = (await runner.execute<{ total: string }>(sql`
        select coalesce(sum(l.amount), 0)::text as total
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          left join documents vd on vd.id = e.source_document_id and vd.org_id = l.org_id
         where l.org_id = ${orgId} and l.tax_code_id = ${src.taxCodeId}
           ${journalActivity}`));
      total = r.rows[0]?.total ?? "0";
    } else {
      continue; // taxable_base sources are summed once per box below.
    }
    glRaw.set(src.lineCode, add(glRaw.get(src.lineCode) ?? "0", total));
  }
  const appliesToByCode = new Map<string, string>();
  const allBaseCodes = [...new Set([...baseCodesByLineCode.values()].flat())];
  if (allBaseCodes.length > 0) {
    const codeRows = (await runner.execute<{ id: string; applies_to: string }>(sql`
      select id, applies_to from tax_codes
       where org_id = ${orgId} and id = any(${uuidArray(allBaseCodes)}::uuid[])`));
    for (const row of codeRows.rows) appliesToByCode.set(row.id, row.applies_to);
  }
  for (const [lineCode, codes] of baseCodesByLineCode) {
    const declared = taxReturnPackBox(formCode, lineCode)?.glMap ?? null;
    const salesCodes: string[] = [];
    const purchaseCodes: string[] = [];
    for (const code of codes) {
      const side = declared ?? taxableBaseSideForCode(appliesToByCode.get(code));
      if (side === "sales" || side === null) salesCodes.push(code);
      if (side === "purchases" || side === null) purchaseCodes.push(code);
    }
    const salesArray = uuidArray(salesCodes);
    const purchaseArray = uuidArray(purchaseCodes);
    const r = (await runner.execute<{ total: string }>(sql`
      select coalesce(sum(
               round(((case when d.kind in ('customer_credit', 'vendor_credit') then -dl.amount else dl.amount end) * d.fx_rate)::numeric, 4)
             ), 0)::text as total
        from document_lines dl
        join documents d on d.id = dl.document_id and d.org_id = dl.org_id
       where dl.org_id = ${orgId}
         and d.status = 'posted'
         and coalesce(d.posting_date, d.document_date) between ${from} and ${to}
         ${docScope}
         and (
           (
             d.kind in ('customer_invoice', 'customer_credit')
             and (
               dl.tax_code_id = any(${salesArray}::uuid[])
               or exists (
                 select 1 from document_line_tax_components c
                  where c.org_id = dl.org_id and c.document_line_id = dl.id
                    and c.tax_code_id = any(${salesArray}::uuid[])
               )
             )
           )
           or (
             d.kind in ('vendor_bill', 'vendor_credit', 'expense_report', 'check', 'card_charge', 'card_refund')
             and (
               dl.tax_code_id = any(${purchaseArray}::uuid[])
               or exists (
                 select 1 from document_line_tax_components c
                  where c.org_id = dl.org_id and c.document_line_id = dl.id
                    and c.tax_code_id = any(${purchaseArray}::uuid[])
               )
             )
           )
         )`));
    glRaw.set(lineCode, add(glRaw.get(lineCode) ?? "0", r.rows[0]?.total ?? "0"));
  }
  return glRaw;
}

/**
 * Translate per-entity box sums into the presentation currency. Each entity's
 * functional sums cross currencies through its own policy rate (`mulRate`,
 * exact decimal) and computed boxes then assemble from the translated inputs
 * — translation is linear and monotone, so assembling after translation keeps
 * every derived box consistent with its displayed inputs. Adjustments stay
 * out of the per-entity evidence: they are presentation-denominated and apply
 * once at the consolidated assemble.
 */
async function translateReturnGlRaw(
  runner: TaxReturnRunner,
  orgId: string,
  sumOpts: Omit<Parameters<typeof sumReturnGlRaw>[1], "scopeIds" | "nullDocArm">,
  boxDefs: TaxReturnBoxDef[],
  scope: ReturnScope,
  contributorIds: string[],
  policy: { presentationCurrency: string; rateType: string; rateDate: string },
): Promise<{ glRaw: Map<string, string>; translation: TaxReturnTranslation }> {
  const translated = new Map<string, string>();
  const entities: TaxReturnTranslatedEntity[] = [];
  for (const subId of [...contributorIds].sort()) {
    const currency = scope.currencyById.get(subId);
    if (!currency) continue;
    const subGl = await sumReturnGlRaw(runner, {
      ...sumOpts,
      scopeIds: [subId],
      nullDocArm: subId === scope.rootId && scope.rootId !== null && scope.ids.includes(subId),
    });
    // A contributor with no summed activity adds zero at any rate; omitting
    // it keeps a missing rate for an idle entity from failing the whole view.
    if ([...subGl.values()].every((v) => v === "0" || v === "0.0000")) continue;
    let rate: string;
    let asOf: string;
    try {
      ({ rate, asOf } = await spotRateToPresentation(
        runner,
        orgId,
        currency,
        policy.presentationCurrency,
        policy.rateDate,
        policy.rateType,
      ));
    } catch (e) {
      if (e instanceof IncomeTaxProvisionError) {
        throw new TaxReturnError(
          `cannot translate ${currency}→${policy.presentationCurrency} for the consolidated return (${e.message})`,
        );
      }
      throw e;
    }
    for (const [lineCode, value] of subGl) {
      translated.set(lineCode, add(translated.get(lineCode) ?? "0", mulRate(value, rate)));
    }
    entities.push({
      subsidiaryId: subId,
      name: scope.nameById.get(subId) ?? subId,
      currency,
      fxRate: rate,
      rateAsOf: asOf,
      boxes: assembleReturn(boxDefs, subGl),
    });
  }
  return {
    glRaw: translated,
    translation: {
      presentationCurrency: policy.presentationCurrency,
      rateType: policy.rateType,
      rateDate: policy.rateDate,
      entities,
    },
  };
}

/**
 * Resolve the filing identity: a caller-pinned registration (validated to this
 * org, this form, and active), or the existing form+effective-window match.
 * Registrations carry no subsidiary — the filing entity is a compute-time
 * input, so the number stays form+window keyed until registrations do.
 */
async function resolveReturnRegistration(
  runner: TaxReturnRunner,
  orgId: string,
  formCode: string,
  from: string,
  to: string,
  pinnedId?: string | null,
): Promise<{
  registrationNumber: string | null;
  registrationId: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}> {
  if (pinnedId) {
    try {
      uuidArray([pinnedId]);
    } catch (e) {
      throw new TaxReturnError(
        `tax registration "${pinnedId}" is not a valid id (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const pin = (await runner.execute<{
      id: string; registration_number: string | null; return_form_code: string | null;
      effective_from: string | null; effective_to: string | null;
      jurisdiction_code: string;
    }>(sql`
      select r.id, r.registration_number, r.return_form_code,
             r.effective_from::text, r.effective_to::text, j.code as jurisdiction_code
        from tax_registrations r
        join tax_jurisdictions j on j.id = r.jurisdiction_id and j.org_id = r.org_id
       where r.id = ${pinnedId} and r.org_id = ${orgId} and r.is_active`));
    const row = pin.rows[0];
    if (!row) {
      throw new TaxReturnError(
        `tax registration "${pinnedId}" was not found in this organization`,
      );
    }
    if (row.return_form_code !== formCode) {
      throw new TaxReturnError(
        `registration "${row.registration_number ?? row.id}" files form "${row.return_form_code ?? "(none)"}", not "${formCode}"`,
      );
    }
    // The pin names the form, not the jurisdiction: a registration whose
    // jurisdiction does not own the pinned form (a California registration
    // pinned to a New York return) refuses here by name instead of printing
    // the wrong jurisdiction's number on the return.
    const pinProblem = taxRegistrationFormProblem({
      registrationLabel: row.registration_number ?? row.id,
      registrationJurisdictionCode: row.jurisdiction_code,
      formCode,
    });
    if (pinProblem) throw new TaxReturnError(pinProblem);
    return {
      registrationNumber: row.registration_number,
      registrationId: row.id,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
    };
  }
  const regRes = (await runner.execute<{ id: string; registration_number: string | null; jurisdiction_code: string }>(sql`
    select r.id, r.registration_number, j.code as jurisdiction_code
      from tax_registrations r
      join tax_jurisdictions j on j.id = r.jurisdiction_id and j.org_id = r.org_id
     where r.org_id = ${orgId} and r.is_active and r.return_form_code = ${formCode}
       and (r.effective_from is null or r.effective_from <= ${to})
       and (r.effective_to is null or r.effective_to >= ${from})
     order by r.effective_from desc nulls last, r.id`));
  // The form match alone is not the identity: a catalog-known form belongs
  // to one jurisdiction, so a registration from another jurisdiction (a
  // legacy mismatched row saved before the write-time check) must refuse by
  // name rather than lend its number to the wrong jurisdiction's return.
  // Tenant-defined forms carry no catalog rule and keep the historical pick.
  const expectedJurisdiction = taxReturnPack(formCode)?.jurisdiction.code ?? null;
  const inJurisdiction = expectedJurisdiction
    ? regRes.rows.filter((row) => row.jurisdiction_code === expectedJurisdiction)
    : regRes.rows;
  if (inJurisdiction.length === 0 && regRes.rows.length > 0) {
    const legacy = regRes.rows[0]!;
    throw new TaxReturnError(
      taxRegistrationFormProblem({
        registrationLabel: legacy.registration_number ?? legacy.id,
        registrationJurisdictionCode: legacy.jurisdiction_code,
        formCode,
      }) ?? `tax return "${formCode}" has no registration in jurisdiction "${expectedJurisdiction}"`,
    );
  }
  return {
    registrationNumber: inJurisdiction[0]?.registration_number ?? null,
    registrationId: inJurisdiction[0]?.id ?? null,
    effectiveFrom: null,
    effectiveTo: null,
  };
}

/**
 * Fail closed when an in-scope code with period activity maps to no box.
 * Only codes that belong on THIS return count: codes scoped to the form's
 * jurisdiction, plus the codes the return-pack catalog declares for the
 * form (a hand-made code carrying the expected code string but no
 * jurisdiction). Any other code with activity is another return's
 * business — a multi-jurisdiction org files each return separately.
 */
async function assertNoUnmappedActivity(
  runner: TaxReturnRunner,
  opts: {
    orgId: string;
    formCode: string;
    from: string;
    to: string;
    primaryBookId: string;
    scopeIds: string[] | null;
    formJurisdictionId: string | null;
    mappedCodeIds: string[];
  },
): Promise<void> {
  const { orgId, formCode, from, to, primaryBookId, scopeIds, formJurisdictionId, mappedCodeIds } = opts;
  const pack = countryTaxPackForReturn(formCode);
  const expectedCodes = pack ? packTaxCodesForReturn(pack, formCode).map((d) => d.code) : [];
  if (!formJurisdictionId && expectedCodes.length === 0) return;
  const journalActivity = journalReturnActivityPredicate({ from, to, primaryBookId, scopeIds });
  const codeMatch = expectedCodes.length > 0
    ? sql`or tc.code in (${sql.join(expectedCodes.map((code) => sql`${code}`), sql`, `)})`
    : sql``;
  const rows = (await runner.execute<{ code: string }>(sql`
    select tc.code
      from tax_codes tc
     where tc.org_id = ${orgId}
       and (
         ${formJurisdictionId ? sql`tc.jurisdiction_id = ${formJurisdictionId}` : sql`false`}
         ${codeMatch}
       )
       and not (tc.id = any(${uuidArray(mappedCodeIds)}::uuid[]))
       and exists (
         select 1
           from journal_lines l
           join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
           left join documents vd on vd.id = e.source_document_id and vd.org_id = l.org_id
          where l.org_id = ${orgId} and l.tax_code_id = tc.id
            ${journalActivity}
       )
     order by tc.code`));
  if (rows.rows.length === 0) return;
  const codes = rows.rows.map((r) => `"${r.code}"`).join(", ");
  throw new TaxReturnError(
    `tax return "${formCode}" understates: tax code${rows.rows.length === 1 ? "" : "s"} ${codes} ` +
    `has activity in ${from} to ${to} but maps to no box — map each code to a box ` +
    `(reinstall the "${formCode}" library form after assigning its jurisdiction), ` +
    `otherwise the filed return omits that activity`,
  );
}

async function computeTaxReturnInSnapshot(
  runner: TaxReturnRunner,
  orgId: string,
  formCode: string,
  from: string,
  to: string,
  adjustments: Record<string, string> = {},
  opts: ComputeTaxReturnOptions = {},
): Promise<TaxReturnResult> {
  const formRes = (await runner.execute<{ name: string; submission_channel: string; watermark: string | null; jurisdiction_id: string | null }>(sql`
    select name, submission_channel, watermark, jurisdiction_id
      from tax_return_forms
     where org_id = ${orgId} and code = ${formCode} and is_active limit 1`));
  const form = formRes.rows[0];
  if (!form) throw new TaxReturnError(`tax return form "${formCode}" is not configured`);

  // A pinned registration clamps to ITS own filing obligation first (never a
  // sibling's); unpinned, the clamp fails closed when several registrations
  // share the form instead of arbitrarily picking one.
  const window = await clampTaxReturnWindowInSnapshot(
    runner,
    orgId,
    formCode,
    from,
    to,
    opts?.filingEntity?.registrationId,
  );
  from = window.from;
  to = window.to;

  // The filing identity resolves before any amount is summed: a pinned
  // registration narrows the clamped window to its own effective window (the
  // clamp above already matched that registration's obligation; the
  // intersection only bites when the registration's effective window is
  // narrower than its period).
  const registration = await resolveReturnRegistration(
    runner,
    orgId,
    formCode,
    from,
    to,
    opts?.filingEntity?.registrationId,
  );
  if (registration.effectiveFrom && registration.effectiveFrom > from) from = registration.effectiveFrom;
  if (registration.effectiveTo && registration.effectiveTo < to) to = registration.effectiveTo;
  if (from > to) {
    throw new TaxReturnError(
      `registration "${registration.registrationNumber ?? registration.registrationId}" covers none of the return period — nothing reportable`,
    );
  }

  // The subsidiary scope and translation policy are resolved up front so every
  // sum below reads one consistent posture. Adjustments are denominated in the
  // return's functionalCurrency: the entity's currency, or the presentation
  // currency for a translated view (applied once, after translation).
  const scope = await resolveReturnScope(runner, orgId, opts?.filingEntity);
  const policy = resolveTranslationPolicy(opts?.translation, to);

  // The return reads the primary book only — the same book the filing gate
  // (assertCoveredPeriodsClosed) fences. The kernel posts documents to the
  // single primary posting book and every sibling engine scopes to
  // is_primary; without this predicate a tax journal in any secondary book
  // leaked into the return while no period fence covered it. Resolved
  // through the shared active posting primary: after a deactivation the
  // return reads the live book, never the dead primary.
  const primaryBookId = await activePostingPrimaryBookId(orgId, runner);
  if (!primaryBookId) throw new TaxReturnError("no primary accounting book");

  // Org control tax accounts — the fallback a tax code posts to when it has no
  // collected/paid account of its own.
  const ctrlRes = (await runner.execute<{ tax_collected: string | null; tax_paid: string | null }>(sql`
    select settings->'controlAccounts'->>'taxCollected' as tax_collected,
           settings->'controlAccounts'->>'taxPaid' as tax_paid
      from orgs where id = ${orgId}`));
  const orgTaxCollected = ctrlRes.rows[0]?.tax_collected ?? null;
  const orgTaxPaid = ctrlRes.rows[0]?.tax_paid ?? null;

  const boxRes = (await runner.execute<{
      line_code: string; label: string; sign: number; sequence: number;
      tax_code_id: string | null; basis: string | null; formula: string | null; pdf_field: string | null;
    }>(sql`
    select line_code, label, coalesce(sign, 1) as sign, coalesce(sequence, 0) as sequence,
           tax_code_id, basis, formula, pdf_field
      from tax_report_lines
     where org_id = ${orgId} and report_code = ${formCode}
     order by sequence, line_code`));
  if (boxRes.rows.length === 0) {
    throw new TaxReturnError(`tax return form "${formCode}" has no boxes configured`);
  }

  const { boxes: boxDefs, glSources } = planReturn(
    boxRes.rows.map((r) => ({
      lineCode: r.line_code,
      label: r.label,
      sign: Number(r.sign),
      sequence: Number(r.sequence),
      taxCodeId: r.tax_code_id,
      basis: r.basis,
      formula: r.formula,
      pdfField: r.pdf_field,
    })),
  );

  // A code the install left out of every box contributes nothing to the
  // figures — a hand-made code with no jurisdiction never lands in a state
  // return, and the filed figures silently understate. When such a code
  // holds this form's jurisdiction (or the catalog expects it on this form)
  // AND has activity in the period, refuse by name instead of filing short.
  await assertNoUnmappedActivity(runner, {
    orgId,
    formCode,
    from,
    to,
    primaryBookId,
    scopeIds: scope.legacy ? null : scope.ids,
    formJurisdictionId: form.jurisdiction_id,
    mappedCodeIds: [...new Set(glSources.map((s) => s.taxCodeId))],
  });

  // Posture: which functional currencies hold return-relevant activity in the
  // scope. Precise to the return's own predicates, so an idle foreign
  // subsidiary never forces translation — and a mixed scope without a declared
  // policy fails closed instead of adding unlike units.
  const sourceCodeIds = [...new Set(glSources.map((s) => s.taxCodeId))];
  const baseCodeIds = [...new Set(
    glSources.filter((s) => s.basis === "taxable_base").map((s) => s.taxCodeId),
  )];
  const { ids: contributorIds, nullSubsidiaryDocs } = await findReturnContributors(
    runner,
    orgId,
    scope,
    { from, to, bookId: primaryBookId },
    sourceCodeIds,
    baseCodeIds,
    scope.explicit,
  );
  // NULL-subsidiary legacy documents attribute to the root fallback the kernel
  // stamps (doc.subsidiaryId ?? root) — but only when the root is in scope, so
  // an explicit filing entity never absorbs unattributable history.
  const nullDocArm =
    nullSubsidiaryDocs && scope.rootId !== null && scope.ids.includes(scope.rootId);
  const posture = new Set<string>();
  for (const id of contributorIds) {
    const ccy = scope.currencyById.get(id);
    if (ccy) posture.add(ccy);
  }
  if (nullSubsidiaryDocs && scope.rootId !== null) {
    const rootCcy = scope.currencyById.get(scope.rootId);
    if (rootCcy) posture.add(rootCcy);
  }

  const adjustmentsMap = new Map(Object.entries(adjustments));
  const sumBase = {
    orgId,
    formCode,
    from,
    to,
    primaryBookId,
    orgTaxCollected,
    orgTaxPaid,
    glSources,
  };
  let functionalCurrency: string;
  let translation: TaxReturnTranslation | null = null;
  let boxes: TaxReturnBox[];
  if (!policy && posture.size > 1) {
    throw new TaxReturnError(
      `tax return "${formCode}" spans functional currencies (${[...posture].sort().join(" and ")}) across subsidiaries — pass subsidiaryIds for one filing entity's return, or translation.presentationCurrency for a translated consolidated view`,
    );
  }
  if (policy) {
    // Translated consolidated view — taken even when single-currency, so the
    // declared policy and its evidence are always visible when asked for.
    const translated = await translateReturnGlRaw(
      runner,
      orgId,
      sumBase,
      boxDefs,
      scope,
      contributorIds,
      policy,
    );
    translation = translated.translation;
    functionalCurrency = policy.presentationCurrency;
    boxes = assembleReturn(boxDefs, translated.glRaw, adjustmentsMap);
  } else {
    const glRaw = await sumReturnGlRaw(runner, {
      ...sumBase,
      scopeIds: scope.legacy ? null : scope.ids,
      nullDocArm,
    });
    if (posture.size === 1) {
      functionalCurrency = [...posture][0]!;
    } else {
      // No return-relevant activity (or a degenerate org): every box is zero
      // at any rate. Prefer the scope's single currency when it has one so an
      // idle filing entity still reports in its own words, else the org base.
      const scopeCurrencies = new Set(
        scope.ids
          .map((id) => scope.currencyById.get(id))
          .filter((c): c is string => Boolean(c)),
      );
      if (scopeCurrencies.size === 1) {
        functionalCurrency = [...scopeCurrencies][0]!;
      } else {
        const orgRow = (await runner.execute<{ base_currency: string }>(sql`
          select base_currency from orgs where id = ${orgId}`));
        const orgBase = orgRow.rows[0]?.base_currency;
        if (!orgBase) throw new TaxReturnError("organization has no base currency");
        functionalCurrency = orgBase;
      }
    }
    boxes = assembleReturn(boxDefs, glRaw, adjustmentsMap);
  }

  // The filing identity travels with the computed boxes so every printed
  // surface (notably the form-faithful facsimile) identifies the return with
  // the org's own registration — never a placeholder.
  return {
    formCode,
    formName: form.name,
    from,
    to,
    submissionChannel: form.submission_channel,
    watermark: form.watermark,
    registrationNumber: registration.registrationNumber,
    boxes,
    functionalCurrency,
    subsidiaryIds: scope.legacy ? [] : scope.ids,
    registrationId: registration.registrationId,
    translation,
  };
}

/**
 * Compute a complete return from one pinned repeatable-read PostgreSQL
 * snapshot — unless the caller passes `opts.runner`, in which case the return
 * runs directly on that executor (a caller-owned transaction) and opens no
 * snapshot of its own.
 *
 * Without `opts` the return covers the whole org exactly as before (every
 * subsidiary's lines, form+window registration match) — single-currency orgs
 * see identical boxes plus the new `functionalCurrency` evidence. Pass
 * `opts.filingEntity` for one legal filer's return in its functional
 * currency, and `opts.translation` for a translated consolidated view.
 * Adjustments are denominated in the return's `functionalCurrency`.
 */
export async function computeTaxReturn(
  orgId: string,
  formCode: string,
  from: string,
  to: string,
  adjustments: Record<string, string> = {},
  opts: ComputeTaxReturnOptions = {},
): Promise<TaxReturnResult> {
  if (opts.runner) {
    return computeTaxReturnInSnapshot(opts.runner, orgId, formCode, from, to, adjustments, opts);
  }
  return returnDb.transaction(
    (tx) => computeTaxReturnInSnapshot(tx, orgId, formCode, from, to, adjustments, opts),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
