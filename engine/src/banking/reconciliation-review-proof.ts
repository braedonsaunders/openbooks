import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { BankingError } from "./banking-core.ts";

export type SignedReviewSubject = {
  orgId: string;
  id: string;
  accountId: string;
  bookId: string;
  currency: string;
  throughDate: string;
  statementBalance: string;
  signedOffAt: string;
  signedOffBy: string;
};
export type ReconciliationReviewProof = {
  digest: string;
  signOffDigest: string;
  statementDigest: string;
  matchDigest: string;
  ledgerDigest: string;
  completeLedgerDigest: string;
  completeLedgerLines: number;
  outstandingDigest: string;
  outstandingEntries: number;
  outstandingJournalLines: number;
  outstandingEffect: string;
  outstandingLegalEntityEffects: { subsidiaryId: string | null; amount: string }[];
  lateUnclearedJournalLines: number;
  neutralBasis: "late_movements" | "outstanding_movements" | null;
  statements: number;
  statementLines: number;
  matches: number;
  journalLines: number;
  lateEntries: number;
  lateJournalLines: number;
  lateEffect: string;
  legalEntityEffects: { subsidiaryId: string | null; amount: string }[];
  reversedMatches: number;
};

type EvidenceHashRow = { id: string; value: string; detail?: string };

/** Hash keyed rows incrementally. A review never sorts or concatenates a
 * complete financial workpaper in PostgreSQL or buffers it in the service. */
async function hashRows(
  tx: SqlExecutor,
  page: (after: string | null) => SQL,
  deadline: number,
  inspect?: (row: EvidenceHashRow) => void,
): Promise<{ digest: string; count: number }> {
  const hash = createHash("sha256");
  let after: string | null = null,
    count = 0;
  while (true) {
    if (Date.now() > deadline)
      throw new BankingError(
        "The evidence review exceeded its interactive time budget. Retry the same review when database capacity is available; nothing was changed.",
      );
    const rows: EvidenceHashRow[] = await tx.execute<EvidenceHashRow>(page(after), "objects");
    if (rows.length === 0) break;
    for (const row of rows) {
      hash.update(row.id).update("\0").update(row.value).update("\n");
      inspect?.(row);
      count++;
    }
    after = rows.at(-1)!.id;
  }
  return { digest: hash.digest("hex"), count };
}

/** Complete current statement, match and account-ledger evidence for the
 * immutable original sign-off. Review preserves every clearing stamp. */
export async function reconciliationReviewProof(
  tx: SqlExecutor,
  subject: SignedReviewSubject,
  deadline = Date.now() + 120_000,
): Promise<ReconciliationReviewProof> {
  const signOff = await hashRows(
    tx,
    (after) => sql`
    select al.id::text as id,encode(sha256(convert_to(to_jsonb(al)::text,'UTF8')),'hex') as value
      from audit_log al where al.org_id=${subject.orgId} and al.table_name='reconciliations'
       and al.row_id=${subject.id} and al.action='approve' and al.actor_id=${subject.signedOffBy}
       and al.at=${subject.signedOffAt}::timestamptz and al.changes->>'operation'='sign_off'
       ${after ? sql`and al.id>${after}::uuid` : sql``}
     order by al.id limit 500
  `,
    deadline,
  );
  if (signOff.count !== 1)
    throw new BankingError("The original sign-off audit identity is missing or ambiguous.");
  const statements = await hashRows(
    tx,
    (after) => sql`
    select s.id::text as id,encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex') as value from bank_statements s
     where s.org_id=${subject.orgId} and s.account_id=${subject.accountId}
       and exists(select 1 from bank_statement_lines l where l.org_id=s.org_id and l.statement_id=s.id
         and l.currency=${subject.currency} and l.posted_on<=${subject.throughDate}::date)
       ${after ? sql`and s.id>${after}::uuid` : sql``}
     order by s.id limit 500 for share of s
  `,
    deadline,
  );
  const statementLines = await hashRows(
    tx,
    (after) => sql`
    select l.id::text as id,encode(sha256(convert_to(to_jsonb(l)::text,'UTF8')),'hex') as value from bank_statement_lines l
     where l.org_id=${subject.orgId} and l.account_id=${subject.accountId}
       and l.currency=${subject.currency} and l.posted_on<=${subject.throughDate}::date
       ${after ? sql`and l.id>${after}::uuid` : sql``}
     order by l.id limit 500 for share of l
  `,
    deadline,
  );
  const matchedJournalIds = new Set<string>();
  let reversedMatches = 0;
  const matches = await hashRows(
    tx,
    (after) => sql`
    select m.id::text as id,encode(sha256(convert_to(jsonb_build_object('match',to_jsonb(m),'line',to_jsonb(jl),
      'journal',to_jsonb(je))::text,'UTF8')),'hex') as value,
      jsonb_build_object('id',jl.id,'status',je.status,'accountId',jl.account_id,'currency',jl.currency,
        'bookId',je.book_id,'stampId',jl.reconciliation_id,'postingDate',je.posting_date)::text as detail
      from reconciliation_matches m
      join journal_lines jl on jl.org_id=m.org_id and jl.id=m.journal_line_id
      join journal_entries je on je.org_id=jl.org_id and je.id=jl.entry_id
     where m.org_id=${subject.orgId} and m.reconciliation_id=${subject.id}
       ${after ? sql`and m.id>${after}::uuid` : sql``}
     order by m.id limit 500 for share of m,jl,je
  `,
    deadline,
    (row) => {
      const value = JSON.parse(row.detail ?? "null") as {
        id: string;
        status: string;
        accountId: string;
        currency: string;
        bookId: string;
        stampId: string;
        postingDate: string;
      } | null;
      if (
        !value ||
        value.accountId !== subject.accountId ||
        value.currency !== subject.currency ||
        value.bookId !== subject.bookId ||
        value.stampId !== subject.id ||
        value.postingDate > subject.throughDate
      ) {
        throw new BankingError(
          "The retained matches no longer establish the same book, account, cutoff and reconciliation stamps.",
        );
      }
      matchedJournalIds.add(value.id);
      if (value.status !== "posted") reversedMatches++;
    },
  );
  // PostgreSQL transaction timestamps can precede the transaction's eventual
  // commit. Hash every cut-off ledger row as well as known late movements so
  // a subsequent commit cannot remain covered by an older review certificate.
  const completeLedger = await hashRows(
    tx,
    (after) => sql`
    select jl.id::text as id,encode(sha256(convert_to(jsonb_build_object('line',to_jsonb(jl),
      'journal',to_jsonb(je))::text,'UTF8')),'hex') as value
      from journal_lines jl join journal_entries je on je.org_id=jl.org_id and je.id=jl.entry_id
     where jl.org_id=${subject.orgId} and jl.account_id=${subject.accountId}
       and jl.currency=${subject.currency} and je.book_id=${subject.bookId}
       and je.status in ('posted','reversed') and je.posting_date<=${subject.throughDate}::date
       ${after ? sql`and jl.id>${after}::uuid` : sql``}
     order by jl.id limit 500 for share of jl,je
  `,
    deadline,
  );
  const outstandingIds = new Set<string>(),
    outstandingEffects = new Map<string | null, bigint>();
  const outstanding = await hashRows(
    tx,
    (after) => sql`
    select jl.id::text as id,encode(sha256(convert_to(jsonb_build_object('line',to_jsonb(jl),
      'journal',to_jsonb(je))::text,'UTF8')),'hex') as value,
      jsonb_build_object('entryId',je.id,'subsidiaryId',jl.subsidiary_id,'transactionAmount',jl.txn_amount::text,'reconciledAt',jl.reconciled_at)::text as detail
      from journal_lines jl join journal_entries je on je.org_id=jl.org_id and je.id=jl.entry_id
     where jl.org_id=${subject.orgId} and jl.account_id=${subject.accountId} and jl.currency=${subject.currency}
       and je.book_id=${subject.bookId} and je.status in ('posted','reversed')
       and je.posting_date<=${subject.throughDate}::date and jl.reconciled_at is null
       ${after ? sql`and jl.id>${after}::uuid` : sql``}
     order by jl.id limit 500 for share of jl,je
  `,
    deadline,
    (row) => {
      const value = JSON.parse(row.detail ?? "null") as {
        entryId: string;
        subsidiaryId: string | null;
        transactionAmount: string;
      } | null;
      if (!value)
        throw new BankingError("An uncleared account line has no retained review identity.");
      outstandingIds.add(value.entryId);
      outstandingEffects.set(
        value.subsidiaryId,
        (outstandingEffects.get(value.subsidiaryId) ?? 0n) + toUnits(value.transactionAmount),
      );
    },
  );
  const lateEntryIds = new Set<string>();
  const effects = new Map<string | null, bigint>();
  let lateUnclearedJournalLines = 0;
  const late = await hashRows(
    tx,
    (after) => sql`
    select jl.id::text as id,encode(sha256(convert_to(jsonb_build_object('line',to_jsonb(jl),
      'journal',to_jsonb(je))::text,'UTF8')),'hex') as value,
      jsonb_build_object('entryId',je.id,'subsidiaryId',jl.subsidiary_id,'transactionAmount',jl.txn_amount::text,'reconciledAt',jl.reconciled_at)::text as detail
      from journal_lines jl join journal_entries je on je.org_id=jl.org_id and je.id=jl.entry_id
     where jl.org_id=${subject.orgId} and jl.account_id=${subject.accountId}
       and jl.currency=${subject.currency} and je.book_id=${subject.bookId}
       and je.status in ('posted','reversed') and je.posting_date<=${subject.throughDate}::date
       and je.posted_at>${subject.signedOffAt}::timestamptz
       ${after ? sql`and jl.id>${after}::uuid` : sql``}
     order by jl.id limit 500 for share of jl,je
  `,
    deadline,
    (row) => {
      const value = JSON.parse(row.detail ?? "null") as {
        subsidiaryId: string | null;
        entryId: string;
        transactionAmount: string;
        reconciledAt: string | null;
      } | null;
      if (!value) throw new BankingError("A late ledger line has no retained review identity.");
      lateEntryIds.add(value.entryId);
      if (value.reconciledAt === null) lateUnclearedJournalLines++;
      const entity = value.subsidiaryId;
      effects.set(entity, (effects.get(entity) ?? 0n) + toUnits(value.transactionAmount));
    },
  );
  const legalEntityEffects = [...effects]
    .sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))
    .map(([subsidiaryId, amount]) => ({ subsidiaryId, amount: fromUnits(amount) }));
  const outstandingLegalEntityEffects = [...outstandingEffects]
    .sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))
    .map(([subsidiaryId, amount]) => ({ subsidiaryId, amount: fromUnits(amount) }));
  const neutralBasis: ReconciliationReviewProof["neutralBasis"] = legalEntityEffects.every(
    (effect) => toUnits(effect.amount) === 0n,
  )
    ? "late_movements"
    : lateUnclearedJournalLines === late.count &&
        outstanding.count > 0 &&
        outstandingLegalEntityEffects.every((effect) => toUnits(effect.amount) === 0n)
      ? "outstanding_movements"
      : null;
  const statementDigest = createHash("sha256")
    .update(statements.digest)
    .update(statementLines.digest)
    .digest("hex");
  const proof = {
    signOffDigest: signOff.digest,
    statementDigest,
    matchDigest: matches.digest,
    ledgerDigest: late.digest,
    completeLedgerDigest: completeLedger.digest,
    completeLedgerLines: completeLedger.count,
    outstandingDigest: outstanding.digest,
    outstandingEntries: outstandingIds.size,
    outstandingJournalLines: outstanding.count,
    outstandingEffect: fromUnits(
      [...outstandingEffects.values()].reduce((sum, amount) => sum + amount, 0n),
    ),
    outstandingLegalEntityEffects,
    lateUnclearedJournalLines,
    neutralBasis,
    statements: statements.count,
    statementLines: statementLines.count,
    matches: matches.count,
    journalLines: matchedJournalIds.size,
    lateEntries: lateEntryIds.size,
    lateJournalLines: late.count,
    lateEffect: fromUnits([...effects.values()].reduce((total, amount) => total + amount, 0n)),
    legalEntityEffects,
    reversedMatches,
  };
  return {
    ...proof,
    digest: createHash("sha256")
      .update(canonicalJson({ subject, ...proof }))
      .digest("hex"),
  };
}

export type SignOffRevalidationCertificate = {
  auditId: string;
  reviewedAt: string;
  reviewedBy: string;
  reason: string;
  originalSignedOffAt: string;
  reviewedReconciliationId: string;
  appliesFromThroughDate: string;
  inherited: boolean;
  proof: ReconciliationReviewProof;
};

/** A certificate is usable only for the same original sign-off and the
 * exact evidence still present. A later posting or source change invalidates
 * the comparison rather than advancing a timestamp watermark. */
export async function currentSignOffRevalidation(
  tx: SqlExecutor,
  subject: SignedReviewSubject,
  proof: ReconciliationReviewProof,
): Promise<SignOffRevalidationCertificate | null> {
  const row = (
    await tx.execute<{
      id: string;
      at: string;
      actorId: string;
      changes: {
        originalSignedOffAt?: unknown;
        reason?: unknown;
        proof?: ReconciliationReviewProof;
      };
    }>(
      sql`
    select id,at::text as at,actor_id as "actorId",changes from audit_log
     where org_id=${subject.orgId} and table_name='reconciliations' and row_id=${subject.id}
       and action='update' and changes->>'operation'='revalidate_sign_off'
     order by at desc,id desc limit 1
  `,
      "objects",
    )
  )[0];
  if (
    !row ||
    row.changes.originalSignedOffAt !== subject.signedOffAt ||
    row.changes.proof?.digest !== proof.digest ||
    typeof row.changes.reason !== "string" ||
    !row.actorId ||
    row.actorId === subject.signedOffBy
  )
    return null;
  return {
    auditId: row.id,
    reviewedAt: row.at,
    reviewedBy: row.actorId,
    reason: row.changes.reason,
    originalSignedOffAt: subject.signedOffAt,
    reviewedReconciliationId: subject.id,
    appliesFromThroughDate: subject.throughDate,
    inherited: false,
    proof,
  };
}

/** A later sign-off may rely on the same independently reviewed neutral
 * ledger history only while the original review's complete evidence remains
 * identical. No later session is withdrawn, restamped or bank-cleared. */
export async function applicableSignOffRevalidation(
  tx: SqlExecutor,
  subject: SignedReviewSubject,
  proof: ReconciliationReviewProof,
): Promise<SignOffRevalidationCertificate | null> {
  const own = await currentSignOffRevalidation(tx, subject, proof);
  if (own) return own;
  if (proof.reversedMatches > 0 || proof.lateEntries === 0 || proof.neutralBasis === null)
    return null;
  type Candidate = {
    id: string;
    throughDate: string;
    statementBalance: string;
    signedOffAt: string;
    signedOffBy: string;
  };
  const candidates = await tx.execute<Candidate>(
    sql`
    select r.id,r.through_date::text as "throughDate",r.statement_balance::text as "statementBalance",
      r.signed_off_at::text as "signedOffAt",r.signed_off_by as "signedOffBy"
      from reconciliations r where r.org_id=${subject.orgId} and r.account_id=${subject.accountId}
       and r.currency=${subject.currency} and r.status='signed_off' and r.evidence_kind='statement'
       and r.through_date<${subject.throughDate}::date and r.signed_off_at is not null and r.signed_off_by is not null
       and exists(select 1 from audit_log al where al.org_id=r.org_id and al.row_id=r.id
         and al.table_name='reconciliations' and al.action='update'
         and al.changes->>'operation'='revalidate_sign_off'
         and al.changes->'proof'->>'ledgerDigest'=${proof.ledgerDigest})
     order by r.through_date desc,r.id limit 25 for share of r
  `,
    "objects",
  );
  const deadline = Date.now() + 120_000;
  for (const candidate of candidates) {
    const original: SignedReviewSubject = {
      ...subject,
      id: candidate.id,
      throughDate: candidate.throughDate,
      statementBalance: fromUnits(toUnits(candidate.statementBalance)),
      signedOffAt: candidate.signedOffAt,
      signedOffBy: candidate.signedOffBy,
    };
    const current = await reconciliationReviewProof(tx, original, deadline);
    if (
      current.ledgerDigest !== proof.ledgerDigest ||
      current.reversedMatches > 0 ||
      current.neutralBasis === null ||
      current.outstandingDigest !== proof.outstandingDigest
    )
      continue;
    const certificate = await currentSignOffRevalidation(tx, original, current);
    if (certificate) return { ...certificate, inherited: true };
  }
  return null;
}

/** Preserve the original sign-off's count and balance commitments when
 * deciding whether a current proof can inherit an earlier neutral review. */
export async function originalSignOffProofAgrees(
  tx: SqlExecutor,
  subject: SignedReviewSubject,
  proof: ReconciliationReviewProof,
): Promise<boolean> {
  const approvals = await tx.execute<{
    changes: {
      bookId?: unknown;
      throughDate?: unknown;
      currency?: unknown;
      statementBalance?: unknown;
      difference?: unknown;
      matchedJournalLines?: unknown;
      excludedStatementLines?: unknown;
    };
  }>(
    sql`
    select changes from audit_log where org_id=${subject.orgId} and table_name='reconciliations'
      and row_id=${subject.id} and action='approve' and actor_id=${subject.signedOffBy}
      and at=${subject.signedOffAt}::timestamptz and changes->>'operation'='sign_off' limit 2
  `,
    "objects",
  );
  const audit = approvals[0]?.changes;
  const excluded = (
    await tx.execute<{ count: number }>(
      sql`
    select count(*)::int as count from bank_statement_lines where org_id=${subject.orgId}
      and account_id=${subject.accountId} and currency=${subject.currency}
      and posted_on<=${subject.throughDate}::date and match_status='excluded'
  `,
      "objects",
    )
  )[0]?.count;
  return (
    approvals.length === 1 &&
    !!audit &&
    audit.bookId === subject.bookId &&
    audit.throughDate === subject.throughDate &&
    audit.currency === subject.currency &&
    audit.statementBalance === subject.statementBalance &&
    audit.difference === "0.0000" &&
    audit.matchedJournalLines === proof.journalLines &&
    audit.excludedStatementLines === excluded
  );
}

export function assertNeutralReviewProof(proof: ReconciliationReviewProof): void {
  if (proof.statements === 0 || proof.statementLines === 0)
    throw new BankingError(
      "Imported statement evidence through the cutoff is missing. Restore and review its retained source before changing reconciliation history.",
    );
  if (proof.reversedMatches > 0)
    throw new BankingError(
      "A matched journal has been reversed. Correct its reconciliation evidence through the governed withdrawal process.",
    );
  if (proof.neutralBasis === null) {
    throw new BankingError(
      "Late postings change the statement-currency balance of a legal entity and the complete uncleared set does not offset it. Review and correct the reconciliation; a neutral-history review cannot clear this difference.",
    );
  }
  if (proof.lateEntries === 0)
    throw new BankingError("There are no late postings to review for this sign-off.");
}
