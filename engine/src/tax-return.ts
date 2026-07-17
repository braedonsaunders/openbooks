import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { abs, add, fromUnits, neg, toUnits } from "./money.ts";

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
 * Evaluate a box `formula` — `+`/`-` and `abs(...)` over line-code references,
 * numeric literals and parentheses — against already-computed box values, in
 * exact money math. `abs` is required by returns such as UK VAT100 box 5 and
 * New Zealand GST101A box 15, which report the unsigned difference between tax
 * collected and credits. Anything else is a configuration error, not silent 0.
 */
export function evalFormula(
  expr: string,
  values: Map<string, string>,
  boxCodes: ReadonlySet<string>,
): string {
  const tokens = expr.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[(),+\-]/g);
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
  // term := '(' expr ')' | '-' term | 'abs' '(' expr ')' | boxCode | numberLiteral
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
    // Box code wins over numeric-literal reading, so "105 - 108" references
    // boxes 105 and 108 rather than the numbers.
    if (boxCodes.has(tok)) return boxRef(tok);
    if (/^\d/.test(tok)) return fromUnits(toUnits(tok));
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
  boxes: TaxReturnBox[];
}

/**
 * Compute a configured tax return for a period. Loads the form + its boxes,
 * sums the ledger for each GL-mapped box (tax amount, or the taxable base the
 * tax applied to), then assembles computed boxes on top. Postings are counted
 * once posted and dated within [from, to].
 */
export async function computeTaxReturn(
  orgId: string,
  formCode: string,
  from: string,
  to: string,
  adjustments: Record<string, string> = {},
): Promise<TaxReturnResult> {
  const formRes = (await db.execute(sql`
    select name, submission_channel, watermark
      from tax_return_forms
     where org_id = ${orgId} and code = ${formCode} and is_active limit 1`)) as unknown as {
    rows: { name: string; submission_channel: string; watermark: string | null }[];
  };
  const form = formRes.rows[0];
  if (!form) throw new TaxReturnError(`tax return form "${formCode}" is not configured`);

  // Org control tax accounts — the fallback a tax code posts to when it has no
  // collected/paid account of its own.
  const ctrlRes = (await db.execute(sql`
    select settings->'controlAccounts'->>'taxCollected' as tax_collected,
           settings->'controlAccounts'->>'taxPaid' as tax_paid
      from orgs where id = ${orgId}`)) as unknown as {
    rows: { tax_collected: string | null; tax_paid: string | null }[];
  };
  const orgTaxCollected = ctrlRes.rows[0]?.tax_collected ?? null;
  const orgTaxPaid = ctrlRes.rows[0]?.tax_paid ?? null;

  const boxRes = (await db.execute(sql`
    select line_code, label, coalesce(sign, 1) as sign, coalesce(sequence, 0) as sequence,
           tax_code_id, basis, formula, pdf_field
      from tax_report_lines
     where org_id = ${orgId} and report_code = ${formCode}
     order by sequence, line_code`)) as unknown as {
    rows: {
      line_code: string; label: string; sign: number; sequence: number;
      tax_code_id: string | null; basis: string | null; formula: string | null; pdf_field: string | null;
    }[];
  };
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

  // Accumulate each GL source into its box. Several sources may feed one box
  // (e.g. GST + every HST rate → line 103). The basis decides WHAT is summed:
  //  - tax_collected / tax_paid: the tax on the code's collected (liability) or
  //    paid (recoverable) account — scoping to the account keeps a "both" code
  //    from feeding its collected tax into an ITC box (and vice versa);
  //  - tax_amount: every tax line for the code (kept for non-split reports);
  //  - taxable_base: the base the tax applied to.
  const glRaw = new Map<string, string>();
  for (const src of glSources) {
    let total: string;
    if (src.basis === "tax_collected" || src.basis === "tax_paid") {
      const orgFallback = src.basis === "tax_collected" ? orgTaxCollected : orgTaxPaid;
      const acctCol = src.basis === "tax_collected" ? sql`tc.collected_account_id` : sql`tc.paid_account_id`;
      const r = (await db.execute(sql`
        select coalesce(sum(l.amount), 0)::text as total
          from journal_lines l
          join journal_entries e on e.id = l.entry_id
          join tax_codes tc on tc.id = l.tax_code_id
         where l.org_id = ${orgId} and l.tax_code_id = ${src.taxCodeId}
           and e.status = 'posted' and e.posting_date between ${from} and ${to}
           and l.account_id = coalesce(${acctCol}, ${orgFallback})`)) as unknown as {
        rows: { total: string }[];
      };
      total = r.rows[0]?.total ?? "0";
    } else if (src.basis === "tax_amount") {
      const r = (await db.execute(sql`
        select coalesce(sum(l.amount), 0)::text as total
          from journal_lines l
          join journal_entries e on e.id = l.entry_id
         where l.org_id = ${orgId} and l.tax_code_id = ${src.taxCodeId}
           and e.status = 'posted' and e.posting_date between ${from} and ${to}`)) as unknown as {
        rows: { total: string }[];
      };
      total = r.rows[0]?.total ?? "0";
    } else {
      const r = (await db.execute(sql`
        select coalesce(sum(dl.amount), 0)::text as total
          from document_lines dl
          join documents d on d.id = dl.document_id
         where dl.org_id = ${orgId} and dl.tax_code_id = ${src.taxCodeId}
           and d.status = 'posted'
           and coalesce(d.posting_date, d.document_date) between ${from} and ${to}`)) as unknown as {
        rows: { total: string }[];
      };
      total = r.rows[0]?.total ?? "0";
    }
    glRaw.set(src.lineCode, add(glRaw.get(src.lineCode) ?? "0", total));
  }

  const boxes = assembleReturn(boxDefs, glRaw, new Map(Object.entries(adjustments)));

  return {
    formCode,
    formName: form.name,
    from,
    to,
    submissionChannel: form.submission_channel,
    watermark: form.watermark,
    boxes,
  };
}
