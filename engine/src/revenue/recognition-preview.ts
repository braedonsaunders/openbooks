/** Read-only recognition preview with confirm fingerprint. Split from revenue/recognition.ts (ARCH-FILE-SPLIT; pure moves only). */
import { createHash } from "node:crypto";
import { canonicalJson } from "../platform/canonical-json.ts";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { arePeriodModulesOpen } from "../periods/period-policy.ts";
import { defaultPostingSubsidiaryId, loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { add, cmp, isZero } from "../money/money.ts";
import type { RecognitionMethod } from "./recognition-schedule.ts";
import { recognitionDate } from "./recognition-dates.ts";
import { assertEnabled, recognitionBaseAmount } from "./recognition-transaction-price.ts";
import { recognitionNetRecognized, recognitionPostingRows, recognitionUnearnedRemaining, type FingerprintedRecognitionLine } from "./recognition-posting-rows.ts";

/* ------------------------------------------------------------------ *
 * Review-and-confirm: the read-only preview behind the Run recognition
 * drawer, and the fingerprint Confirm carries back.
 * ------------------------------------------------------------------ */

export interface RecognitionPreviewInput {
  asOfDate: string;
  /** One obligation, as the contract drawer's per-obligation run does. */
  obligationId?: string;
  /** Every obligation on one contract. */
  contractId?: string;
  /** One accounting book; omitted means every GL-posting book. */
  bookId?: string;
  /** One accounting period. */
  periodId?: string;
  allowedSubsidiaryIds?: string[];
}

/**
 * Why a previewed line would NOT post. Named here rather than discovered at
 * post time: the operator decides before anything is written.
 *
 * - `period_closed`   the GL period is locked for this book/entity
 * - `not_configured`  no deferred or no recognized account resolves
 * - `credit_capped`   a credit memo already relieved the whole remainder
 * - `negative_floor`  a correction would drive cumulative earned negative
 * - `zero`            a zero plan line: closed out, never posted
 */
export type RecognitionSkipReason =
  | "period_closed"
  | "not_configured"
  | "credit_capped"
  | "negative_floor"
  | "zero";

export interface RecognitionPreviewRow extends FingerprintedRecognitionLine {
  obligationId: string;
  obligationDescription: string;
  contractNumber: string;
  periodName: string;
  periodEndsOn: string;
  recognitionOn: string | null;
  method: RecognitionMethod;
  bookName: string;
  subsidiaryName: string | null;
  departmentName: string | null;
  projectName: string | null;
  /** The plan line before the unearned cap; differs from `amount` when a
   *  credit memo already relieved part of the remainder. */
  plannedAmount: string;
  /** Transaction currency and the rate the posting converts at. */
  currency: string | null;
  baseCurrency: string | null;
  fxRate: string;
  debitAccountNumber: string | null;
  debitAccountName: string | null;
  creditAccountNumber: string | null;
  creditAccountName: string | null;
  /** Null when this line posts. Otherwise the named refusal above. */
  skipReason: RecognitionSkipReason | null;
  /** Operator-readable detail behind `skipReason` (amounts, period name). */
  skipDetail: string | null;
}

export interface RecognitionPreview {
  asOfDate: string;
  obligationId: string | null;
  contractId: string | null;
  bookId: string | null;
  periodId: string | null;
  /** Every due line in scope, postable and skipped alike — the operator sees
   *  what will NOT post as clearly as what will. */
  rows: RecognitionPreviewRow[];
  postableCount: number;
  skippedCount: number;
  totalAmount: string;
  totalDebits: string;
  totalCredits: string;
  balanced: boolean;
  /**
   * Fixed-price project contracts whose percent-complete measurement is
   * refreshed before a run posts. Confirm performs that refresh, so the
   * preview names it instead of letting it happen invisibly.
   */
  projectSyncPending: boolean;
  warnings: string[];
  /**
   * Stale-input fence: sha256 over the scope plus every previewed line id,
   * amount, period, book, account, entity and dimension. Confirm recomputes
   * over current state and refuses on mismatch.
   */
  fingerprint: string;
}

/**
 * Fingerprint the exact confirmable set: the scope AND every postable line's
 * amount, period, book, accounts, entity and dimensions. Skipped lines are
 * excluded — they write nothing, and a skip that later clears simply means a
 * fresh preview shows more to post.
 */
export function recognitionPreviewFingerprint(
  orgId: string,
  input: RecognitionPreviewInput,
  rows: FingerprintedRecognitionLine[],
): string {
  const normalized = {
    orgId,
    asOfDate: input.asOfDate,
    obligationId: input.obligationId ?? null,
    contractId: input.contractId ?? null,
    bookId: input.bookId ?? null,
    periodId: input.periodId ?? null,
    rows: [...rows]
      .sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0))
      .map((row) => ({
        lineId: row.lineId,
        amount: row.amount,
        periodId: row.periodId,
        bookId: row.bookId,
        debitAccountId: row.debitAccountId,
        creditAccountId: row.creditAccountId,
        subsidiaryId: row.subsidiaryId,
        departmentId: row.departmentId,
        projectId: row.projectId,
        locationId: row.locationId,
      })),
  };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

/** Names for the ids a preview row carries, resolved in one pass. */
async function recognitionPreviewNames(
  runner: SqlExecutor,
  orgId: string,
  ids: {
    accountIds: string[];
    bookIds: string[];
    subsidiaryIds: string[];
    departmentIds: string[];
    projectIds: string[];
  },
): Promise<{
  accounts: Map<string, { number: string | null; name: string | null }>;
  books: Map<string, string>;
  subsidiaries: Map<string, string>;
  departments: Map<string, string>;
  projects: Map<string, string>;
}> {
  const list = (values: string[]) => `{${[...new Set(values)].join(",")}}`;
  const accounts = new Map<string, { number: string | null; name: string | null }>();
  const books = new Map<string, string>();
  const subsidiaries = new Map<string, string>();
  const departments = new Map<string, string>();
  const projects = new Map<string, string>();
  if (ids.accountIds.length > 0) {
    for (const row of (await runner.execute<{ id: string; number: string | null; name: string | null }>(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and id = any(${list(ids.accountIds)}::uuid[])`)).rows) {
      accounts.set(String(row.id), { number: row.number, name: row.name });
    }
  }
  if (ids.bookIds.length > 0) {
    for (const row of (await runner.execute<{ id: string; name: string }>(sql`
      select id, name from accounting_books
       where org_id = ${orgId} and id = any(${list(ids.bookIds)}::uuid[])`)).rows) {
      books.set(String(row.id), row.name);
    }
  }
  if (ids.subsidiaryIds.length > 0) {
    for (const row of (await runner.execute<{ id: string; name: string }>(sql`
      select id, name from subsidiaries
       where org_id = ${orgId} and id = any(${list(ids.subsidiaryIds)}::uuid[])`)).rows) {
      subsidiaries.set(String(row.id), row.name);
    }
  }
  if (ids.departmentIds.length > 0) {
    for (const row of (await runner.execute<{ id: string; name: string }>(sql`
      select id, name from departments
       where org_id = ${orgId} and id = any(${list(ids.departmentIds)}::uuid[])`)).rows) {
      departments.set(String(row.id), row.name);
    }
  }
  if (ids.projectIds.length > 0) {
    for (const row of (await runner.execute<{ id: string; name: string }>(sql`
      select id, name from projects
       where org_id = ${orgId} and id = any(${list(ids.projectIds)}::uuid[])`)).rows) {
      projects.set(String(row.id), row.name);
    }
  }
  return { accounts, books, subsidiaries, departments, projects };
}
/**
 * Read-only revenue-recognition preview for the review/confirm drawer: the
 * exact balanced accounting impact of confirming this scope — one DR
 * deferred / CR recognized pair per due line — plus the fingerprint Confirm
 * must carry back.
 *
 * Pure SELECTs: no locks, no claims, no postings, and no project
 * re-measurement. Every refusal the run would reach (closed period, missing
 * accounts, credit-exhausted remainder, negative floor) is evaluated HERE and
 * shown per line, so the operator never learns about a skip from a toast
 * after the fact.
 */
export async function previewRevenueRecognition(
  orgId: string,
  input: RecognitionPreviewInput,
): Promise<RecognitionPreview> {
  recognitionDate(input.asOfDate, "recognition as-of date");
  await assertEnabled(db, orgId);
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));

  const due = await recognitionPostingRows(
    db,
    orgId,
    input.asOfDate,
    fallbackSubsidiaryId,
    input.obligationId,
    input.allowedSubsidiaryIds,
  );

  // Contract and book/period narrowing ride on top of the one due-rows
  // reader, so the preview can never see a line the run would not.
  const contractLineIds = input.contractId
    ? new Set(
        (await db.execute<{ id: string }>(sql`
          select l.id from recognition_schedule_lines l
           join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
           join performance_obligations o on o.id = s.obligation_id and o.org_id = s.org_id
           where l.org_id = ${orgId} and o.contract_id = ${input.contractId}`)).rows.map((row) =>
          String(row.id),
        ),
      )
    : null;

  const scoped = due.filter((row) => {
    if (input.bookId && row.book_id !== input.bookId) return false;
    if (input.periodId && row.period_id !== input.periodId) return false;
    if (contractLineIds && !contractLineIds.has(row.line_id)) return false;
    return true;
  });

  const names = await recognitionPreviewNames(db, orgId, {
    accountIds: scoped.flatMap((row) =>
      [
        row.obl_deferred ?? row.item_deferred ?? row.rule_deferred,
        row.obl_recognized ?? row.rule_recognized ?? row.item_income,
      ].filter((id): id is string => Boolean(id)),
    ),
    bookIds: scoped.map((row) => row.book_id),
    subsidiaryIds: scoped.map((row) => row.subsidiary_id).filter((id): id is string => Boolean(id)),
    departmentIds: scoped.map((row) => row.department_id).filter((id): id is string => Boolean(id)),
    projectIds: scoped.map((row) => row.project_id).filter((id): id is string => Boolean(id)),
  });

  const rows: RecognitionPreviewRow[] = [];
  const warnings: string[] = [];
  let totalAmount = "0";

  for (const row of scoped) {
    const deferredAccountId = row.obl_deferred ?? row.item_deferred ?? row.rule_deferred;
    const recognizedAccountId = row.obl_recognized ?? row.rule_recognized ?? row.item_income;
    const debit = deferredAccountId ? names.accounts.get(deferredAccountId) : undefined;
    const credit = recognizedAccountId ? names.accounts.get(recognizedAccountId) : undefined;

    let skipReason: RecognitionSkipReason | null = null;
    let skipDetail: string | null = null;
    let amount = row.planned;

    if (isZero(row.planned)) {
      skipReason = "zero";
      skipDetail = null;
      amount = "0";
    } else if (!deferredAccountId || !recognizedAccountId) {
      skipReason = "not_configured";
      skipDetail = !deferredAccountId
        ? "no deferred revenue account resolves for this obligation"
        : "no recognized revenue account resolves for this obligation";
      amount = "0";
    } else if (
      !(await arePeriodModulesOpen(db, {
        orgId,
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryIds: row.subsidiary_id ? [row.subsidiary_id] : [],
        modules: ["gl"],
      }))
    ) {
      skipReason = "period_closed";
      skipDetail = row.period_name;
      amount = "0";
    } else if (cmp(row.planned, "0") > 0) {
      // The same unearned ceiling the run applies (F-w5-001), read-only.
      const cap = await recognitionUnearnedRemaining(db, {
        orgId,
        obligationId: row.obligation_id,
        bookId: row.book_id,
        deferredAccountId,
      });
      if (cmp(cap.remaining, "0") <= 0) {
        skipReason = "credit_capped";
        skipDetail = cap.credited;
        amount = "0";
      } else if (cmp(row.planned, cap.remaining) > 0) {
        amount = cap.remaining;
      }
    } else {
      const net = await recognitionNetRecognized(db, {
        orgId,
        obligationId: row.obligation_id,
        bookId: row.book_id,
      });
      if (cmp(add(net, row.planned), "0") < 0) {
        skipReason = "negative_floor";
        skipDetail = net;
        amount = "0";
      }
    }

    if (skipReason === null) totalAmount = add(totalAmount, recognitionBaseAmount(amount, row.recognition_fx_rate));

    rows.push({
      lineId: row.line_id,
      amount,
      periodId: row.period_id,
      bookId: row.book_id,
      debitAccountId: deferredAccountId,
      creditAccountId: recognizedAccountId,
      subsidiaryId: row.subsidiary_id,
      departmentId: row.department_id,
      projectId: row.project_id,
      locationId: row.location_id,
      obligationId: row.obligation_id,
      obligationDescription: row.obligation_desc,
      contractNumber: row.contract_number,
      periodName: row.period_name,
      periodEndsOn: row.period_ends_on,
      recognitionOn: row.recognition_on,
      method: row.method,
      bookName: names.books.get(row.book_id) ?? row.book_id,
      subsidiaryName: row.subsidiary_id ? names.subsidiaries.get(row.subsidiary_id) ?? null : null,
      departmentName: row.department_id ? names.departments.get(row.department_id) ?? null : null,
      projectName: row.project_id ? names.projects.get(row.project_id) ?? null : null,
      plannedAmount: row.planned,
      currency: row.recognition_currency ?? row.base_currency,
      baseCurrency: row.base_currency,
      fxRate: row.recognition_fx_rate,
      debitAccountNumber: debit?.number ?? null,
      debitAccountName: debit?.name ?? null,
      creditAccountNumber: credit?.number ?? null,
      creditAccountName: credit?.name ?? null,
      skipReason,
      skipDetail,
    });
  }

  const postable = rows.filter((row) => row.skipReason === null);
  if (rows.length > postable.length) {
    warnings.push(`${rows.length - postable.length} due line(s) will not post`);
  }

  // Percent-complete obligations are re-measured by Confirm before it posts.
  // Say so here: the refresh can add catch-up lines this preview cannot show.
  const projectSyncPending = scoped.some((row) => row.method === "percent_complete");
  if (projectSyncPending) {
    warnings.push(
      "percent-complete progress is re-measured on confirm; newly projected catch-up lines wait for the next run",
    );
  }

  return {
    asOfDate: input.asOfDate,
    obligationId: input.obligationId ?? null,
    contractId: input.contractId ?? null,
    bookId: input.bookId ?? null,
    periodId: input.periodId ?? null,
    rows,
    postableCount: postable.length,
    skippedCount: rows.length - postable.length,
    totalAmount,
    // One balanced pair per line: the debit total is the credit total by
    // construction, and the badge states it rather than assuming it.
    totalDebits: totalAmount,
    totalCredits: totalAmount,
    balanced: true,
    projectSyncPending,
    warnings,
    fingerprint: recognitionPreviewFingerprint(orgId, input, postable),
  };
}
