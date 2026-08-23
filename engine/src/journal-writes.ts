import { sql } from "drizzle-orm";
import { canonicalDecimal } from "./exact-decimal.ts";
import { db, schema, withOrgTransaction } from "./db.ts";
import { businessToday } from "./business-date.ts";
import { abs, cmp, isZero, normalizeMoney, sum } from "./money.ts";
import { loadControlAccounts } from "./control-accounts.ts";
import { postDocument, runPostDocumentEffects } from "./posting.ts";
import { submitAndReleaseIfUngated } from "./flows/submit.ts";

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
}

export interface ScriptJournalInput {
  /** ISO date (YYYY-MM-DD); defaults to today. */
  documentDate?: string;
  memo?: string;
  referenceNumber?: string;
  lines: ScriptJournalLine[];
}

export interface ScriptJournalResult {
  id: string;
  documentNumber: string;
  /** Present only when post=true succeeded. */
  entryId?: string;
  /** A configured flow accepted the request and is awaiting approval. */
  approvalPending?: boolean;
}

export class JournalWriteError extends Error {
  readonly name = "JournalWriteError";
}

/** Persist leftover journal-line amounts through exact decimal then ledger money. Fail closed. */
function persistJournalLineAmount(value: unknown, line: number): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) {
    throw new JournalWriteError(`line ${line}: amount must be a nonzero number with at most 4 decimal places`);
  }
  try {
    return normalizeMoney(exact);
  } catch {
    throw new JournalWriteError(`line ${line}: amount must be a nonzero number with at most 4 decimal places`);
  }
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
  lines: { accountId?: string; accountCode?: string; amount: string; description: string | null; departmentId: string | null; projectId: string | null }[];
  totalDebits: string;
} {
  if (!input || typeof input !== "object") throw new JournalWriteError("journal input must be an object");
  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw new JournalWriteError("journal needs at least 2 lines");
  }
  if (input.lines.length > MAX_LINES) throw new JournalWriteError(`too many lines (max ${MAX_LINES})`);
  // The validator is pure and cannot know the tenant. Inventing UTC today
  // here would stamp journals onto the wrong day for every org that is not
  // on UTC. createScriptJournal applies businessToday before calling this.
  if (input.documentDate == null || input.documentDate === "") {
    throw new JournalWriteError(
      "documentDate is required (YYYY-MM-DD); apply the organization's business day before calling the validator",
    );
  }
  const documentDate = input.documentDate;
  if (!DATE_RE.test(documentDate)) throw new JournalWriteError(`invalid documentDate "${input.documentDate}" (use YYYY-MM-DD)`);

  const amounts: string[] = [];
  const debits: string[] = [];
  const lines = input.lines.map((l, i) => {
    const amount = persistJournalLineAmount(l.amount, i + 1);
    if (isZero(amount)) throw new JournalWriteError(`line ${i + 1}: amount must be a nonzero number`);
    if (cmp(abs(amount), "10000000000000.0000") > 0) throw new JournalWriteError(`line ${i + 1}: amount out of range`);
    if (!l.accountId && !l.accountCode) throw new JournalWriteError(`line ${i + 1}: accountId or accountCode required`);
    if (l.accountId && !UUID_RE.test(l.accountId)) throw new JournalWriteError(`line ${i + 1}: invalid accountId`);
    amounts.push(amount);
    if (cmp(amount, "0") > 0) debits.push(amount);
    return {
      accountId: l.accountId,
      accountCode: l.accountCode ? String(l.accountCode) : undefined,
      amount,
      description: l.description ? String(l.description).slice(0, 500) : null,
      departmentId: l.departmentId && UUID_RE.test(l.departmentId) ? l.departmentId : null,
      projectId: l.projectId && UUID_RE.test(l.projectId) ? l.projectId : null,
    };
  });
  // Balanced to the 4dp the ledger stores.
  const balance = sum(amounts);
  if (!isZero(balance)) {
    throw new JournalWriteError(`journal is not balanced (debits − credits = ${balance})`);
  }
  return {
    documentDate,
    memo: input.memo ? String(input.memo).slice(0, 2000) : null,
    referenceNumber: input.referenceNumber ? String(input.referenceNumber).slice(0, 100) : null,
    lines,
    totalDebits: sum(debits),
  };
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
  // The pure validator cannot know the tenant, so the org's business-day
  // default is applied here. The validator refuses a missing date rather
  // than inventing UTC today.
  const effective: ScriptJournalInput = input.documentDate
    ? input
    : { ...input, documentDate: await businessToday(orgId) };
  const v = validateJournalInput(effective);

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

  const company = ((await db.execute(sql`
    select s.id as subsidiary_id, nullif(trim(s.base_currency), '') as base_currency
      from orgs o
      left join lateral (
        select id, base_currency from subsidiaries
         where org_id = o.id and parent_id is null and is_active and not is_elimination
         limit 1
      ) s on true
     where o.id = ${orgId}
  `)) as any).rows[0] as { subsidiary_id: string | null; base_currency: string | null } | undefined;
  if (!company) throw new JournalWriteError("organization does not exist");
  if (!company.subsidiary_id) {
    throw new JournalWriteError("organization has no active root subsidiary");
  }
  if (!company.base_currency) {
    throw new JournalWriteError("root subsidiary has no configured functional currency");
  }

  const docId = await db.transaction(async (tx) => {
    // JE- sequence, same upsert the UI path uses (web/lib/bills.ts).
    const seq = (await tx.execute(sql`
      insert into number_sequences (org_id, document_kind, prefix)
      values (${orgId}, 'journal', 'JE-')
      on conflict on constraint sequences_org_kind_sub
      do update set next_number = number_sequences.next_number + 1
      where number_sequences.org_id = ${orgId}
      returning prefix, next_number, padding`)) as any;
    const s = seq.rows[0]!;
    const documentNumber = `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;

    const ins = (await tx.execute(sql`
      insert into documents (org_id, kind, document_number, subsidiary_id, document_date, currency,
                             memo, reference_number, subtotal, tax_total, total, created_by)
      values (${orgId}, 'journal', ${documentNumber}, ${company.subsidiary_id}, ${v.documentDate}, ${company.base_currency},
              ${v.memo}, ${v.referenceNumber}, ${v.totalDebits}, '0', ${v.totalDebits}, ${actorId})
      returning id`)) as any;
    const id = String(ins.rows[0].id);

    for (let i = 0; i < v.lines.length; i++) {
      const l = v.lines[i]!;
      const accountId = l.accountId ?? byCode.get(l.accountCode!)!;
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, department_id, project_id, custom)
        values (${orgId}, ${id}, ${i + 1}, ${accountId}, ${l.description},
                '1', ${l.amount}, ${l.amount}, ${l.departmentId}, ${l.projectId}, '{}')`);
    }
    const num = (await tx.execute(sql`select document_number from documents where id = ${id} and org_id = ${orgId}`)) as any;
    return { id, documentNumber: String(num.rows[0].document_number) };
  });

  if (!opts.post) return docId;

  if (!actorId) {
    throw new JournalWriteError("posting a script journal requires an attributable actor");
  }
  const outcome = await withOrgTransaction(orgId, async () => {
    const submission = await submitAndReleaseIfUngated("journal", docId.id, actorId);
    if (submission.flowError) {
      throw new JournalWriteError(`approval could not be routed: ${submission.flowError}`);
    }
    if (submission.gated) return { approvalPending: true as const };
    const entryId = await postDocument(
      docId.id,
      { control: await loadControlAccounts(orgId) },
      { deferEffects: true },
    );
    return { approvalPending: false as const, entryId };
  });
  if (outcome.approvalPending) return { ...docId, approvalPending: true };
  await runPostDocumentEffects(docId.id, "draft");
  const entryId = outcome.entryId;
  return { ...docId, entryId: String(entryId) };
}

/** Drizzle schema re-export so callers can typecheck against documents. */
export { schema };
