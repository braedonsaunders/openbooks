import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { normalizeDecimal, normalizeMoney } from "../money/money.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import type { SqlExecutor } from "../platform/db.ts";
import type { BookAccountBasis, BookAmountBasis } from "./book-posting-policy.ts";
import { fail } from "./ledger-post-error.ts";
import type { PostEntryInput, PostEntryLineInput, PostEntryResult } from "./post-entry.ts";

/** How the request states amounts and accounts; part of the request identity. */
export interface PostingRequestBasis {
  amountBasis: BookAmountBasis;
  accountBasis: BookAccountBasis;
}

/** The exactly-once identity a keyed posting stamps into custom and replays against. */
export interface PostingRequestIdentity {
  idempotencyKey: string;
  requestHash: string;
  requestBasis: PostingRequestBasis;
}

type PostingHeader = Pick<
  PostEntryInput,
  | "orgId"
  | "bookId"
  | "subsidiaryId"
  | "postingDate"
  | "periodId"
  | "memo"
  | "origin"
  | "reversesEntryId"
  | "sourceDocumentId"
>;

/** Financial identity excludes allocated numbers, actors and replay context. */
export function postingRequestHash(
  header: PostingHeader,
  lines: readonly PostEntryLineInput[],
): string {
  const identity = {
    version: 1,
    orgId: header.orgId,
    bookId: header.bookId,
    subsidiaryId: header.subsidiaryId,
    postingDate: header.postingDate,
    periodId: header.periodId,
    origin: header.origin,
    memo: header.memo ?? null,
    reversesEntryId: header.reversesEntryId ?? null,
    sourceDocumentId: header.sourceDocumentId ?? null,
    lines: lines
      .map((line, index) => ({
        lineNumber: line.lineNumber ?? index + 1,
        accountId: line.accountId,
        subsidiaryId: line.subsidiaryId ?? header.subsidiaryId,
        amount: normalizeMoney(line.amount),
        currency: line.currency,
        txnAmount: normalizeMoney(line.txnAmount ?? line.amount),
        fxRate: normalizeDecimal(line.fxRate ?? "1", 10),
        memo: line.memo ?? null,
        partyId: line.partyId ?? null,
        departmentId: line.departmentId ?? null,
        projectId: line.projectId ?? null,
        locationId: line.locationId ?? null,
        classId: line.classId ?? null,
        equipmentUnitId: line.equipmentUnitId ?? null,
        paymentCardId: line.paymentCardId ?? null,
        taxCodeId: line.taxCodeId ?? null,
        extraDims: line.extraDims ?? {},
        quantity: line.quantity == null ? null : normalizeDecimal(line.quantity, 8),
        unit: line.unit ?? null,
        dueDate: line.dueDate ?? null,
        isOpenItem: line.isOpenItem ?? false,
        custom: line.custom ?? {},
        ...(line.eliminate ? { eliminate: true } : {}),
        ...(line.isCurrencyAdjustment ? { isCurrencyAdjustment: true } : {}),
        contributorKind: line.contributorKind ?? null,
        contributorRef: line.contributorRef ?? null,
      }))
      .sort((a, b) => a.lineNumber - b.lineNumber),
  };
  return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

/** The custom fields that carry the identity on the entry. */
export function identityEvidence(identity: PostingRequestIdentity): Record<string, unknown> {
  return {
    idempotencyKey: identity.idempotencyKey,
    postingRequestHash: identity.requestHash,
    postingRequestBasis: identity.requestBasis,
  };
}

interface KeyedLookup {
  orgId: string;
  entryNumber: string;
  identity: PostingRequestIdentity;
}

/**
 * The posted entry already holding the key, header and lines in one read, or null. A holder that
 * is lineless, unposted, unhashed or carries different content is refused by name, never replayed.
 */
export async function readKeyedEntry(
  executor: SqlExecutor,
  lookup: KeyedLookup,
): Promise<PostEntryResult | null> {
  const { entryNumber, identity } = lookup;
  const key = identity.idempotencyKey;
  const rows = await executor.execute<{
    entry_id: string;
    id: string | null;
    line_number: number | null;
    request_hash: string | null;
    status: string;
    request_basis?: PostingRequestBasis | null;
  }>(
    sql`
      select je.id as entry_id, jl.id as id, jl.line_number as line_number,
             je.custom->>'postingRequestHash' as request_hash,
             je.custom->'postingRequestBasis' as request_basis,
             je.status
        from journal_entries je
        left join journal_lines jl
          on jl.org_id = je.org_id and jl.entry_id = je.id
       where je.org_id = ${lookup.orgId} and je.custom->>'idempotencyKey' = ${key}
       order by jl.line_number`,
    "objects",
  );
  const holder = rows[0];
  if (!holder) return null;
  const entryId = holder.entry_id;
  const replayed = rows.flatMap((row) =>
    row.id === null ? [] : [{ id: row.id, lineNumber: row.line_number! }],
  );
  if (replayed.length === 0)
    fail(
      `journal entry ${entryNumber}: idempotency key ${key} resolves to entry ${entryId}, which has no lines — a keyed posting commits its header and lines together, so this entry is damaged ledger data, not a replay; retrying resolves to the same entry, so have entry ${entryId} investigated before posting again`,
    );
  if (holder.status !== "posted") {
    fail(
      `journal entry ${entryNumber}: keyed entry ${entryId} is not posted — resolve its lifecycle before retrying`,
    );
  }
  if (!holder.request_hash) {
    fail(
      `journal entry ${entryNumber}: keyed entry ${entryId} has no protected request identity — reconcile its posting evidence through the governed ledger before retrying`,
    );
  }
  const storedBasis = holder.request_basis;
  if (
    holder.request_hash !== identity.requestHash ||
    !storedBasis ||
    storedBasis.amountBasis !== identity.requestBasis.amountBasis ||
    storedBasis.accountBasis !== identity.requestBasis.accountBasis
  ) {
    fail(
      `journal entry ${entryNumber}: idempotency key ${key} already identifies entry ${entryId} with different posting content — review that journal entry and correct this request; use a new key only for a separate intended posting`,
    );
  }
  return { entryId, lines: replayed };
}

/** The entry that won a keyed insert race; the conflict proves it exists, so none visible fails. */
export async function readKeyWinner(
  executor: SqlExecutor,
  lookup: KeyedLookup,
): Promise<PostEntryResult> {
  const winner = await readKeyedEntry(executor, lookup);
  if (!winner)
    fail(
      `journal entry ${lookup.entryNumber} collided on its idempotency key but the winning entry is not visible — retry the posting`,
    );
  return winner;
}
