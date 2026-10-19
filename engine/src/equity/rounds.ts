/**
 * Governed corrections of a recorded financing round: an amendment of its
 * terms, or its void.
 *
 * A round's terms are recorded once; a correction is a new, reasoned,
 * audited record and the round reads with its latest amendment applied.
 *  - Its name and pre-money valuation may be amended at any time; the
 *    valuation is checked against the price times the fully diluted shares
 *    before the round, or recorded with the basis it is stated on.
 *  - Its price may be amended only while no live security was issued in it
 *    or converted into it, since those were measured at the price.
 *  - A round recorded in error is voided once no live security stands in
 *    it; it then leaves every figure (the latest priced round, the exit
 *    waterfall's default, conversions) and stays in the history.
 * Both are governed actions an Equity action Flow may require approval for.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { voidedSecurities } from "./cap-table.ts";
import { EquityError } from "./errors.ts";
import { governEquityAction, type GovernedStatus } from "./governance.ts";
import { requireReason, writeEquityAudit } from "./internal.ts";
import { compareRational, parseDecimal, parsePrice, rational } from "./quantities.ts";
import { bookBeforeRound } from "./round-conversion.ts";
import { newEquityId } from "./securities.ts";
import { assertPreMoneyConsistent, inEquityCommand, optionalBasisReason, requireDate, usedRoundNames, type EquityCommand } from "./structure.ts";
import type { EquityBook, FinancingRoundRecord } from "./types.ts";

export interface AmendRoundInput extends EquityCommand {
  roundId: string;
  /** The date the amendment is recorded on. */
  effectiveOn: string;
  name?: string | null;
  pricePerShare?: string | null;
  preMoneyValuation?: string | null;
  preMoneyBasisReason?: string | null;
  reason: string;
  idempotencyKey?: string | null;
}

export interface VoidRoundInput extends EquityCommand {
  roundId: string;
  effectiveOn: string;
  reason: string;
  idempotencyKey?: string | null;
}

const unknownRound = () => new EquityError("The round does not exist.", { status: 404, code: "equity_round_unknown", remedy: "Choose a round of the legal entity.", field: "roundId" });

async function locateRound(orgId: string, roundId: string): Promise<{ subsidiaryId: string; name: string; currency: string }> {
  if (!isUuid(roundId)) throw unknownRound();
  const row = await withOrgTransaction(orgId, async () => (await db.execute<{ subsidiary_id: string; name: string; currency: string }>(sql`
    select subsidiary_id, name, currency from equity_financing_rounds where org_id = ${orgId} and id = ${roundId}`)).rows[0]);
  if (!row) throw unknownRound();
  return { subsidiaryId: row.subsidiary_id, name: row.name, currency: row.currency };
}

/** The round as amended, refusing a voided round by name. */
function liveRound(book: EquityBook, roundId: string, voided: boolean): FinancingRoundRecord {
  const round = book.rounds.find((row) => row.id === roundId);
  if (round) return round;
  if (voided) throw new EquityError("The round is void.", { status: 409, code: "equity_round_void", remedy: "Record a new round if it is still needed; a void round takes no further changes." });
  throw unknownRound();
}

/** Live securities issued in the round or converted into it. */
function liveRoundSecurities(book: EquityBook, roundId: string): { id: string; securityNumber: string }[] {
  const voided = voidedSecurities(book, "9999-12-31");
  return book.securities.filter((row) => row.roundId === roundId && !voided.has(row.id)).map((row) => ({ id: row.id, securityNumber: row.securityNumber }));
}

async function replayed(orgId: string, idempotencyKey: string | null, roundId: string, kind: "amend" | "void"): Promise<string | null> {
  if (!idempotencyKey) return null;
  const existing = (await db.execute<{ id: string; round_id: string; kind: string }>(sql`
    select id, round_id, kind from equity_round_amendments where org_id = ${orgId} and idempotency_key = ${idempotencyKey}`)).rows[0];
  if (!existing) return null;
  if (existing.round_id !== roundId || existing.kind !== kind) {
    throw new EquityError("This request key was already used for a different round change.", { status: 409, code: "equity_idempotency_conflict", remedy: "Retry with a new request key." });
  }
  return existing.id;
}

async function roundVoided(orgId: string, roundId: string): Promise<boolean> {
  return (await db.execute(sql`select 1 from equity_round_amendments where org_id = ${orgId} and round_id = ${roundId} and kind = 'void'`)).rows.length > 0;
}

const key = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/** Amend a round's name, price or pre-money valuation (equity.manage; governed). */
export async function amendRound(input: AmendRoundInput): Promise<{ id: string | null; status: GovernedStatus; requestId: string; replayed: boolean }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The amendment date");
  const reason = requireReason(input.reason, "the round amendment");
  const round = await locateRound(input.orgId, input.roundId);
  const { orgId: _org, actorId: _actor, ...payload } = input;
  const outcome = await governEquityAction({
    orgId: input.orgId, actorId: input.actorId, subsidiaryId: round.subsidiaryId, action: "round_amendment",
    subjectId: input.roundId, subjectLabel: `Round ${round.name}`, effectiveOn, reason,
    summary: { amount: key(input.preMoneyValuation), currency: round.currency },
    payload, idempotencyKey: key(input.idempotencyKey) ? `round-amend:${key(input.idempotencyKey)}` : null,
  }, (actorId) => applyRoundAmendment({ ...input, actorId }));
  return { id: outcome.result?.id ?? null, status: outcome.status, requestId: outcome.requestId, replayed: outcome.replayed || (outcome.result?.replayed ?? false) };
}

/** Apply a round amendment: the command its approval releases. */
export async function applyRoundAmendment(input: AmendRoundInput): Promise<{ id: string; replayed: boolean }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The amendment date");
  const reason = requireReason(input.reason, "the round amendment");
  const name = key(input.name);
  if (name !== null && name.length > 200) throw new EquityError("The round name is at most 200 characters.", { code: "equity_text_invalid", remedy: "Shorten the round name.", field: "name" });
  const priceText = key(input.pricePerShare);
  const preMoneyText = key(input.preMoneyValuation);
  const price = priceText ? parsePrice(priceText, "the price per share") : null;
  const preMoney = preMoneyText ? parseDecimal(preMoneyText, "the pre-money valuation", 4) : null;
  if (price && price.numerator <= 0n) throw new EquityError("The price per share must be greater than zero.", { code: "equity_round_terms_invalid", remedy: "Enter the round price per share.", field: "pricePerShare" });
  if (preMoney && compareRational(preMoney, rational(0n)) <= 0) throw new EquityError("The pre-money valuation must be greater than zero.", { code: "equity_round_terms_invalid", remedy: "Enter the pre-money valuation.", field: "preMoneyValuation" });
  const basisReason = optionalBasisReason(input.preMoneyBasisReason);
  const idempotencyKey = key(input.idempotencyKey);
  const located = await locateRound(input.orgId, input.roundId);
  return inEquityCommand({ ...input, subsidiaryId: located.subsidiaryId }, "equity.manage", async ({ book }) => {
    const existing = await replayed(input.orgId, idempotencyKey, input.roundId, "amend");
    if (existing) return { id: existing, replayed: true };
    const round = liveRound(book, input.roundId, await roundVoided(input.orgId, input.roundId));
    const changes = {
      name: name !== null && name !== round.name ? name : null,
      price: price && compareRational(price, parsePrice(round.pricePerShare, "the round price")) !== 0 ? priceText : null,
      preMoney: preMoney && compareRational(preMoney, parseDecimal(round.preMoneyValuation, "the pre-money valuation", 4)) !== 0 ? preMoneyText : null,
    };
    if (!changes.name && !changes.price && !changes.preMoney && !basisReason) {
      throw new EquityError(`Round ${round.name} already has these terms.`, { status: 409, code: "equity_amendment_unchanged", remedy: "Change the name, the price per share or the pre-money valuation." });
    }
    if (effectiveOn < round.closedOn) {
      throw new EquityError(`An amendment cannot precede the round's closing date (${round.closedOn}).`, { code: "equity_date_invalid", remedy: `Date the amendment on or after ${round.closedOn}.`, field: "effectiveOn" });
    }
    if (changes.name && (await usedRoundNames(input.orgId, located.subsidiaryId)).some((row) => row.roundId !== round.id && row.name.toLowerCase() === changes.name!.toLowerCase())) {
      throw new EquityError(`A round named ${changes.name} already exists for this legal entity, or did before it was renamed or voided.`, { status: 409, code: "equity_round_name_taken", remedy: "Choose a different round name.", field: "name" });
    }
    if (changes.price) {
      const live = liveRoundSecurities(book, round.id);
      if (live.length > 0) {
        throw new EquityError(`Round ${round.name} has issued or converted ${live.map((row) => row.securityNumber).join(", ")} at its price.`, {
          status: 409,
          code: "equity_round_has_securities",
          remedy: "Void those certificates first (each void reverses its entry), then amend the price and record them again; or record the correct round and void this one once it is empty.",
          field: "pricePerShare",
        });
      }
    }
    const nextPrice = price ?? parsePrice(round.pricePerShare, "the round price");
    const nextPreMoney = preMoney ?? parseDecimal(round.preMoneyValuation, "the pre-money valuation", 4);
    if (changes.price || changes.preMoney || basisReason) {
      assertPreMoneyConsistent(bookBeforeRound(book, round.id), {
        closedOn: round.closedOn, price: nextPrice, preMoney: nextPreMoney, currency: round.currency,
        basisReason: basisReason ?? (changes.price || changes.preMoney ? null : round.preMoneyBasisReason),
      });
    }
    const id = await newEquityId(db);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into equity_round_amendments (id, org_id, subsidiary_id, round_id, kind, effective_on, name, price_per_share, pre_money_valuation,
        pre_money_basis_reason, reason, idempotency_key, created_by)
      values (${id}, ${input.orgId}, ${located.subsidiaryId}, ${round.id}, 'amend', ${effectiveOn}::date, ${changes.name}, ${changes.price}::numeric,
        ${changes.preMoney ?? (basisReason ? preMoneyText ?? round.preMoneyValuation : null)}::numeric, ${basisReason}, ${reason}, ${idempotencyKey}, ${input.actorId})
      returning id`)).rows;
    if (inserted.length !== 1) throw new EquityError("The round amendment was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_financing_rounds", rowId: round.id, action: "equity.round.amend", actorId: input.actorId,
      changes: {
        amendmentId: id, effectiveOn,
        before: { name: round.name, pricePerShare: round.pricePerShare, preMoneyValuation: round.preMoneyValuation, preMoneyBasisReason: round.preMoneyBasisReason },
        after: { name: changes.name ?? round.name, pricePerShare: changes.price ?? round.pricePerShare, preMoneyValuation: changes.preMoney ?? round.preMoneyValuation, preMoneyBasisReason: basisReason ?? round.preMoneyBasisReason },
        reason,
      },
    });
    return { id, replayed: false };
  });
}

/** Void a round recorded in error (equity.manage; governed). */
export async function voidRound(input: VoidRoundInput): Promise<{ id: string | null; status: GovernedStatus; requestId: string; replayed: boolean }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The void date");
  const reason = requireReason(input.reason, "the round void");
  const round = await locateRound(input.orgId, input.roundId);
  const { orgId: _org, actorId: _actor, ...payload } = input;
  const outcome = await governEquityAction({
    orgId: input.orgId, actorId: input.actorId, subsidiaryId: round.subsidiaryId, action: "round_void",
    subjectId: input.roundId, subjectLabel: `Round ${round.name}`, effectiveOn, reason,
    summary: { currency: round.currency },
    payload, idempotencyKey: key(input.idempotencyKey) ? `round-void:${key(input.idempotencyKey)}` : null,
  }, (actorId) => applyRoundVoid({ ...input, actorId }));
  return { id: outcome.result?.id ?? null, status: outcome.status, requestId: outcome.requestId, replayed: outcome.replayed || (outcome.result?.replayed ?? false) };
}

/** Apply a round void: the command its approval releases. */
export async function applyRoundVoid(input: VoidRoundInput): Promise<{ id: string; replayed: boolean }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The void date");
  const reason = requireReason(input.reason, "the round void");
  const idempotencyKey = key(input.idempotencyKey);
  const located = await locateRound(input.orgId, input.roundId);
  return inEquityCommand({ ...input, subsidiaryId: located.subsidiaryId }, "equity.manage", async ({ book }) => {
    const existing = await replayed(input.orgId, idempotencyKey, input.roundId, "void");
    if (existing) return { id: existing, replayed: true };
    const round = liveRound(book, input.roundId, await roundVoided(input.orgId, input.roundId));
    if (effectiveOn < round.closedOn) {
      throw new EquityError(`The void cannot precede the round's closing date (${round.closedOn}).`, { code: "equity_date_invalid", remedy: `Date the void on or after ${round.closedOn}.`, field: "effectiveOn" });
    }
    const live = liveRoundSecurities(book, round.id);
    if (live.length > 0) {
      throw new EquityError(`Round ${round.name} still has ${live.map((row) => row.securityNumber).join(", ")} issued or converted in it.`, {
        status: 409,
        code: "equity_round_has_securities",
        remedy: "Void those certificates first (each void reverses its entry and returns a converted SAFE or note to outstanding), then void the round.",
      });
    }
    const id = await newEquityId(db);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into equity_round_amendments (id, org_id, subsidiary_id, round_id, kind, effective_on, reason, idempotency_key, created_by)
      values (${id}, ${input.orgId}, ${located.subsidiaryId}, ${round.id}, 'void', ${effectiveOn}::date, ${reason}, ${idempotencyKey}, ${input.actorId})
      returning id`)).rows;
    if (inserted.length !== 1) throw new EquityError("The round void was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_financing_rounds", rowId: round.id, action: "equity.round.void", actorId: input.actorId,
      changes: { amendmentId: id, effectiveOn, before: { status: "live", name: round.name }, after: { status: "void" }, reason },
    });
    return { id, replayed: false };
  });
}
