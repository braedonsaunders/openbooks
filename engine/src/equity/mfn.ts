/**
 * Most-favored-nation SAFEs.
 *
 * A SAFE issued with the MFN term lets its holder adopt the terms of a
 * convertible instrument the company issues after it, while it is still
 * outstanding, when that instrument's terms are better for the holder (the
 * YC MFN SAFE):
 *  - a valuation cap where it has none, or a lower one;
 *  - a discount where it has none, or a higher one;
 *  - post-money conversion where it converts pre-money (a post-money cap
 *    divides by a capitalization that already counts every converting
 *    instrument, so the holder is not diluted by them).
 * The holder adopts the later instrument's cap, discount and SAFE type
 * together; a later note converts pre-money. Elections are governed actions
 * (an Equity action Flow may require approval), dated, reasoned and audited,
 * and take effect from their
 * date: a conversion on or after that date converts on the adopted terms,
 * and nothing dated earlier is reinterpreted. A later instrument is compared
 * with the terms in force on the election date, in the SAFE's own currency.
 *
 * An election recorded in error is reversed by a governed reversal dated on
 * or after it, while the SAFE is outstanding: from the reversal date the
 * SAFE carries the terms in force before the election again. The instrument
 * an election adopted cannot be voided while the election stands (see
 * events.ts), and an election whose source was voided before that rule
 * never applies, so a conversion always uses terms that stand.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  convertibleState,
  convertibleTerms,
  effectiveConvertibleTerms,
  electionInForce,
  reversedElections,
  voidedSecurities,
} from "./cap-table.ts";
import type { ConvertibleTerms } from "./convertibles.ts";
import { equityError, fig, type EquityError } from "./errors.ts";
import { governEquityAction, type GovernedStatus } from "./governance.ts";
import { requireReason, writeEquityAudit } from "./internal.ts";
import { compareRational, parseMoney, parsePercent } from "./quantities.ts";
import { newEquityId } from "./securities.ts";
import { inEquityCommand, requireDate, type EquityCommand } from "./structure.ts";
import type { EquityBook, SafeType, SecurityRecord } from "./types.ts";

export type MfnTerm = "cap" | "discount" | "post_money";

export interface MfnCandidate {
  sourceSecurityId: string;
  securityNumber: string;
  kind: "safe" | "note";
  issueDate: string;
  valuationCap: string | null;
  discountPercent: string | null;
  safeType: SafeType;
  /** Terms better for the MFN holder than those in force. */
  improves: MfnTerm[];
  /** Terms worse for the holder that adopting would also bring. */
  concedes: MfnTerm[];
}

/** The cap, discount and SAFE type a later instrument would bring. */
function offered(terms: ConvertibleTerms): {
  valuationCap: string | null;
  discountPercent: string | null;
  safeType: SafeType;
} {
  return {
    valuationCap: terms.valuationCap,
    discountPercent: terms.discountPercent,
    safeType: terms.kind === "safe" ? (terms.safeType ?? "pre_money") : "pre_money",
  };
}

/** Compare a later instrument's terms with those in force, term by term, from the MFN holder's side. */
export function compareMfnTerms(
  current: ConvertibleTerms,
  later: ReturnType<typeof offered>,
): { improves: MfnTerm[]; concedes: MfnTerm[] } {
  const improves: MfnTerm[] = [];
  const concedes: MfnTerm[] = [];
  const cap = (value: string | null) => (value ? parseMoney(value, "valuationCap") : null);
  const currentCap = cap(current.valuationCap);
  const laterCap = cap(later.valuationCap);
  if (laterCap && (!currentCap || compareRational(laterCap, currentCap) < 0)) improves.push("cap");
  else if (currentCap && (!laterCap || compareRational(laterCap, currentCap) > 0))
    concedes.push("cap");
  // A 0% discount is recorded as stated, but betters nothing and concedes nothing against no discount.
  const discount = (value: string | null) => {
    const parsed = value ? parsePercent(value, "discountPercent") : null;
    return parsed && parsed.numerator > 0n ? parsed : null;
  };
  const currentDiscount = discount(current.discountPercent);
  const laterDiscount = discount(later.discountPercent);
  if (laterDiscount && (!currentDiscount || compareRational(laterDiscount, currentDiscount) > 0))
    improves.push("discount");
  else if (
    currentDiscount &&
    (!laterDiscount || compareRational(laterDiscount, currentDiscount) < 0)
  )
    concedes.push("discount");
  const currentType = current.safeType ?? "pre_money";
  if (later.safeType === "post_money" && currentType === "pre_money") improves.push("post_money");
  else if (later.safeType === "pre_money" && currentType === "post_money")
    concedes.push("post_money");
  return { improves, concedes };
}

/** Later instruments whose terms an MFN SAFE could adopt on `asOf`, with what each would change. */
export function mfnCandidates(
  book: EquityBook,
  security: SecurityRecord,
  asOf: string,
): MfnCandidate[] {
  if (security.kind !== "safe" || !security.mfn || asOf < security.issueDate) return [];
  if (convertibleState(book, security, asOf).status !== "outstanding") return [];
  const { terms: current } = effectiveConvertibleTerms(book, security, asOf);
  const voided = voidedSecurities(book, asOf);
  const reversed = reversedElections(book, asOf);
  const adopted = new Set(
    book.securityAmendments
      .filter(
        (row) =>
          row.securityId === security.id &&
          row.kind === "mfn_election" &&
          !reversed.has(row.id) &&
          !voided.has(row.sourceSecurityId),
      )
      .map((row) => row.sourceSecurityId),
  );
  const out: MfnCandidate[] = [];
  for (const later of book.securities) {
    if (later.id === security.id || (later.kind !== "safe" && later.kind !== "note")) continue;
    if (
      later.issueDate <= security.issueDate ||
      later.issueDate > asOf ||
      later.currency !== security.currency
    )
      continue;
    if (voided.has(later.id) || adopted.has(later.id)) continue;
    const terms = offered(convertibleTerms(later));
    if (!terms.valuationCap && !terms.discountPercent) continue;
    const { improves, concedes } = compareMfnTerms(current, terms);
    if (improves.length === 0) continue;
    out.push({
      sourceSecurityId: later.id,
      securityNumber: later.securityNumber,
      kind: later.kind,
      issueDate: later.issueDate,
      ...terms,
      improves,
      concedes,
    });
  }
  return out.sort((a, b) =>
    a.issueDate < b.issueDate
      ? -1
      : a.issueDate > b.issueDate
        ? 1
        : a.securityNumber < b.securityNumber
          ? -1
          : 1,
  );
}

export interface ElectMfnInput extends EquityCommand {
  securityId: string;
  sourceSecurityId: string;
  effectiveOn: string;
  reason: string;
  idempotencyKey?: string | null;
}

/**
 * Record an MFN SAFE holder's election to adopt a later instrument's terms
 * (equity.manage; a governed action an Equity action Flow may require
 * approval for).
 */
export async function electMfnTerms(
  input: ElectMfnInput,
): Promise<{
  amendmentId: string | null;
  replayed: boolean;
  status: GovernedStatus;
  requestId: string;
}> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "electedOn");
  const reason = requireReason(input.reason, "mfnElection");
  if (!isUuid(input.securityId)) throw equityError("safeUnknown");
  const located = await withOrgTransaction(
    input.orgId,
    async () =>
      (
        await db.execute<{
          subsidiary_id: string;
          security_number: string;
          currency: string;
          holder_name: string | null;
          amount: string | null;
        }>(
          sql`
    select s.subsidiary_id, s.security_number, s.currency, p.display_name as holder_name, s.consideration_amount::text as amount
      from equity_securities s left join parties p on p.org_id = s.org_id and p.id = s.holder_party_id
     where s.org_id = ${input.orgId} and s.id = ${input.securityId}`,
          "objects",
        )
      )[0],
  );
  if (!located) throw equityError("safeUnknown");
  const { orgId: _org, actorId: _actor, ...payload } = input;
  const outcome = await governEquityAction(
    {
      orgId: input.orgId,
      actorId: input.actorId,
      subsidiaryId: located.subsidiary_id,
      action: "mfn_election",
      subjectId: input.securityId,
      subjectLabel: located.security_number,
      effectiveOn,
      reason,
      summary: {
        securityKind: "safe",
        holderName: located.holder_name,
        amount: located.amount,
        currency: located.currency,
      },
      payload,
      idempotencyKey:
        typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() !== ""
          ? `mfn:${input.idempotencyKey.trim()}`
          : null,
    },
    (actorId) => applyMfnElection({ ...input, actorId }),
  );
  return {
    amendmentId: outcome.result?.amendmentId ?? null,
    replayed: outcome.replayed || (outcome.result?.replayed ?? false),
    status: outcome.status,
    requestId: outcome.requestId,
  };
}

/** Apply an MFN election: the command its approval releases. */
export async function applyMfnElection(
  input: ElectMfnInput,
): Promise<{ amendmentId: string; replayed: boolean }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "electedOn");
  const reason = requireReason(input.reason, "mfnElection");
  const idempotencyKey =
    typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() !== ""
      ? input.idempotencyKey.trim()
      : null;
  const unknown = () => equityError("safeUnknown");
  if (!isUuid(input.securityId)) throw unknown();
  const located = await withOrgTransaction(
    input.orgId,
    async () =>
      (
        await db.execute<{ subsidiary_id: string }>(
          sql`
    select subsidiary_id from equity_securities where org_id = ${input.orgId} and id = ${input.securityId}`,
          "objects",
        )
      )[0],
  );
  if (!located) throw unknown();
  return inEquityCommand(
    { ...input, subsidiaryId: located.subsidiary_id },
    "equity.manage",
    async ({ book }) => {
      if (idempotencyKey) {
        const existing = (
          await db.execute<{ id: string; security_id: string; source_security_id: string }>(
            sql`
        select id, security_id, source_security_id from equity_security_amendments where org_id = ${input.orgId} and idempotency_key = ${idempotencyKey}`,
            "objects",
          )
        )[0];
        if (existing) {
          if (
            existing.security_id !== input.securityId ||
            existing.source_security_id !== input.sourceSecurityId
          ) {
            throw equityError("idempotencyConflict", { subject: fig.choice("election") });
          }
          return { amendmentId: existing.id, replayed: true };
        }
      }
      await db.execute(
        sql`select id from equity_securities where org_id = ${input.orgId} and id = ${input.securityId} for update`,
      );
      const security = book.securities.find((row) => row.id === input.securityId)!;
      if (security.kind !== "safe" || !security.mfn) {
        throw equityError(
          "mfnNotApplicable",
          { security: fig.text(security.securityNumber) },
          { field: "securityId" },
        );
      }
      const lifetime = convertibleState(book, security, "9999-12-31");
      if (lifetime.status !== "outstanding") {
        throw equityError("mfnElectionClosed", {
          security: fig.text(security.securityNumber),
          status: fig.choice(lifetime.status),
          date: fig.date(lifetime.endedOn ?? effectiveOn),
        });
      }
      const latest = book.securityAmendments
        .filter((row) => row.securityId === security.id)
        .map((row) => row.effectiveOn)
        .sort()
        .at(-1);
      if (latest && effectiveOn < latest) {
        throw equityError(
          "mfnBackdated",
          {
            security: fig.text(security.securityNumber),
            date: fig.date(latest),
            action: fig.choice("election"),
            field: fig.term("electedOn"),
          },
          { field: "effectiveOn" },
        );
      }
      const candidate = mfnCandidates(book, security, effectiveOn).find(
        (row) => row.sourceSecurityId === input.sourceSecurityId,
      );
      if (!candidate) throw notBetter(book, security, input.sourceSecurityId, effectiveOn);
      const { terms: before } = effectiveConvertibleTerms(book, security, effectiveOn);
      const id = await newEquityId(db);
      const inserted = await db.execute<{ id: string }>(
        sql`
      insert into equity_security_amendments (id, org_id, subsidiary_id, security_id, kind, effective_on, source_security_id,
        valuation_cap, discount_percent, safe_type, reason, idempotency_key, created_by)
      values (${id}, ${input.orgId}, ${located.subsidiary_id}, ${security.id}, 'mfn_election', ${effectiveOn}::date, ${candidate.sourceSecurityId},
        ${candidate.valuationCap}::numeric, ${candidate.discountPercent}::numeric, ${candidate.safeType}, ${reason}, ${idempotencyKey}, ${input.actorId})
      returning id`,
        "objects",
      );
      if (inserted.length !== 1) throw equityError("notSaved", { record: fig.choice("election") });
      await writeEquityAudit(db, {
        orgId: input.orgId,
        table: "equity_securities",
        rowId: security.id,
        action: "equity.mfn.elect",
        actorId: input.actorId,
        changes: {
          amendmentId: id,
          effectiveOn,
          sourceSecurityId: candidate.sourceSecurityId,
          sourceSecurityNumber: candidate.securityNumber,
          before: {
            valuationCap: before.valuationCap,
            discountPercent: before.discountPercent,
            safeType: before.safeType,
          },
          after: {
            valuationCap: candidate.valuationCap,
            discountPercent: candidate.discountPercent,
            safeType: candidate.safeType,
          },
          improves: candidate.improves,
          concedes: candidate.concedes,
          reason,
        },
      });
      return { amendmentId: id, replayed: false };
    },
  );
}

/** Why an instrument's terms cannot be adopted on the date, with the remedy for that reason. */
function notBetter(
  book: EquityBook,
  security: SecurityRecord,
  sourceSecurityId: string,
  effectiveOn: string,
): EquityError {
  const onSource = { field: "sourceSecurityId" };
  const source = book.securities.find((row) => row.id === sourceSecurityId);
  if (!source || (source.kind !== "safe" && source.kind !== "note") || source.id === security.id) {
    return equityError("mfnSourceNotConvertible", {}, onSource);
  }
  if (source.issueDate <= security.issueDate) {
    return equityError(
      "mfnSourceNotLater",
      {
        source: fig.text(source.securityNumber),
        sourceIssuedOn: fig.date(source.issueDate),
        safe: fig.text(security.securityNumber),
        safeIssuedOn: fig.date(security.issueDate),
      },
      onSource,
    );
  }
  if (source.issueDate > effectiveOn) {
    return equityError(
      "mfnSourceNotYetIssued",
      {
        source: fig.text(source.securityNumber),
        date: fig.date(effectiveOn),
        issuedOn: fig.date(source.issueDate),
        field: fig.term("electedOn"),
      },
      { field: "effectiveOn" },
    );
  }
  if (source.currency !== security.currency) {
    return equityError(
      "mfnSourceCurrency",
      {
        source: fig.text(source.securityNumber),
        sourceCurrency: fig.text(source.currency),
        currency: fig.text(security.currency),
      },
      onSource,
    );
  }
  if (voidedSecurities(book, effectiveOn).has(source.id)) {
    return equityError("mfnSourceVoid", { source: fig.text(source.securityNumber) }, onSource);
  }
  const standing = electionInForce(book, security, effectiveOn);
  if (standing?.sourceSecurityId === source.id) {
    return equityError(
      "mfnTermsAlreadyAdopted",
      {
        safe: fig.text(security.securityNumber),
        source: fig.text(source.securityNumber),
        date: fig.date(standing.effectiveOn),
      },
      onSource,
    );
  }
  const offeredTerms = convertibleTerms(source);
  if (!offeredTerms.valuationCap && !offeredTerms.discountPercent) {
    return equityError("mfnSourceNoTerms", { source: fig.text(source.securityNumber) }, onSource);
  }
  return equityError(
    "mfnTermsNotBetter",
    {
      source: fig.text(source.securityNumber),
      safe: fig.text(security.securityNumber),
      date: fig.date(effectiveOn),
    },
    onSource,
  );
}

export interface ReverseMfnInput extends EquityCommand {
  securityId: string;
  /** The election to reverse. */
  amendmentId: string;
  effectiveOn: string;
  reason: string;
  idempotencyKey?: string | null;
}

/**
 * Reverse an MFN election recorded in error (equity.manage; a governed
 * action an Equity action Flow may require approval for). From the reversal
 * date the SAFE carries the terms in force before the election again.
 */
export async function reverseMfnElection(
  input: ReverseMfnInput,
): Promise<{
  amendmentId: string | null;
  replayed: boolean;
  status: GovernedStatus;
  requestId: string;
}> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "effectiveOn");
  const reason = requireReason(input.reason, "mfnReversal");
  if (!isUuid(input.securityId)) throw equityError("safeUnknown");
  const located = await withOrgTransaction(
    input.orgId,
    async () =>
      (
        await db.execute<{
          subsidiary_id: string;
          security_number: string;
          currency: string;
          holder_name: string | null;
          amount: string | null;
        }>(
          sql`
    select s.subsidiary_id, s.security_number, s.currency, p.display_name as holder_name, s.consideration_amount::text as amount
      from equity_securities s left join parties p on p.org_id = s.org_id and p.id = s.holder_party_id
     where s.org_id = ${input.orgId} and s.id = ${input.securityId}`,
          "objects",
        )
      )[0],
  );
  if (!located) throw equityError("safeUnknown");
  const { orgId: _org, actorId: _actor, ...payload } = input;
  const outcome = await governEquityAction(
    {
      orgId: input.orgId,
      actorId: input.actorId,
      subsidiaryId: located.subsidiary_id,
      action: "mfn_reversal",
      subjectId: input.securityId,
      subjectLabel: located.security_number,
      effectiveOn,
      reason,
      summary: {
        securityKind: "safe",
        holderName: located.holder_name,
        amount: located.amount,
        currency: located.currency,
      },
      payload,
      idempotencyKey:
        typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() !== ""
          ? `mfn-reversal:${input.idempotencyKey.trim()}`
          : null,
    },
    (actorId) => applyMfnReversal({ ...input, actorId }),
  );
  return {
    amendmentId: outcome.result?.amendmentId ?? null,
    replayed: outcome.replayed || (outcome.result?.replayed ?? false),
    status: outcome.status,
    requestId: outcome.requestId,
  };
}

/** Apply an MFN election reversal: the command its approval releases. */
export async function applyMfnReversal(
  input: ReverseMfnInput,
): Promise<{ amendmentId: string; replayed: boolean }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "effectiveOn");
  const reason = requireReason(input.reason, "mfnReversal");
  const idempotencyKey =
    typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() !== ""
      ? input.idempotencyKey.trim()
      : null;
  const unknown = () => equityError("safeUnknown");
  if (!isUuid(input.securityId)) throw unknown();
  const located = await withOrgTransaction(
    input.orgId,
    async () =>
      (
        await db.execute<{ subsidiary_id: string }>(
          sql`
    select subsidiary_id from equity_securities where org_id = ${input.orgId} and id = ${input.securityId}`,
          "objects",
        )
      )[0],
  );
  if (!located) throw unknown();
  return inEquityCommand(
    { ...input, subsidiaryId: located.subsidiary_id },
    "equity.manage",
    async ({ book }) => {
      if (idempotencyKey) {
        const existing = (
          await db.execute<{
            id: string;
            security_id: string;
            reverses_amendment_id: string | null;
          }>(
            sql`
        select id, security_id, reverses_amendment_id from equity_security_amendments where org_id = ${input.orgId} and idempotency_key = ${idempotencyKey}`,
            "objects",
          )
        )[0];
        if (existing) {
          if (
            existing.security_id !== input.securityId ||
            existing.reverses_amendment_id !== input.amendmentId
          ) {
            throw equityError("idempotencyConflict", { subject: fig.choice("reversal") });
          }
          return { amendmentId: existing.id, replayed: true };
        }
      }
      await db.execute(
        sql`select id from equity_securities where org_id = ${input.orgId} and id = ${input.securityId} for update`,
      );
      const security = book.securities.find((row) => row.id === input.securityId)!;
      const election = book.securityAmendments.find(
        (row) =>
          row.id === input.amendmentId &&
          row.securityId === security.id &&
          row.kind === "mfn_election",
      );
      if (!election) {
        throw equityError("mfnElectionUnknown", {}, { field: "amendmentId" });
      }
      if (reversedElections(book, "9999-12-31").has(election.id)) {
        throw equityError("mfnElectionAlreadyReversed");
      }
      if (effectiveOn < election.effectiveOn) {
        throw equityError(
          "mfnReversalBeforeElection",
          { date: fig.date(election.effectiveOn) },
          { field: "effectiveOn" },
        );
      }
      const later = book.securityAmendments.find(
        (row) =>
          row.securityId === security.id &&
          row.id !== election.id &&
          row.effectiveOn > election.effectiveOn &&
          row.kind === "mfn_election" &&
          !reversedElections(book, "9999-12-31").has(row.id),
      );
      if (later) {
        throw equityError("mfnReversalHasDependents", {
          security: fig.text(security.securityNumber),
          date: fig.date(later.effectiveOn),
        });
      }
      const lifetime = convertibleState(book, security, "9999-12-31");
      if (lifetime.status !== "outstanding") {
        const certificate = lifetime.resultingSecurityId
          ? book.securities.find((row) => row.id === lifetime.resultingSecurityId)
          : null;
        const closed = {
          security: fig.text(security.securityNumber),
          status: fig.choice(lifetime.status),
          date: fig.date(lifetime.endedOn ?? effectiveOn),
        };
        throw certificate
          ? equityError("mfnReversalClosedConverted", {
              ...closed,
              certificate: fig.text(certificate.securityNumber),
            })
          : equityError("mfnReversalClosed", closed);
      }
      const latest = book.securityAmendments
        .filter((row) => row.securityId === security.id)
        .map((row) => row.effectiveOn)
        .sort()
        .at(-1);
      if (latest && effectiveOn < latest) {
        throw equityError(
          "mfnBackdated",
          {
            security: fig.text(security.securityNumber),
            date: fig.date(latest),
            action: fig.choice("reversal"),
            field: fig.term("effectiveOn"),
          },
          { field: "effectiveOn" },
        );
      }
      const { terms: before } = effectiveConvertibleTerms(book, security, effectiveOn);
      const after = effectiveConvertibleTerms(
        {
          ...book,
          securityAmendments: [
            ...book.securityAmendments,
            {
              ...election,
              id: "pending",
              kind: "mfn_reversal",
              effectiveOn,
              reversesAmendmentId: election.id,
            },
          ],
        },
        security,
        effectiveOn,
      ).terms;
      const id = await newEquityId(db);
      const inserted = await db.execute<{ id: string }>(
        sql`
      insert into equity_security_amendments (id, org_id, subsidiary_id, security_id, kind, effective_on, source_security_id,
        valuation_cap, discount_percent, safe_type, reverses_amendment_id, reason, idempotency_key, created_by)
      values (${id}, ${input.orgId}, ${located.subsidiary_id}, ${security.id}, 'mfn_reversal', ${effectiveOn}::date, ${election.sourceSecurityId},
        ${after.valuationCap}::numeric, ${after.discountPercent}::numeric, ${after.safeType ?? "pre_money"}, ${election.id}, ${reason}, ${idempotencyKey}, ${input.actorId})
      returning id`,
        "objects",
      );
      if (inserted.length !== 1) throw equityError("notSaved", { record: fig.choice("reversal") });
      await writeEquityAudit(db, {
        orgId: input.orgId,
        table: "equity_securities",
        rowId: security.id,
        action: "equity.mfn.reverse",
        actorId: input.actorId,
        changes: {
          amendmentId: id,
          reversesAmendmentId: election.id,
          effectiveOn,
          sourceSecurityId: election.sourceSecurityId,
          before: {
            valuationCap: before.valuationCap,
            discountPercent: before.discountPercent,
            safeType: before.safeType,
          },
          after: {
            valuationCap: after.valuationCap,
            discountPercent: after.discountPercent,
            safeType: after.safeType,
          },
          reason,
        },
      });
      return { amendmentId: id, replayed: false };
    },
  );
}
