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
import { convertibleState, convertibleTerms, effectiveConvertibleTerms, electionInForce, reversedElections, voidedSecurities } from "./cap-table.ts";
import type { ConvertibleTerms } from "./convertibles.ts";
import { EquityError } from "./errors.ts";
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
function offered(terms: ConvertibleTerms): { valuationCap: string | null; discountPercent: string | null; safeType: SafeType } {
  return { valuationCap: terms.valuationCap, discountPercent: terms.discountPercent, safeType: terms.kind === "safe" ? terms.safeType ?? "pre_money" : "pre_money" };
}

/** Compare a later instrument's terms with those in force, term by term, from the MFN holder's side. */
export function compareMfnTerms(current: ConvertibleTerms, later: ReturnType<typeof offered>): { improves: MfnTerm[]; concedes: MfnTerm[] } {
  const improves: MfnTerm[] = [];
  const concedes: MfnTerm[] = [];
  const cap = (value: string | null) => (value ? parseMoney(value, "the valuation cap") : null);
  const currentCap = cap(current.valuationCap);
  const laterCap = cap(later.valuationCap);
  if (laterCap && (!currentCap || compareRational(laterCap, currentCap) < 0)) improves.push("cap");
  else if (currentCap && (!laterCap || compareRational(laterCap, currentCap) > 0)) concedes.push("cap");
  // A 0% discount is recorded as stated, but betters nothing and concedes nothing against no discount.
  const discount = (value: string | null) => {
    const parsed = value ? parsePercent(value, "the discount") : null;
    return parsed && parsed.numerator > 0n ? parsed : null;
  };
  const currentDiscount = discount(current.discountPercent);
  const laterDiscount = discount(later.discountPercent);
  if (laterDiscount && (!currentDiscount || compareRational(laterDiscount, currentDiscount) > 0)) improves.push("discount");
  else if (currentDiscount && (!laterDiscount || compareRational(laterDiscount, currentDiscount) < 0)) concedes.push("discount");
  const currentType = current.safeType ?? "pre_money";
  if (later.safeType === "post_money" && currentType === "pre_money") improves.push("post_money");
  else if (later.safeType === "pre_money" && currentType === "post_money") concedes.push("post_money");
  return { improves, concedes };
}

/** Later instruments whose terms an MFN SAFE could adopt on `asOf`, with what each would change. */
export function mfnCandidates(book: EquityBook, security: SecurityRecord, asOf: string): MfnCandidate[] {
  if (security.kind !== "safe" || !security.mfn || asOf < security.issueDate) return [];
  if (convertibleState(book, security, asOf).status !== "outstanding") return [];
  const { terms: current } = effectiveConvertibleTerms(book, security, asOf);
  const voided = voidedSecurities(book, asOf);
  const reversed = reversedElections(book, asOf);
  const adopted = new Set(book.securityAmendments
    .filter((row) => row.securityId === security.id && row.kind === "mfn_election" && !reversed.has(row.id) && !voided.has(row.sourceSecurityId))
    .map((row) => row.sourceSecurityId));
  const out: MfnCandidate[] = [];
  for (const later of book.securities) {
    if (later.id === security.id || (later.kind !== "safe" && later.kind !== "note")) continue;
    if (later.issueDate <= security.issueDate || later.issueDate > asOf || later.currency !== security.currency) continue;
    if (voided.has(later.id) || adopted.has(later.id)) continue;
    const terms = offered(convertibleTerms(later));
    if (!terms.valuationCap && !terms.discountPercent) continue;
    const { improves, concedes } = compareMfnTerms(current, terms);
    if (improves.length === 0) continue;
    out.push({ sourceSecurityId: later.id, securityNumber: later.securityNumber, kind: later.kind, issueDate: later.issueDate, ...terms, improves, concedes });
  }
  return out.sort((a, b) => (a.issueDate < b.issueDate ? -1 : a.issueDate > b.issueDate ? 1 : a.securityNumber < b.securityNumber ? -1 : 1));
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
export async function electMfnTerms(input: ElectMfnInput): Promise<{ amendmentId: string | null; replayed: boolean; status: GovernedStatus; requestId: string }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The election date");
  const reason = requireReason(input.reason, "the MFN election");
  if (!isUuid(input.securityId)) throw new EquityError("The SAFE does not exist.", { status: 404, code: "equity_security_unknown", remedy: "Choose a SAFE." });
  const located = await withOrgTransaction(input.orgId, async () => (await db.execute<{ subsidiary_id: string; security_number: string; currency: string; holder_name: string | null; amount: string | null }>(sql`
    select s.subsidiary_id, s.security_number, s.currency, p.display_name as holder_name, s.consideration_amount::text as amount
      from equity_securities s left join parties p on p.org_id = s.org_id and p.id = s.holder_party_id
     where s.org_id = ${input.orgId} and s.id = ${input.securityId}`)).rows[0]);
  if (!located) throw new EquityError("The SAFE does not exist.", { status: 404, code: "equity_security_unknown", remedy: "Choose a SAFE." });
  const { orgId: _org, actorId: _actor, ...payload } = input;
  const outcome = await governEquityAction({
    orgId: input.orgId, actorId: input.actorId, subsidiaryId: located.subsidiary_id, action: "mfn_election",
    subjectId: input.securityId, subjectLabel: located.security_number, effectiveOn, reason,
    summary: { securityKind: "safe", holderName: located.holder_name, amount: located.amount, currency: located.currency },
    payload, idempotencyKey: typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() !== "" ? `mfn:${input.idempotencyKey.trim()}` : null,
  }, (actorId) => applyMfnElection({ ...input, actorId }));
  return { amendmentId: outcome.result?.amendmentId ?? null, replayed: outcome.replayed || (outcome.result?.replayed ?? false), status: outcome.status, requestId: outcome.requestId };
}

/** Apply an MFN election: the command its approval releases. */
export async function applyMfnElection(input: ElectMfnInput): Promise<{ amendmentId: string; replayed: boolean }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The election date");
  const reason = requireReason(input.reason, "the MFN election");
  const idempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() !== "" ? input.idempotencyKey.trim() : null;
  const unknown = () => new EquityError("The SAFE does not exist.", { status: 404, code: "equity_security_unknown", remedy: "Choose a SAFE." });
  if (!isUuid(input.securityId)) throw unknown();
  const located = await withOrgTransaction(input.orgId, async () => (await db.execute<{ subsidiary_id: string }>(sql`
    select subsidiary_id from equity_securities where org_id = ${input.orgId} and id = ${input.securityId}`)).rows[0]);
  if (!located) throw unknown();
  return inEquityCommand({ ...input, subsidiaryId: located.subsidiary_id }, "equity.manage", async ({ book }) => {
    if (idempotencyKey) {
      const existing = (await db.execute<{ id: string; security_id: string; source_security_id: string }>(sql`
        select id, security_id, source_security_id from equity_security_amendments where org_id = ${input.orgId} and idempotency_key = ${idempotencyKey}`)).rows[0];
      if (existing) {
        if (existing.security_id !== input.securityId || existing.source_security_id !== input.sourceSecurityId) {
          throw new EquityError("This request key was already used for a different election.", { status: 409, code: "equity_idempotency_conflict", remedy: "Retry with a new request key." });
        }
        return { amendmentId: existing.id, replayed: true };
      }
    }
    await db.execute(sql`select id from equity_securities where org_id = ${input.orgId} and id = ${input.securityId} for update`);
    const security = book.securities.find((row) => row.id === input.securityId)!;
    if (security.kind !== "safe" || !security.mfn) {
      throw new EquityError(`Security ${security.securityNumber} has no most-favored-nation term.`, { code: "equity_mfn_not_applicable", remedy: "Record MFN elections only on SAFEs issued with the MFN term.", field: "securityId" });
    }
    const lifetime = convertibleState(book, security, "9999-12-31");
    if (lifetime.status !== "outstanding") {
      throw new EquityError(`Security ${security.securityNumber} is ${lifetime.status} as of ${lifetime.endedOn}; its terms can no longer change.`, {
        status: 409,
        code: "equity_mfn_closed",
        remedy: "Record an election only while the SAFE is outstanding; correct a conversion by voiding the certificate it produced first.",
      });
    }
    const latest = book.securityAmendments.filter((row) => row.securityId === security.id).map((row) => row.effectiveOn).sort().at(-1);
    if (latest && effectiveOn < latest) {
      throw new EquityError(`An MFN election or reversal on ${security.securityNumber} is already recorded from ${latest}.`, { status: 409, code: "equity_mfn_backdated", remedy: `Date the election on or after ${latest}.`, field: "effectiveOn" });
    }
    const candidate = mfnCandidates(book, security, effectiveOn).find((row) => row.sourceSecurityId === input.sourceSecurityId);
    if (!candidate) throw notBetter(book, security, input.sourceSecurityId, effectiveOn);
    const { terms: before } = effectiveConvertibleTerms(book, security, effectiveOn);
    const id = await newEquityId(db);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into equity_security_amendments (id, org_id, subsidiary_id, security_id, kind, effective_on, source_security_id,
        valuation_cap, discount_percent, safe_type, reason, idempotency_key, created_by)
      values (${id}, ${input.orgId}, ${located.subsidiary_id}, ${security.id}, 'mfn_election', ${effectiveOn}::date, ${candidate.sourceSecurityId},
        ${candidate.valuationCap}::numeric, ${candidate.discountPercent}::numeric, ${candidate.safeType}, ${reason}, ${idempotencyKey}, ${input.actorId})
      returning id`)).rows;
    if (inserted.length !== 1) throw new EquityError("The election was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_securities", rowId: security.id, action: "equity.mfn.elect", actorId: input.actorId,
      changes: {
        amendmentId: id, effectiveOn, sourceSecurityId: candidate.sourceSecurityId, sourceSecurityNumber: candidate.securityNumber,
        before: { valuationCap: before.valuationCap, discountPercent: before.discountPercent, safeType: before.safeType },
        after: { valuationCap: candidate.valuationCap, discountPercent: candidate.discountPercent, safeType: candidate.safeType },
        improves: candidate.improves, concedes: candidate.concedes, reason,
      },
    });
    return { amendmentId: id, replayed: false };
  });
}

/** Why an instrument's terms cannot be adopted on the date, with the remedy for that reason. */
function notBetter(book: EquityBook, security: SecurityRecord, sourceSecurityId: string, effectiveOn: string): EquityError {
  const refuse = (message: string, remedy: string, field: "sourceSecurityId" | "effectiveOn" = "sourceSecurityId") => new EquityError(message, { status: 409, code: "equity_mfn_not_better", remedy, field });
  const source = book.securities.find((row) => row.id === sourceSecurityId);
  if (!source || (source.kind !== "safe" && source.kind !== "note") || source.id === security.id) {
    return refuse("The instrument is not a SAFE or note of this legal entity.", "Choose a SAFE or convertible note issued after this SAFE.");
  }
  if (source.issueDate <= security.issueDate) {
    return refuse(`${source.securityNumber} was issued on ${source.issueDate}, not after ${security.securityNumber} (${security.issueDate}).`, "Choose an instrument issued after this SAFE; the MFN term covers later instruments only.");
  }
  if (source.issueDate > effectiveOn) {
    return refuse(`${source.securityNumber} was not yet issued on ${effectiveOn}.`, `Date the election on or after ${source.issueDate}, when ${source.securityNumber} was issued.`, "effectiveOn");
  }
  if (source.currency !== security.currency) {
    return refuse(`${source.securityNumber} is stated in ${source.currency}, not ${security.currency}.`, `Choose an instrument stated in ${security.currency}.`);
  }
  if (voidedSecurities(book, effectiveOn).has(source.id)) {
    return refuse(`${source.securityNumber} is void.`, "Choose an instrument that stands; a void instrument's terms were entered in error.");
  }
  const standing = electionInForce(book, security, effectiveOn);
  if (standing?.sourceSecurityId === source.id) {
    return refuse(`${security.securityNumber} already carries ${source.securityNumber}'s terms from ${standing.effectiveOn}.`, "Nothing to elect; the terms are already adopted.");
  }
  const offeredTerms = convertibleTerms(source);
  if (!offeredTerms.valuationCap && !offeredTerms.discountPercent) {
    return refuse(`${source.securityNumber} has neither a valuation cap nor a discount.`, "Choose an instrument with a cap or a discount the SAFE lacks or betters.");
  }
  return refuse(`None of ${source.securityNumber}'s terms is better than ${security.securityNumber}'s terms in force on ${effectiveOn}.`, "Choose an instrument whose cap is lower, discount higher or conversion post-money where the SAFE's is pre-money.");
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
export async function reverseMfnElection(input: ReverseMfnInput): Promise<{ amendmentId: string | null; replayed: boolean; status: GovernedStatus; requestId: string }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The reversal date");
  const reason = requireReason(input.reason, "the MFN election reversal");
  if (!isUuid(input.securityId)) throw new EquityError("The SAFE does not exist.", { status: 404, code: "equity_security_unknown", remedy: "Choose a SAFE." });
  const located = await withOrgTransaction(input.orgId, async () => (await db.execute<{ subsidiary_id: string; security_number: string; currency: string; holder_name: string | null; amount: string | null }>(sql`
    select s.subsidiary_id, s.security_number, s.currency, p.display_name as holder_name, s.consideration_amount::text as amount
      from equity_securities s left join parties p on p.org_id = s.org_id and p.id = s.holder_party_id
     where s.org_id = ${input.orgId} and s.id = ${input.securityId}`)).rows[0]);
  if (!located) throw new EquityError("The SAFE does not exist.", { status: 404, code: "equity_security_unknown", remedy: "Choose a SAFE." });
  const { orgId: _org, actorId: _actor, ...payload } = input;
  const outcome = await governEquityAction({
    orgId: input.orgId, actorId: input.actorId, subsidiaryId: located.subsidiary_id, action: "mfn_reversal",
    subjectId: input.securityId, subjectLabel: located.security_number, effectiveOn, reason,
    summary: { securityKind: "safe", holderName: located.holder_name, amount: located.amount, currency: located.currency },
    payload, idempotencyKey: typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() !== "" ? `mfn-reversal:${input.idempotencyKey.trim()}` : null,
  }, (actorId) => applyMfnReversal({ ...input, actorId }));
  return { amendmentId: outcome.result?.amendmentId ?? null, replayed: outcome.replayed || (outcome.result?.replayed ?? false), status: outcome.status, requestId: outcome.requestId };
}

/** Apply an MFN election reversal: the command its approval releases. */
export async function applyMfnReversal(input: ReverseMfnInput): Promise<{ amendmentId: string; replayed: boolean }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The reversal date");
  const reason = requireReason(input.reason, "the MFN election reversal");
  const idempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() !== "" ? input.idempotencyKey.trim() : null;
  const unknown = () => new EquityError("The SAFE does not exist.", { status: 404, code: "equity_security_unknown", remedy: "Choose a SAFE." });
  if (!isUuid(input.securityId)) throw unknown();
  const located = await withOrgTransaction(input.orgId, async () => (await db.execute<{ subsidiary_id: string }>(sql`
    select subsidiary_id from equity_securities where org_id = ${input.orgId} and id = ${input.securityId}`)).rows[0]);
  if (!located) throw unknown();
  return inEquityCommand({ ...input, subsidiaryId: located.subsidiary_id }, "equity.manage", async ({ book }) => {
    if (idempotencyKey) {
      const existing = (await db.execute<{ id: string; security_id: string; reverses_amendment_id: string | null }>(sql`
        select id, security_id, reverses_amendment_id from equity_security_amendments where org_id = ${input.orgId} and idempotency_key = ${idempotencyKey}`)).rows[0];
      if (existing) {
        if (existing.security_id !== input.securityId || existing.reverses_amendment_id !== input.amendmentId) {
          throw new EquityError("This request key was already used for a different reversal.", { status: 409, code: "equity_idempotency_conflict", remedy: "Retry with a new request key." });
        }
        return { amendmentId: existing.id, replayed: true };
      }
    }
    await db.execute(sql`select id from equity_securities where org_id = ${input.orgId} and id = ${input.securityId} for update`);
    const security = book.securities.find((row) => row.id === input.securityId)!;
    const election = book.securityAmendments.find((row) => row.id === input.amendmentId && row.securityId === security.id && row.kind === "mfn_election");
    if (!election) {
      throw new EquityError("The MFN election does not exist on this SAFE.", { status: 404, code: "equity_mfn_election_unknown", remedy: "Choose an election from the SAFE's MFN terms.", field: "amendmentId" });
    }
    if (reversedElections(book, "9999-12-31").has(election.id)) {
      throw new EquityError("The MFN election is already reversed.", { status: 409, code: "equity_mfn_reversed", remedy: "Reload the SAFE's MFN terms." });
    }
    if (effectiveOn < election.effectiveOn) {
      throw new EquityError(`The reversal cannot precede the election (${election.effectiveOn}).`, { code: "equity_date_invalid", remedy: `Date the reversal on or after ${election.effectiveOn}.`, field: "effectiveOn" });
    }
    const later = book.securityAmendments.find((row) => row.securityId === security.id && row.id !== election.id && row.effectiveOn > election.effectiveOn && row.kind === "mfn_election" && !reversedElections(book, "9999-12-31").has(row.id));
    if (later) {
      throw new EquityError(`A later MFN election on ${security.securityNumber} is recorded from ${later.effectiveOn}.`, { status: 409, code: "equity_mfn_reversal_has_dependents", remedy: `Reverse the election of ${later.effectiveOn} first, latest first.` });
    }
    const lifetime = convertibleState(book, security, "9999-12-31");
    if (lifetime.status !== "outstanding") {
      const certificate = lifetime.resultingSecurityId ? book.securities.find((row) => row.id === lifetime.resultingSecurityId) : null;
      throw new EquityError(`Security ${security.securityNumber} is ${lifetime.status} as of ${lifetime.endedOn}; its terms can no longer change.`, {
        status: 409,
        code: "equity_mfn_closed",
        remedy: certificate
          ? `Void certificate ${certificate.securityNumber}, which the conversion produced, dated ${lifetime.endedOn} (the round's closing date), to undo the conversion; then reverse the election and convert ${security.securityNumber} again.`
          : `Reverse the ${lifetime.status === "repaid" ? "repayment" : "cancellation"} first, then reverse the election.`,
      });
    }
    const latest = book.securityAmendments.filter((row) => row.securityId === security.id).map((row) => row.effectiveOn).sort().at(-1);
    if (latest && effectiveOn < latest) {
      throw new EquityError(`An MFN election or reversal on ${security.securityNumber} is already recorded from ${latest}.`, { status: 409, code: "equity_mfn_backdated", remedy: `Date the reversal on or after ${latest}.`, field: "effectiveOn" });
    }
    const { terms: before } = effectiveConvertibleTerms(book, security, effectiveOn);
    const after = effectiveConvertibleTerms({ ...book, securityAmendments: [...book.securityAmendments, { ...election, id: "pending", kind: "mfn_reversal", effectiveOn, reversesAmendmentId: election.id }] }, security, effectiveOn).terms;
    const id = await newEquityId(db);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into equity_security_amendments (id, org_id, subsidiary_id, security_id, kind, effective_on, source_security_id,
        valuation_cap, discount_percent, safe_type, reverses_amendment_id, reason, idempotency_key, created_by)
      values (${id}, ${input.orgId}, ${located.subsidiary_id}, ${security.id}, 'mfn_reversal', ${effectiveOn}::date, ${election.sourceSecurityId},
        ${after.valuationCap}::numeric, ${after.discountPercent}::numeric, ${after.safeType ?? "pre_money"}, ${election.id}, ${reason}, ${idempotencyKey}, ${input.actorId})
      returning id`)).rows;
    if (inserted.length !== 1) throw new EquityError("The reversal was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_securities", rowId: security.id, action: "equity.mfn.reverse", actorId: input.actorId,
      changes: {
        amendmentId: id, reversesAmendmentId: election.id, effectiveOn, sourceSecurityId: election.sourceSecurityId,
        before: { valuationCap: before.valuationCap, discountPercent: before.discountPercent, safeType: before.safeType },
        after: { valuationCap: after.valuationCap, discountPercent: after.discountPercent, safeType: after.safeType },
        reason,
      },
    });
    return { amendmentId: id, replayed: false };
  });
}
