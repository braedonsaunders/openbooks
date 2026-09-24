import { sql } from "drizzle-orm";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { db, orgContext, schema, type SqlExecutor, withOrgTransaction } from "../platform/db.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { businessToday, isIsoCalendarDate } from "../platform/business-date.ts";
import { fitsLedgerRange, isZero, ledgerSideTotals, normalizeMoney, sum } from "../money/money.ts";
import { loadRequiredControlAccounts } from "../records/control-accounts.ts";
import { postDocument } from "./posting-document.ts";
import { runPostDocumentEffects } from "./posting-dispatch.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";

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
 *
 * Atomicity contract of `post: true`: the draft rows, the approval submission,
 * and the ledger entry are one transaction — a failure anywhere leaves zero
 * documents and lines behind, never a hidden orphan draft. An actor-less
 * caller (scheduled/bulk scripts have no signed-in user) posts under explicit
 * system provenance instead of being refused after a draft was already
 * committed.
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
  /**
   * Explicit legal entity for the journal. Omitted = choose a default the
   * same way the HTTP draft route does: the root for an unrestricted actor,
   * the single allowed entity for a restricted one, otherwise refused.
   */
  subsidiaryId?: string | null;
  lines: ScriptJournalLine[];
}

/**
 * Scope refusal codes — the same vocabulary web/lib/journals.ts
 * DraftJournalScopeError uses for the HTTP draft route, so a sandbox caller is
 * refused exactly like a browser caller (an out-of-scope entity stays
 * indistinguishable from a nonexistent one).
 */
export type JournalScopeErrorCode =
  | "invalid_subsidiary"
  | "subsidiary_not_allowed"
  | "no_available_subsidiary"
  | "ambiguous_subsidiary_scope";

export interface CreateScriptJournalOptions {
  post?: boolean;
  /**
   * The acting principal's subsidiary visibility: null = unrestricted, a Set
   * = the allowed entities. Omitted = resolved live from the actor's roles
   * (never assumed unrestricted); an actor-less system caller is unrestricted.
   */
  allowedSubsidiaryIds?: ReadonlySet<string> | null;
  /**
   * Dedupe identity for one script-run write: the run namespace plus the
   * journal.create call ordinal within that run. When present the draft
   * insert runs ON CONFLICT DO NOTHING on (org_id, idempotency_key) and a
   * conflicting retry reads back the first execution's document instead of
   * posting a second numbered journal. Omitted = no dedupe (non-script
   * callers, and script runs with no stable retry identity).
   */
  idempotencyKey?: string;
  /**
   * Wall-clock deadline (ms epoch) of the enclosing script run. The write
   * transaction is fenced to it: a run that already exceeded its deadline
   * refuses before starting, and a transaction this call owns carries
   * SET LOCAL statement_timeout = remaining budget, so PostgreSQL itself
   * aborts statements still running past the deadline instead of letting
   * them commit after the host reported a timeout. Omitted = unfenced
   * (non-script callers keep the pool's own bounds).
   */
  deadlineMs?: number;
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
  /** Present for subsidiary-scope refusals (see JournalScopeErrorCode). */
  readonly code?: JournalScopeErrorCode;

  constructor(message: string, code?: JournalScopeErrorCode) {
    super(message);
    if (code) this.code = code;
  }
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
 * Provenance markers stamped onto documents.custom when a script journal is
 * created without an attributable actor (scheduled/bulk scripts have no
 * signed-in user). Mirrors the engine-wide convention (engine/src/delivery/email-config.ts):
 * created_by stays null for a system actor while explicit markers carry the
 * attribution evidence, so a null created_by always means "the system wrote
 * this", never "nobody recorded who wrote it".
 */
const SYSTEM_PROVENANCE = Object.freeze({
  actorKind: "system",
  actorReason: "sandboxed script",
});

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
  // DATE_RE alone admits impossible calendar dates ("2024-02-30"), which the
  // draft insert then refused with a raw driver error. Fail closed here with
  // the named error, on the real calendar.
  if (!DATE_RE.test(documentDate) || !isIsoCalendarDate(documentDate)) {
    throw new JournalWriteError(`invalid documentDate "${input.documentDate}" (use YYYY-MM-DD)`);
  }

  const amounts: string[] = [];
  const lines = input.lines.map((l, i) => {
    const amount = persistJournalLineAmount(l.amount, i + 1);
    if (isZero(amount)) throw new JournalWriteError(`line ${i + 1}: amount must be a nonzero number`);
    // One shared ledger bound (money.ts MAX_LEDGER_WHOLE_DIGITS): the UI
    // draft refuses the same figures with the same message, so a line that
    // saves in the editor never dies here and vice versa.
    if (!fitsLedgerRange(amount)) {
      throw new JournalWriteError(`line ${i + 1}: amount is out of range — at most 15 whole digits fit the ledger`);
    }
    if (!l.accountId && !l.accountCode) throw new JournalWriteError(`line ${i + 1}: accountId or accountCode required`);
    if (l.accountId && !UUID_RE.test(l.accountId)) throw new JournalWriteError(`line ${i + 1}: invalid accountId`);
    // Dimensions are fail-closed like accountId: a malformed id must never
    // silently post without its dimension. Absent/empty stays null.
    if (l.departmentId && !UUID_RE.test(l.departmentId)) throw new JournalWriteError(`line ${i + 1}: invalid departmentId`);
    if (l.projectId && !UUID_RE.test(l.projectId)) throw new JournalWriteError(`line ${i + 1}: invalid projectId`);
    amounts.push(amount);
    return {
      accountId: l.accountId,
      accountCode: l.accountCode ? String(l.accountCode) : undefined,
      amount,
      description: l.description ? String(l.description).slice(0, 500) : null,
      departmentId: l.departmentId ? l.departmentId : null,
      projectId: l.projectId ? l.projectId : null,
    };
  });
  // Balanced to the 4dp the ledger stores.
  const balance = sum(amounts);
  if (!isZero(balance)) {
    throw new JournalWriteError(`journal is not balanced (debits − credits = ${balance})`);
  }
  // In-range lines can still sum past the stored totalDebits column, which
  // is numeric(19,4) like every other money column: refuse the side totals
  // by name instead of dying in Postgres.
  const { debits: debitTotal, credits: creditTotal } = ledgerSideTotals(amounts);
  if (!fitsLedgerRange(debitTotal)) {
    throw new JournalWriteError(`journal debit total is out of range — at most 15 whole digits fit the ledger`);
  }
  if (!fitsLedgerRange(creditTotal)) {
    throw new JournalWriteError(`journal credit total is out of range — at most 15 whole digits fit the ledger`);
  }
  return {
    documentDate,
    memo: input.memo ? String(input.memo).slice(0, 2000) : null,
    referenceNumber: input.referenceNumber ? String(input.referenceNumber).slice(0, 100) : null,
    lines,
    totalDebits: debitTotal,
  };
}

/**
 * Whether the caller's tenant transaction is already open: withOrgTransaction
 * joins it instead of beginning a new one (same condition as that helper —
 * an ambient pinned txDb for this org). A joined caller owns the transaction,
 * so this write must not re-fence it with SET LOCAL.
 */
function joinsAmbientTenantTransaction(orgId: string): boolean {
  const active = orgContext.getStore();
  return !!active?.txDb && !active.bypass && active.orgId === orgId;
}

/**
 * Bound the current transaction's statements to the script run's remaining
 * budget. Refuses outright when the deadline already passed (a lock held
 * past the deadline must resolve into a refusal, never into a late commit).
 * Transaction-local: the setting dies with the transaction, so a pooled
 * connection can never leak a shortened timeout into later work.
 */
async function fenceTransactionToDeadline(
  executor: Pick<SqlExecutor, "execute">,
  deadlineMs: number,
): Promise<void> {
  if (Date.now() >= deadlineMs) {
    throw new JournalWriteError("journal.create: script run deadline exceeded");
  }
  const remaining = Math.max(1, Math.floor(deadlineMs - Date.now()));
  await executor.execute(sql`select set_config('statement_timeout', ${String(remaining)}, true)`);
}

/**
 * Insert the numbered draft documents row + lines. Runs inside whatever
 * transaction owns the operation: standalone for draft-only requests, or
 * joined into the caller's pinned tenant transaction for post:true (db routes
 * to the transaction connection inside withOrgTransaction).
 *
 * With an idempotencyKey the header insert is ON CONFLICT DO NOTHING on the
 * partial (org_id, idempotency_key) index and a conflicting retry reads back
 * the winner's row. The DO NOTHING is load-bearing dedupe, not a dropped
 * write: a conflict is only possible when this exact script write already
 * committed, and the follow-up SELECT makes that row the returned effect —
 * every conflict is therefore observed, never swallowed.
 */
async function insertScriptDraft(
  orgId: string,
  subsidiaryId: string,
  currency: string,
  v: ReturnType<typeof validateJournalInput>,
  byCode: Map<string, string>,
  actorId: string | null,
  idempotencyKey?: string,
  deadlineMs?: number,
): Promise<{ id: string; documentNumber: string; deduped: boolean }> {
  return db.transaction(async (tx) => {
    // Fence the write to the script run's remaining budget — unless this
    // draft nests inside the caller's own transaction (post:true path, or an
    // ambient tenant unit), which the caller fenced already. SET LOCAL dies
    // with the transaction, so the pool's 120 s bound is restored after.
    if (deadlineMs !== undefined && !joinsAmbientTenantTransaction(orgId)) {
      await fenceTransactionToDeadline(tx, deadlineMs);
    }
    if (idempotencyKey !== undefined) {
      const existing = (await tx.execute<{ id: string; document_number: string }>(sql`
        select id, document_number from documents
         where org_id = ${orgId} and idempotency_key = ${idempotencyKey}`));
      if (existing.rows[0]) {
        return {
          id: String(existing.rows[0].id),
          documentNumber: String(existing.rows[0].document_number),
          deduped: true,
        };
      }
    }
    // JE- sequence via the ONE canonical allocator (engine/src/records/numbering.ts).
    const documentNumber = await allocateDocumentNumber(tx, orgId, "journal", "JE-");

    const ins = (await tx.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, document_number, subsidiary_id, document_date, currency,
                             memo, reference_number, subtotal, tax_total, total, created_by, custom,
                             idempotency_key)
      values (${orgId}, 'journal', ${documentNumber}, ${subsidiaryId}, ${v.documentDate}, ${currency},
              ${v.memo}, ${v.referenceNumber}, ${v.totalDebits}, '0', ${v.totalDebits}, ${actorId},
              ${JSON.stringify(actorId ? {} : SYSTEM_PROVENANCE)}::jsonb, ${idempotencyKey ?? null})
      on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing
      returning id`));
    const won = ins.rows[0];
    if (!won) {
      // A concurrent identical write won the race: return its document rather
      // than a second numbered journal. The conflict above is the proof the
      // row exists — a zero-row read here is a failure, not a success.
      const raced = (await tx.execute<{ id: string; document_number: string }>(sql`
        select id, document_number from documents
         where org_id = ${orgId} and idempotency_key = ${idempotencyKey}`));
      const row = raced.rows[0];
      if (!row) {
        throw new JournalWriteError(
          "journal.create collided on its idempotency key but the winning row is not visible; retry the script run",
        );
      }
      return { id: String(row.id), documentNumber: String(row.document_number), deduped: true };
    }
    const id = String(won.id);

    for (let i = 0; i < v.lines.length; i++) {
      const l = v.lines[i]!;
      const accountId = l.accountId ?? byCode.get(l.accountCode!)!;
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, department_id, project_id, custom)
        values (${orgId}, ${id}, ${i + 1}, ${accountId}, ${l.description},
                '1', ${l.amount}, ${l.amount}, ${l.departmentId}, ${l.projectId}, '{}')`);
    }
    const num = (await tx.execute<{ document_number: string }>(sql`select document_number from documents where id = ${id} and org_id = ${orgId}`));
    return { id, documentNumber: String(num.rows[0]!.document_number), deduped: false };
  });
}

type ResolvedJournalSubsidiary = { subsidiaryId: string; baseCurrency: string };

/**
 * Select the legal entity a sandbox journal is written into, under the
 * caller's subsidiary scope — the same decision table as the HTTP draft route
 * (web/app/api/journals/draft/route.ts + web/lib/journals.ts):
 *   - explicit id: must be a UUID, inside the scope (else "not found", so an
 *     out-of-scope entity is indistinguishable from a missing one), and an
 *     active non-elimination entity of this org;
 *   - no id, unrestricted: the root;
 *   - no id, restricted: exactly one active allowed entity auto-selects; an
 *     empty scope or several entities are refused rather than guessed.
 * Sandboxed code previously always resolved the ROOT regardless of the
 * caller's scope, letting a restricted principal post into an entity it may
 * not even see.
 */
async function resolveScriptJournalSubsidiary(
  orgId: string,
  actorId: string | null,
  requested: string | null | undefined,
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
): Promise<ResolvedJournalSubsidiary> {
  const resolvedScope = allowedSubsidiaryIds === undefined
    ? actorId ? await actorAllowedSubsidiaryIds(db, orgId, actorId) : null
    : allowedSubsidiaryIds;
  const scope = resolvedScope === null
    ? null
    : new Set([...resolvedScope].map((id) => id.toLowerCase()));

  const pick = (row: { id: string; base_currency: string | null }): ResolvedJournalSubsidiary => {
    if (!row.base_currency) {
      throw new JournalWriteError("subsidiary has no configured functional currency");
    }
    return { subsidiaryId: row.id, baseCurrency: row.base_currency };
  };

  if (requested !== undefined && requested !== null) {
    if (typeof requested !== "string" || !UUID_RE.test(requested)) {
      throw new JournalWriteError("invalid subsidiary", "invalid_subsidiary");
    }
    const normalized = requested.toLowerCase();
    if (scope !== null && !scope.has(normalized)) {
      throw new JournalWriteError("subsidiary not found", "subsidiary_not_allowed");
    }
    const explicit = (await db.execute<{ id: string; base_currency: string | null }>(sql`
      select id, nullif(trim(base_currency), '') as base_currency
        from subsidiaries
       where org_id = ${orgId} and id = ${normalized}
         and is_active and not is_elimination`)).rows[0];
    if (!explicit) throw new JournalWriteError("invalid subsidiary", "invalid_subsidiary");
    return pick(explicit);
  }

  if (scope !== null) {
    const ids = [...scope].filter((id) => UUID_RE.test(id));
    if (ids.length === 0) {
      throw new JournalWriteError("no available subsidiary", "no_available_subsidiary");
    }
    const allowed = (await db.execute<{ id: string; base_currency: string | null }>(sql`
      select id, nullif(trim(base_currency), '') as base_currency
        from subsidiaries
       where org_id = ${orgId} and is_active and not is_elimination
         and id in ${ids}`)).rows;
    if (allowed.length === 0) {
      throw new JournalWriteError("no available subsidiary", "no_available_subsidiary");
    }
    if (allowed.length !== 1) {
      throw new JournalWriteError(
        "a subsidiaryId must be selected when more than one legal entity is available",
        "ambiguous_subsidiary_scope",
      );
    }
    return pick(allowed[0]!);
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
  `))).rows[0] as { subsidiary_id: string | null; base_currency: string | null } | undefined;
  if (!company) throw new JournalWriteError("organization does not exist");
  if (!company.subsidiary_id) {
    throw new JournalWriteError("organization has no active root subsidiary");
  }
  if (!company.base_currency) {
    throw new JournalWriteError("root subsidiary has no configured functional currency");
  }
  return { subsidiaryId: company.subsidiary_id, baseCurrency: company.base_currency };
}

/**
 * Create a balanced draft journal from sandboxed code, optionally posting it.
 * Account codes resolve within the org; unknown/inactive accounts are refused.
 * post=true runs the real posting engine — every invariant it enforces
 * (closed period, balance kernel) applies unchanged — inside ONE transaction
 * with the draft, so a refused post leaves zero documents and lines behind.
 * A null actor (scheduled/bulk script) posts under explicit system provenance;
 * an interactive actor is retained on created_by and every evidence row.
 */
/**
 * Read back the document a previous identical script write committed, so a
 * retry observes the first execution's outcome instead of posting a second
 * numbered journal. The key row exists only if its whole unit committed, so
 * the live status/posted entry is the truthful result to return: a posted
 * retry reports its entry, an approval-gated one reports pending, anything
 * else reports the draft pointer.
 */
async function findScriptJournalByKey(
  orgId: string,
  idempotencyKey: string,
): Promise<ScriptJournalResult | null> {
  const r = (await db.execute<{ id: string; document_number: string; status: string; posted_entry_id: string | null }>(sql`
    select id, document_number, status, posted_entry_id from documents
     where org_id = ${orgId} and idempotency_key = ${idempotencyKey}`));
  const row = r.rows[0];
  if (!row) return null;
  const base = { id: String(row.id), documentNumber: String(row.document_number) };
  if (row.posted_entry_id) return { ...base, entryId: String(row.posted_entry_id) };
  if (row.status === "pending_approval") return { ...base, approvalPending: true };
  return base;
}

export async function createScriptJournal(
  orgId: string,
  actorId: string | null,
  input: ScriptJournalInput,
  opts: CreateScriptJournalOptions = {},
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
       where org_id = ${orgId} and is_active = true and is_summary = false and number in ${codes}`));
    for (const row of r.rows) byCode.set(String(row.number), String(row.id));
    for (const c of codes) if (!byCode.has(c)) throw new JournalWriteError(`unknown, inactive, or summary account code "${c}"`);
  }
  if (ids.length) {
    const r = (await db.execute(sql`
      select id from accounts where org_id = ${orgId} and is_active = true and is_summary = false and id in ${ids}`));
    const found = new Set(r.rows.map((x) => String(x.id)));
    for (const id of ids) if (!found.has(id)) throw new JournalWriteError(`unknown, inactive, or summary accountId "${id}"`);
  }

  // Line dimensions are fail-closed like accountId: the validator proves shape
  // only, so a well-formed id from another tenant would die at the composite
  // FK as an unhandled storage error. Prove org ownership here instead, with
  // a tenant-opaque refusal that reveals nothing about other tenants' charts.
  for (const [key, label, table] of [["departmentId", "department", "departments"], ["projectId", "project", "projects"]] as const) {
    const refIds = [...new Set(v.lines.map((l) => l[key]).filter((x): x is string => typeof x === "string" && x.length > 0))];
    if (refIds.length === 0) continue;
    const r = (await db.execute(sql`
      select id from ${sql.raw(`"${table}"`)} where org_id = ${orgId} and id in ${refIds}`));
    const found = new Set(r.rows.map((x) => String(x.id)));
    const foreign = refIds.find((x) => !found.has(x));
    if (foreign !== undefined) {
      const lineNumber = v.lines.findIndex((l) => l[key] === foreign) + 1;
      throw new JournalWriteError(`line ${lineNumber}: ${label} not found in this organization`);
    }
  }

  // The deadline fence starts before any write: a run that already exceeded
  // its budget must not begin a journal it can no longer report truthfully.
  // (The host also checks this before invoking, but createScriptJournal is a
  // public boundary — App backends and future callers get the same refusal.)
  if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
    throw new JournalWriteError("journal.create: script run deadline exceeded");
  }

  const { subsidiaryId, baseCurrency } = await resolveScriptJournalSubsidiary(
    orgId,
    actorId,
    input.subsidiaryId,
    opts.allowedSubsidiaryIds,
  );

  // A retry presenting an already-committed key observes the first
  // execution's document instead of posting a second numbered journal. The
  // row exists only if its whole unit committed (draft-only or post), so its
  // current status is the truthful outcome to return.
  if (opts.idempotencyKey !== undefined) {
    const prior = await findScriptJournalByKey(orgId, opts.idempotencyKey);
    if (prior) return prior;
  }

  if (!opts.post) {
    // A committed draft IS the documented successful outcome of a draft-only
    // request; it stands alone in its own transaction.
    const { deduped: _deduped, ...draft } = await insertScriptDraft(
      orgId, subsidiaryId, baseCurrency, v, byCode, actorId, opts.idempotencyKey, opts.deadlineMs,
    );
    return draft;
  }

  // post:true is ONE atomic unit: the numbered draft, its approval submission,
  // and the ledger entry commit together or not at all. Committing the draft
  // first made every later failure (missing actor, refused submission, closed
  // period) leave a hidden orphan journal behind. An actor-less scheduled
  // script now posts under explicit system provenance instead of being
  // refused only after its draft had already been committed.
  const owned = !joinsAmbientTenantTransaction(orgId);
  type PostOutcome =
    | { approvalPending: true; docId: ScriptJournalResult }
    | { approvalPending: false; entryId: unknown; docId: ScriptJournalResult }
    | { deduped: true; live: ScriptJournalResult };
  const outcome: PostOutcome = await withOrgTransaction(orgId, async (): Promise<PostOutcome> => {
    // Fence the whole post unit (draft + submission + entry) to the run's
    // remaining budget when this call owns the transaction. A joined ambient
    // unit belongs to its outer flow and must not be re-fenced from here.
    if (owned && opts.deadlineMs !== undefined) {
      await fenceTransactionToDeadline(db, opts.deadlineMs);
    }
    const docId = await insertScriptDraft(orgId, subsidiaryId, baseCurrency, v, byCode, actorId, opts.idempotencyKey, opts.deadlineMs);
    // A deduped draft is another execution's committed unit: re-submitting
    // or re-posting it here would double-apply the first run's document.
    // Return its live outcome; the pre-unit read usually catches this first
    // and this branch covers the commit that landed between that read and
    // this insert.
    if (docId.deduped) {
      const live = await findScriptJournalByKey(orgId, opts.idempotencyKey!);
      if (!live) {
        throw new JournalWriteError(
          "journal.create collided on its idempotency key but the winning row is not visible; retry the script run",
        );
      }
      // The live row carries its own entry/pending mapping; resubmitting it
      // here would double-apply the first run's document.
      return { deduped: true as const, live };
    }
    const submission = await submitAndReleaseIfUngated(
      "journal",
      docId.id,
      // A null submitter is a system submission. The flow engine retains null
      // rather than inventing an identity, and any submitter-based approval
      // target resolves empty so the submission fails closed.
      actorId,
    );
    if (submission.flowError) {
      throw new JournalWriteError(`approval could not be routed: ${submission.flowError}`);
    }
    if (submission.gated) return { approvalPending: true as const, docId };
    const entryId = await postDocument(
      docId.id,
      { control: await loadRequiredControlAccounts(orgId) },
      { deferEffects: true, audit: { actorId, source: "script" } },
    );
    return { approvalPending: false as const, entryId, docId };
  });
  if ("deduped" in outcome) return outcome.live;
  if (outcome.approvalPending) return { ...outcome.docId, approvalPending: true };
  // Effects fire after the atomic commit: after_post automation may itself
  // post journals and must never nest inside this unit. The posting
  // transaction already queued the effects outbox row, so a crash between
  // commit and here leaves a durable retry for runPostDocumentEffects rather
  // than lost or duplicated work — a rerun claims the same row once.
  await runPostDocumentEffects(outcome.docId.id, "draft", { actorId });
  return { ...outcome.docId, entryId: String(outcome.entryId) };
}

/** Drizzle schema re-export so callers can typecheck against documents. */
export { schema };
