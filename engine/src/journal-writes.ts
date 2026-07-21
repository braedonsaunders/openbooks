import { sql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { postDocument } from "./posting.ts";
import { fromUnits, toUnits } from "./money.ts";

/**
 * Governed journal writes for sandboxed code (App backends + user scripts).
 * The ONE write path from a sandbox into the ledger, and it goes through the
 * same machinery the UI uses: a numbered draft `documents` row (kind 'journal',
 * JE- sequence) + `document_lines`, then — only when explicitly requested and
 * permitted — engine postDocument(), which enforces every posting invariant
 * (balance kernel, open period, account validity). Sandboxed code can never
 * touch journal_entries/journal_lines directly.
 *
 * Validation here is deliberately stricter than the UI's draft editor: a
 * script-created journal must be BALANCED at creation (signed amounts sum to
 * zero), because there is no human in the loop to fix an unbalanced draft.
 */

export interface ScriptJournalLine {
  /** Resolve the GL account by id or by account number/code (one required). */
  accountId?: string;
  accountCode?: string;
  /** Signed base amount: positive = debit, negative = credit. */
  amount: number | string;
  description?: string;
  departmentId?: string;
  projectId?: string;
  locationId?: string;
  subsidiaryId?: string;
}

export interface ScriptJournalInput {
  /** ISO date (YYYY-MM-DD); defaults to today. */
  documentDate?: string;
  memo?: string;
  referenceNumber?: string;
  subsidiaryId?: string;
  lines: ScriptJournalLine[];
}

export interface ScriptJournalResult {
  id: string;
  documentNumber: string;
  /** Present only when post=true succeeded. */
  entryId?: string;
}

export class JournalWriteError extends Error {
  readonly name = "JournalWriteError";
}

const MAX_LINES = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure validation + normalization — exported separately so it unit-tests
 * without a database. Throws JournalWriteError with a script-readable message.
 */
export function validateJournalInput(input: ScriptJournalInput): {
  documentDate: string;
  memo: string | null;
  referenceNumber: string | null;
  subsidiaryId: string | null;
  lines: { accountId?: string; accountCode?: string; amount: string; description: string | null; departmentId: string | null; projectId: string | null; locationId: string | null; subsidiaryId: string | null }[];
  totalDebits: string;
} {
  if (!input || typeof input !== "object") throw new JournalWriteError("journal input must be an object");
  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw new JournalWriteError("journal needs at least 2 lines");
  }
  if (input.lines.length > MAX_LINES) throw new JournalWriteError(`too many lines (max ${MAX_LINES})`);
  const documentDate = input.documentDate ?? new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(documentDate)) throw new JournalWriteError(`invalid documentDate "${input.documentDate}" (use YYYY-MM-DD)`);

  if (input.subsidiaryId && !UUID_RE.test(input.subsidiaryId)) throw new JournalWriteError("invalid subsidiaryId");
  let balance = 0n;
  let debits = 0n;
  const lines = input.lines.map((l, i) => {
    let units: bigint;
    try {
      units = toUnits(String(l.amount));
    } catch {
      throw new JournalWriteError(`line ${i + 1}: amount must be a nonzero number`);
    }
    if (units === 0n) throw new JournalWriteError(`line ${i + 1}: amount must be a nonzero number`);
    if (units > 9999999999999999999n || units < -9999999999999999999n) throw new JournalWriteError(`line ${i + 1}: amount out of range`);
    if (!l.accountId && !l.accountCode) throw new JournalWriteError(`line ${i + 1}: accountId or accountCode required`);
    if (l.accountId && !UUID_RE.test(l.accountId)) throw new JournalWriteError(`line ${i + 1}: invalid accountId`);
    for (const [name, value] of Object.entries({ departmentId: l.departmentId, projectId: l.projectId, locationId: l.locationId, subsidiaryId: l.subsidiaryId })) {
      if (value && !UUID_RE.test(value)) throw new JournalWriteError(`line ${i + 1}: invalid ${name}`);
    }
    balance += units;
    if (units > 0n) debits += units;
    return {
      accountId: l.accountId,
      accountCode: l.accountCode ? String(l.accountCode) : undefined,
      amount: fromUnits(units),
      description: l.description ? String(l.description).slice(0, 500) : null,
      departmentId: l.departmentId && UUID_RE.test(l.departmentId) ? l.departmentId : null,
      projectId: l.projectId && UUID_RE.test(l.projectId) ? l.projectId : null,
      locationId: l.locationId && UUID_RE.test(l.locationId) ? l.locationId : null,
      subsidiaryId: l.subsidiaryId && UUID_RE.test(l.subsidiaryId) ? l.subsidiaryId : null,
    };
  });
  if (balance !== 0n) {
    throw new JournalWriteError(`journal is not balanced (debits − credits = ${fromUnits(balance)})`);
  }
  return {
    documentDate,
    memo: input.memo ? String(input.memo).slice(0, 2000) : null,
    referenceNumber: input.referenceNumber ? String(input.referenceNumber).slice(0, 100) : null,
    subsidiaryId: input.subsidiaryId ?? null,
    lines,
    totalDebits: fromUnits(debits),
  };
}

/** Same shape web/lib/documents.ts controlDeps() builds — posting rule deps. */
async function controlDeps(orgId: string) {
  const r = (await db.execute(sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`)) as any;
  const c = r.rows[0]?.c ?? {};
  return { control: { ar: c.ar, ap: c.ap, bank: c.bank, taxCollected: c.taxCollected, taxPaid: c.taxPaid } };
}

/**
 * Create a balanced draft journal from sandboxed code, optionally posting it.
 * Account codes resolve within the org; unknown/inactive accounts are refused.
 * post=true runs the real posting engine — every invariant it enforces
 * (closed period, balance kernel) applies unchanged.
 */
export async function createScriptJournal(
  orgId: string,
  actorId: string | null,
  input: ScriptJournalInput,
  opts: { post?: boolean } = {},
): Promise<ScriptJournalResult> {
  const v = validateJournalInput(input);

  // Resolve accountCode → id (org-scoped, active accounts only), and verify
  // provided accountIds actually exist in this org.
  const codes = [...new Set(v.lines.filter((l) => !l.accountId).map((l) => l.accountCode!))];
  const ids = [...new Set(v.lines.filter((l) => l.accountId).map((l) => l.accountId!))];
  const byCode = new Map<string, string>();
  // Summary accounts group children and REFUSE postings (schema/src/coa.ts) —
  // exclude them at resolution so the error is script-readable, not a trigger.
  // NOTE: drizzle's sql`` expands a JS array into a ($1, $2, …) tuple — pair it
  // with `in`, never `= any()` (which needs a real array parameter).
  if (codes.length) {
    const r = (await db.execute(sql`
      select id, number from accounts
       where org_id = ${orgId} and is_active = true and is_summary = false and number in ${codes}`)) as any;
    for (const row of r.rows) byCode.set(String(row.number), String(row.id));
    for (const c of codes) if (!byCode.has(c)) throw new JournalWriteError(`unknown, inactive, or summary account code "${c}"`);
  }
  if (ids.length) {
    const r = (await db.execute(sql`
      select id from accounts where org_id = ${orgId} and is_active = true and is_summary = false and id in ${ids}`)) as any;
    const found = new Set(r.rows.map((x: any) => String(x.id)));
    for (const id of ids) if (!found.has(id)) throw new JournalWriteError(`unknown, inactive, or summary accountId "${id}"`);
  }

  const subsidiaryIds = [...new Set([v.subsidiaryId, ...v.lines.map((line) => line.subsidiaryId)].filter((id): id is string => Boolean(id)))];
  const dimensionSpecs = [
    { table: "subsidiaries", ids: subsidiaryIds },
    { table: "departments", ids: [...new Set(v.lines.map((line) => line.departmentId).filter((id): id is string => Boolean(id)))] },
    { table: "projects", ids: [...new Set(v.lines.map((line) => line.projectId).filter((id): id is string => Boolean(id)))] },
    { table: "locations", ids: [...new Set(v.lines.map((line) => line.locationId).filter((id): id is string => Boolean(id)))] },
  ];
  for (const spec of dimensionSpecs) {
    if (!spec.ids.length) continue;
    const r = (await db.execute(sql`
      select id from ${sql.raw(spec.table)} where org_id = ${orgId} and id in ${spec.ids}`)) as any;
    const found = new Set(r.rows.map((row: any) => String(row.id)));
    for (const id of spec.ids) if (!found.has(id)) throw new JournalWriteError(`unknown ${spec.table} id "${id}"`);
  }

  const root = ((await db.execute(sql`
    select id, base_currency from subsidiaries
     where org_id = ${orgId} and parent_id is null and is_active limit 1`)) as any).rows[0];
  if (!root) throw new JournalWriteError("organization has no active root subsidiary");
  const documentSubsidiaryId = v.subsidiaryId ?? String(root.id);
  const currency = String(root.base_currency);

  const docId = await db.transaction(async (tx) => {
    // JE- sequence, same upsert the UI path uses (web/lib/bills.ts).
    const seq = (await tx.execute(sql`
      insert into number_sequences (org_id, document_kind, prefix)
      values (${orgId}, 'journal', 'JE-')
      on conflict on constraint sequences_org_kind_sub
      do update set next_number = number_sequences.next_number + 1
      returning prefix, next_number, padding`)) as any;
    const s = seq.rows[0]!;
    const documentNumber = `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;

    const ins = (await tx.execute(sql`
      insert into documents (org_id, kind, document_number, document_date, currency,
                             subsidiary_id, memo, reference_number, subtotal, tax_total, total, created_by)
      values (${orgId}, 'journal', ${documentNumber}, ${v.documentDate}, ${currency}, ${documentSubsidiaryId},
              ${v.memo}, ${v.referenceNumber}, ${v.totalDebits}, '0', ${v.totalDebits}, ${actorId})
      returning id`)) as any;
    const id = String(ins.rows[0].id);

    for (let i = 0; i < v.lines.length; i++) {
      const l = v.lines[i]!;
      const accountId = l.accountId ?? byCode.get(l.accountCode!)!;
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, subsidiary_id, department_id, project_id, location_id, custom)
        values (${orgId}, ${id}, ${i + 1}, ${accountId}, ${l.description},
                '1', ${l.amount}, ${l.amount}, ${l.subsidiaryId ?? documentSubsidiaryId}, ${l.departmentId}, ${l.projectId}, ${l.locationId}, '{}')`);
    }
    const num = (await tx.execute(sql`select document_number from documents where id = ${id}`)) as any;
    return { id, documentNumber: String(num.rows[0].document_number) };
  });

  if (!opts.post) return docId;

  // Posting runs OUTSIDE the creation transaction, exactly like the UI action
  // route — a posting failure leaves a valid draft behind, never half a post.
  const entryId = await postDocument(docId.id, await controlDeps(orgId));
  return { ...docId, entryId: String(entryId) };
}

/** Drizzle schema re-export so callers can typecheck against documents. */
export { schema };
