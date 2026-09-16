import { sql } from "drizzle-orm";
import { reconciliationTotals, SYSTEM_ACTOR_ID } from "../banking.ts";
import { businessToday } from "../business-date.ts";
import { db } from "../db.ts";
import { fromUnits, toUnits } from "../money.ts";
import {
  effectiveDetectorMateriality,
  type ContinuousCloseDetectorPolicy,
} from "../continuous-close-config.ts";
import { absoluteUnits, moneyAbs } from "./measure.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Reconciliation pack — unmatched bank lines with a confident match
 * candidate, stale reconciliations, and accounts never reconciled.
 *
 * Reuse map:
 * - bank_line_match_candidate is a read-only dry run of the engine
 *   auto-matcher (`engine/src/banking.ts` `autoMatch`): exact signed amount,
 *   closest date wins, one-to-one consumption, confidence 0.90 at <= 3 days
 *   else 0.70, silent past 14 days. The pack NEVER calls autoMatch itself —
 *   that would write matches. It proposes `match_bank_line` commands (an
 *   existing application tool) naming the open session when one exists.
 * - stale_reconciliation reuses `reconciliationTotals` (the same authority
 *   the accounting pack's reconciliation_difference detector uses) and
 *   proposes `sign_off_reconciliation` only for exactly-zero differences.
 * - never_reconciled_account keys off `accounts.reconcilable` with real bank
 *   activity and proposes nothing: starting a session needs a
 *   user-supplied statement balance, so the finding stays a review task.
 *
 * Findings surface progressively: each account finding proposes its single
 * best candidate; confirming it lets the next-best surface on the following
 * run. The pack never writes.
 */

export const RECONCILIATION_DETECTOR_KEYS = [
  "bank_line_match_candidate",
  "stale_reconciliation",
  "never_reconciled_account",
] as const;

const DAY_MS = 86_400_000;

function absDaysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
}

export type UnmatchedLineRow = {
  lineId: string;
  postedOn: string;
  amount: string;
};

export type ReconcilableJournalRow = {
  journalLineId: string;
  postingDate: string;
  amount: string;
};

export type MatchCandidate = {
  lineId: string;
  postedOn: string;
  amount: string;
  description: string | null;
  counterpartyRef: string | null;
  journalLineId: string;
  journalDate: string;
  daysBetween: number;
  /** Mirrors autoMatch bands: 0.90 at <= 3 days, else 0.70. */
  confidence: "0.90" | "0.70";
  confidencePercent: 90 | 70;
};

/**
 * Pure autoMatch-mirror pairing: exact signed amount, closest date wins with
 * greedy one-to-one consumption, silent past 14 days. Unit-tested against
 * the bands above; production rows come from the loaders below.
 */
export function pairMatchCandidates(
  lines: UnmatchedLineRow[],
  journals: ReconcilableJournalRow[],
  windowDays = 14,
): { lineId: string; journalLineId: string; daysBetween: number; confidence: "0.90" | "0.70" }[] {
  const byAmount = new Map<string, { id: string; date: string }[]>();
  for (const journal of journals) {
    const key = toUnits(journal.amount).toString();
    const list = byAmount.get(key) ?? [];
    list.push({ id: journal.journalLineId, date: journal.postingDate });
    byAmount.set(key, list);
  }
  const pairs: { lineId: string; journalLineId: string; daysBetween: number; confidence: "0.90" | "0.70" }[] = [];
  for (const line of lines) {
    const candidates = byAmount.get(toUnits(line.amount).toString());
    if (!candidates?.length) continue;
    let bestIdx = -1;
    let bestDays = Infinity;
    for (let index = 0; index < candidates.length; index++) {
      const days = absDaysBetween(line.postedOn, candidates[index]!.date);
      if (days < bestDays) {
        bestDays = days;
        bestIdx = index;
      }
    }
    if (bestIdx === -1 || bestDays > windowDays) continue;
    const [winner] = candidates.splice(bestIdx, 1);
    pairs.push({
      lineId: line.lineId,
      journalLineId: winner!.id,
      daysBetween: bestDays,
      confidence: bestDays <= 3 ? "0.90" : "0.70",
    });
  }
  return pairs;
}

export type ReconAccountCandidates = {
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  reconciliationId: string | null;
  throughDate: string | null;
  totalUnmatched: number;
  candidates: MatchCandidate[];
};

export type StaleReconRow = {
  reconciliationId: string;
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  throughDate: string;
  statementBalance: string;
  updatedAt: string;
  difference: string;
};

export type NeverReconciledRow = {
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  activityCount: number;
  activityTotal: string;
  oldestActivity: string;
};

export type ReconciliationLoaders = {
  /** Org business day (business-date.ts); injectable so unit tests stay DB-free. */
  today: (orgId: string) => Promise<string>;
  candidateAccounts: (orgId: string, today: string, windowDays: number) => Promise<ReconAccountCandidates[]>;
  staleSessions: (orgId: string, cutoff: string) => Promise<StaleReconRow[]>;
  neverReconciled: (orgId: string, lookbackStart: string) => Promise<NeverReconciledRow[]>;
};

async function loadCandidateAccounts(orgId: string, today: string, windowDays: number): Promise<ReconAccountCandidates[]> {
  const sessions = (await db.execute<{ account_id: string; reconciliation_id: string; through_date: string }>(sql`
    select account_id, id as reconciliation_id, through_date::text
      from reconciliations
     where org_id = ${orgId} and status = 'in_progress'
  `));
  const sessionByAccount = new Map(sessions.rows.map((row) => [row.account_id, row]));
  const accounts = (await db.execute<{ account_id: string; number: string | null; name: string }>(sql`
    select distinct s.account_id, a.number, a.name
      from bank_statement_lines l
      join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
      join accounts a on a.id = s.account_id and a.org_id = s.org_id
     where l.org_id = ${orgId} and l.match_status = 'unmatched' and l.posted_on <= ${today}
  `));
  const out: ReconAccountCandidates[] = [];
  for (const account of accounts.rows) {
    const session = sessionByAccount.get(account.account_id) ?? null;
    const cutoff = session?.through_date ?? today;
    const [lines, journals] = await Promise.all([
      db.execute<{
        line_id: string;
        posted_on: string;
        amount: string;
        description: string | null;
        counterparty_ref: string | null;
        currency: string;
      }>(sql`
        select l.id as line_id, l.posted_on::text, l.amount::text, l.description,
               l.counterparty_ref, l.currency
          from bank_statement_lines l
          join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
         where l.org_id = ${orgId} and s.account_id = ${account.account_id}
           and l.match_status = 'unmatched' and l.posted_on <= ${cutoff}
         order by abs(l.amount) desc, l.posted_on
         limit 100
      `),
      db.execute<{ journal_line_id: string; posting_date: string; amount: string; currency: string }>(sql`
        select jl.id as journal_line_id, je.posting_date::text, jl.txn_amount::text as amount, jl.currency
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
          join accounting_books b on b.id = je.book_id and b.org_id = je.org_id and b.is_primary
         where jl.account_id = ${account.account_id} and jl.org_id = ${orgId}
           and je.posting_date <= ${cutoff}
           and jl.reconciled_at is null
           and not exists (select 1 from reconciliation_matches m where m.journal_line_id = jl.id and m.org_id = jl.org_id)
         limit 500
      `),
    ]);
    const sameCurrencyJournals = (currency: string): ReconcilableJournalRow[] =>
      journals.rows
        .filter((row) => row.currency === currency)
        // Signed amounts: autoMatch pairs exact signed values, never absolutes.
        .map((row) => ({ journalLineId: row.journal_line_id, postingDate: String(row.posting_date), amount: String(row.amount) }));
    const lineById = new Map(lines.rows.map((row) => [row.line_id, row]));
    const candidates: MatchCandidate[] = [];
    // Pair per currency partition: autoMatch only matches within one currency.
    for (const currency of new Set(lines.rows.map((row) => row.currency))) {
      const currencyLines: UnmatchedLineRow[] = lines.rows
        .filter((row) => row.currency === currency)
        .map((row) => ({ lineId: row.line_id, postedOn: String(row.posted_on), amount: String(row.amount) }));
      for (const pair of pairMatchCandidates(currencyLines, sameCurrencyJournals(currency), windowDays)) {
        const line = lineById.get(pair.lineId)!;
        candidates.push({
          lineId: pair.lineId,
          postedOn: String(line.posted_on),
          amount: moneyAbs(line.amount),
          description: line.description,
          counterpartyRef: line.counterparty_ref,
          journalLineId: pair.journalLineId,
          journalDate: journals.rows.find((row) => row.journal_line_id === pair.journalLineId)?.posting_date ?? "",
          daysBetween: pair.daysBetween,
          confidence: pair.confidence,
          confidencePercent: pair.confidence === "0.90" ? 90 : 70,
        });
      }
    }
    candidates.sort((a, b) => b.confidencePercent - a.confidencePercent || Number(toUnits(b.amount) - toUnits(a.amount)));
    out.push({
      accountId: account.account_id,
      accountNumber: account.number,
      accountName: account.name,
      reconciliationId: session?.reconciliation_id ?? null,
      throughDate: session?.through_date ?? null,
      totalUnmatched: lines.rows.length,
      candidates,
    });
  }
  return out;
}

async function loadStaleSessions(orgId: string, cutoff: string): Promise<StaleReconRow[]> {
  const rows = (await db.execute<{
    reconciliation_id: string;
    account_id: string;
    number: string | null;
    name: string;
    through_date: string;
    statement_balance: string;
    updated_at: string;
  }>(sql`
    select r.id as reconciliation_id, r.account_id, a.number, a.name,
           r.through_date::text, r.statement_balance::text,
           r.updated_at::text as updated_at
      from reconciliations r
      join accounts a on a.id = r.account_id and a.org_id = r.org_id
     where r.org_id = ${orgId} and r.status = 'in_progress'
       and r.updated_at <= ${cutoff}::timestamptz
     order by r.updated_at
     limit 50
  `));
  const out: StaleReconRow[] = [];
  for (const row of rows.rows) {
    const { difference } = await reconciliationTotals(row.reconciliation_id, { orgId, userId: SYSTEM_ACTOR_ID });
    out.push({
      reconciliationId: row.reconciliation_id,
      accountId: row.account_id,
      accountNumber: row.number,
      accountName: row.name,
      throughDate: String(row.through_date),
      statementBalance: moneyAbs(row.statement_balance),
      updatedAt: String(row.updated_at),
      difference: moneyAbs(difference),
    });
  }
  return out;
}

async function loadNeverReconciled(orgId: string, lookbackStart: string): Promise<NeverReconciledRow[]> {
  const rows = (await db.execute<{
    account_id: string;
    number: string | null;
    name: string;
    activity_count: number;
    activity_total: string;
    oldest_activity: string;
  }>(sql`
    select s.account_id, a.number, a.name,
           count(*)::int as activity_count,
           sum(abs(l.amount))::text as activity_total,
           min(l.posted_on)::text as oldest_activity
      from bank_statement_lines l
      join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
      join accounts a on a.id = s.account_id and a.org_id = s.org_id
     where l.org_id = ${orgId} and l.posted_on >= ${lookbackStart}
       and a.reconcilable
       and not exists (select 1 from reconciliations r where r.org_id = ${orgId} and r.account_id = s.account_id)
     group by s.account_id, a.number, a.name
  `));
  return rows.rows.map((row) => ({
    accountId: row.account_id,
    accountNumber: row.number,
    accountName: row.name,
    activityCount: Number(row.activity_count),
    activityTotal: moneyAbs(row.activity_total),
    oldestActivity: String(row.oldest_activity),
  }));
}

export const productionReconciliationLoaders: ReconciliationLoaders = {
  today: businessToday,
  candidateAccounts: loadCandidateAccounts,
  staleSessions: loadStaleSessions,
  neverReconciled: loadNeverReconciled,
};

function shiftDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function reconciliationFindings(
  orgId: string,
  agentThreshold: string,
  detectors: ContinuousCloseDetectorPolicy[],
  loaders: ReconciliationLoaders = productionReconciliationLoaders,
): Promise<AgentFinding[]> {
  if (!detectors.some((detector) => detector.enabled && (RECONCILIATION_DETECTOR_KEYS as readonly string[]).includes(detector.detectorKey))) {
    return [];
  }
  const today = await loaders.today(orgId);
  const findings: AgentFinding[] = [];
  const byKey = new Map(detectors.map((detector) => [detector.detectorKey, detector]));

  const candidatePolicy = byKey.get("bank_line_match_candidate");
  if (candidatePolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(candidatePolicy, agentThreshold);
    const minConfidence = candidatePolicy.parameters.minimumConfidencePercent!;
    const windowDays = candidatePolicy.parameters.matchWindowDays!;
    const accounts = await loaders.candidateAccounts(orgId, today, windowDays);
    for (const account of accounts) {
      const qualified = account.candidates.filter((candidate) => candidate.confidencePercent >= minConfidence);
      if (qualified.length === 0) continue;
      const materiality = fromUnits(qualified.reduce((sum, candidate) => sum + toUnits(candidate.amount), 0n));
      if (absoluteUnits(materiality) < absoluteUnits(threshold)) continue;
      const top = qualified[0]!;
      findings.push({
        agentKey: "reconciliation",
        findingType: "bank_line_match_candidate",
        fingerprint: `recon-candidates:${account.accountId}`,
        severity: "warning",
        confidence: top.confidence === "0.90" ? "0.9000" : "0.7000",
        materiality,
        subjectType: "account",
        subjectId: account.accountId,
        summary: {
          accountNumber: account.accountNumber,
          accountName: account.accountName,
          candidateCount: qualified.length,
          totalUnmatched: account.totalUnmatched,
          throughDate: account.throughDate,
          nextCandidate: {
            statementLineId: top.lineId,
            journalLineIds: [top.journalLineId],
            postedOn: top.postedOn,
            amount: top.amount,
            confidencePercent: top.confidencePercent,
          },
          review: account.reconciliationId
            ? "Confirm the proposed match inside the open session; the next-best candidate surfaces on the following run."
            : "Start a reconciliation session for this account first, then confirm the proposed match inside it.",
          href: `/banking/${account.accountId}`,
        },
        proposal: account.reconciliationId
          ? {
              tool: "match_bank_line",
              input: {
                reconciliationId: account.reconciliationId,
                statementLineId: top.lineId,
                journalLineIds: [top.journalLineId],
              },
              label: `Match ${top.amount} (${top.postedOn}) in ${account.accountName}`,
            }
          : null,
        evidence: qualified.slice(0, 10).map((candidate) => ({
          kind: "match_candidate",
          sourceType: "bank_statement_line",
          sourceId: candidate.lineId,
          data: {
            postedOn: candidate.postedOn,
            amount: candidate.amount,
            description: candidate.description,
            counterpartyRef: candidate.counterpartyRef,
            journalLineId: candidate.journalLineId,
            journalDate: candidate.journalDate,
            daysBetween: candidate.daysBetween,
            confidencePercent: candidate.confidencePercent,
          },
        })),
      });
    }
  }

  const stalePolicy = byKey.get("stale_reconciliation");
  if (stalePolicy?.enabled) {
    // No materiality floor: an abandoned session is a process failure at any balance.
    const cutoff = `${shiftDaysIso(today, -(stalePolicy.parameters.staleAfterDays!))}T00:00:00Z`;
    const sessions = await loaders.staleSessions(orgId, cutoff);
    for (const session of sessions) {
      const balanced = toUnits(session.difference) === 0n;
      findings.push({
        agentKey: "reconciliation",
        findingType: "stale_reconciliation",
        fingerprint: `recon-stale:${session.reconciliationId}`,
        severity: balanced ? "info" : "warning",
        confidence: "1.0000",
        materiality: session.difference,
        subjectType: "reconciliation",
        subjectId: session.reconciliationId,
        summary: {
          accountNumber: session.accountNumber,
          accountName: session.accountName,
          throughDate: session.throughDate,
          statementBalance: session.statementBalance,
          difference: session.difference,
          lastActivity: session.updatedAt,
          review: balanced
            ? "Nothing outstanding: sign off to close the session."
            : "Resume the session and clear the remaining difference before signing off.",
          href: `/banking/${session.accountId}/reconcile/${session.reconciliationId}`,
        },
        proposal: balanced
          ? {
              tool: "sign_off_reconciliation",
              input: { reconciliationId: session.reconciliationId },
              label: `Sign off ${session.accountName} through ${session.throughDate}`,
            }
          : null,
        evidence: [
          {
            kind: "reconciliation",
            sourceType: "reconciliation",
            sourceId: session.reconciliationId,
            data: {
              throughDate: session.throughDate,
              statementBalance: session.statementBalance,
              difference: session.difference,
              lastActivity: session.updatedAt,
            },
          },
        ],
      });
    }
  }

  const neverPolicy = byKey.get("never_reconciled_account");
  if (neverPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(neverPolicy, agentThreshold);
    const lookbackStart = shiftDaysIso(today, -(neverPolicy.parameters.lookbackDays!));
    const accounts = await loaders.neverReconciled(orgId, lookbackStart);
    for (const account of accounts) {
      if (absoluteUnits(account.activityTotal) < absoluteUnits(threshold)) continue;
      findings.push({
        agentKey: "reconciliation",
        findingType: "never_reconciled_account",
        fingerprint: `recon-never:${account.accountId}`,
        severity: "warning",
        confidence: "1.0000",
        materiality: account.activityTotal,
        subjectType: "account",
        subjectId: account.accountId,
        summary: {
          accountNumber: account.accountNumber,
          accountName: account.accountName,
          activityCount: account.activityCount,
          oldestActivity: account.oldestActivity,
          review: "Start the first reconciliation session for this account; the statement balance comes from the bank.",
          href: `/banking/${account.accountId}`,
        },
        evidence: [
          {
            kind: "unreconciled_activity",
            sourceType: "account",
            sourceId: account.accountId,
            data: {
              activityCount: account.activityCount,
              activityTotal: account.activityTotal,
              oldestActivity: account.oldestActivity,
              lookbackStart,
            },
          },
        ],
      });
    }
  }

  return findings;
}
