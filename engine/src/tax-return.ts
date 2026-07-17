import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, fromUnits, neg, toUnits } from "./money.ts";

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
}

export interface TaxReturnBox {
  lineCode: string;
  label: string;
  /** Final base-currency value at numeric(19,4), sign applied. */
  value: string;
  computed: boolean;
}

export class TaxReturnError extends Error {
  readonly name = "TaxReturnError";
}

/**
 * Evaluate a box `formula` — `+`/`-` over line-code references, numeric literals
 * and parentheses — against already-computed box values, in exact money math.
 * Deliberately supports only addition/subtraction (every real VAT/GST box is a
 * sum of other boxes); anything else is a configuration error, not silent 0.
 */
export function evalFormula(
  expr: string,
  values: Map<string, string>,
  boxCodes: ReadonlySet<string>,
): string {
  const tokens = expr.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[()+\-]/g);
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
  // term := '(' expr ')' | '-' term | boxCode | numberLiteral
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
    } else {
      value = signed(glRawByLineCode.get(box.lineCode) ?? "0");
    }
    values.set(box.lineCode, value);
    result.push({ lineCode: box.lineCode, label: box.label, value, computed: Boolean(box.formula?.trim()) });
  }
  return result;
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
): Promise<TaxReturnResult> {
  const formRes = (await db.execute(sql`
    select name, submission_channel, watermark
      from tax_return_forms
     where org_id = ${orgId} and code = ${formCode} and is_active limit 1`)) as unknown as {
    rows: { name: string; submission_channel: string; watermark: string | null }[];
  };
  const form = formRes.rows[0];
  if (!form) throw new TaxReturnError(`tax return form "${formCode}" is not configured`);

  const boxRes = (await db.execute(sql`
    select line_code, label, coalesce(sign, 1) as sign, coalesce(sequence, 0) as sequence,
           tax_code_id, basis, formula
      from tax_report_lines
     where org_id = ${orgId} and report_code = ${formCode}
     order by sequence, line_code`)) as unknown as {
    rows: {
      line_code: string; label: string; sign: number; sequence: number;
      tax_code_id: string | null; basis: string | null; formula: string | null;
    }[];
  };
  if (boxRes.rows.length === 0) {
    throw new TaxReturnError(`tax return form "${formCode}" has no boxes configured`);
  }

  // GL raw sums, once per box that maps to the ledger. tax_amount sums the tax
  // lines for the code; taxable_base sums the base of the lines it was applied to.
  const glRaw = new Map<string, string>();
  for (const row of boxRes.rows) {
    if (row.formula?.trim() || !row.tax_code_id || !row.basis) continue;
    if (row.basis === "tax_amount") {
      const r = (await db.execute(sql`
        select coalesce(sum(l.amount), 0)::text as total
          from journal_lines l
          join journal_entries e on e.id = l.entry_id
         where l.org_id = ${orgId} and l.tax_code_id = ${row.tax_code_id}
           and e.status = 'posted' and e.posting_date between ${from} and ${to}`)) as unknown as {
        rows: { total: string }[];
      };
      glRaw.set(row.line_code, r.rows[0]?.total ?? "0");
    } else {
      const r = (await db.execute(sql`
        select coalesce(sum(dl.amount), 0)::text as total
          from document_lines dl
          join documents d on d.id = dl.document_id
         where dl.org_id = ${orgId} and dl.tax_code_id = ${row.tax_code_id}
           and d.status = 'posted'
           and coalesce(d.posting_date, d.document_date) between ${from} and ${to}`)) as unknown as {
        rows: { total: string }[];
      };
      glRaw.set(row.line_code, r.rows[0]?.total ?? "0");
    }
  }

  const boxes = assembleReturn(
    boxRes.rows.map((r) => ({
      lineCode: r.line_code,
      label: r.label,
      sign: Number(r.sign),
      sequence: Number(r.sequence),
      formula: r.formula,
    })),
    glRaw,
  );

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
