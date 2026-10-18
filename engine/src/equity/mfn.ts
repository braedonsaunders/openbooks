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
 * together; a later note converts pre-money. Elections are approvals
 * (equity.approve), dated, reasoned and audited, and take effect from their
 * date: a conversion on or after that date converts on the adopted terms,
 * and nothing dated earlier is reinterpreted. A later instrument is compared
 * with the terms in force on the election date, in the SAFE's own currency.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { convertibleState, convertibleTerms, effectiveConvertibleTerms, voidedSecurities } from "./cap-table.ts";
import type { ConvertibleTerms } from "./convertibles.ts";
import { EquityError } from "./errors.ts";
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
  const discount = (value: string | null) => (value ? parsePercent(value, "the discount") : null);
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
  const adopted = new Set(book.securityAmendments.filter((row) => row.securityId === security.id).map((row) => row.sourceSecurityId));
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

/** Record an MFN SAFE holder's election to adopt a later instrument's terms (equity.approve). */
export async function electMfnTerms(input: ElectMfnInput): Promise<{ amendmentId: string; replayed: boolean }> {
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The election date");
  const reason = requireReason(input.reason, "the MFN election");
  const idempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() !== "" ? input.idempotencyKey.trim() : null;
  const unknown = () => new EquityError("The SAFE does not exist.", { status: 404, code: "equity_security_unknown", remedy: "Choose a SAFE." });
  if (!isUuid(input.securityId)) throw unknown();
  const located = await withOrgTransaction(input.orgId, async () => (await db.execute<{ subsidiary_id: string }>(sql`
    select subsidiary_id from equity_securities where org_id = ${input.orgId} and id = ${input.securityId}`)).rows[0]);
  if (!located) throw unknown();
  return inEquityCommand({ ...input, subsidiaryId: located.subsidiary_id }, "equity.approve", async ({ book }) => {
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
      throw new EquityError(`An MFN election on ${security.securityNumber} is already effective from ${latest}.`, { status: 409, code: "equity_mfn_backdated", remedy: `Date the election on or after ${latest}.`, field: "effectiveOn" });
    }
    const candidate = mfnCandidates(book, security, effectiveOn).find((row) => row.sourceSecurityId === input.sourceSecurityId);
    if (!candidate) {
      throw new EquityError("That instrument's terms are not better than the SAFE's on the election date.", {
        status: 409,
        code: "equity_mfn_not_better",
        remedy: "Choose an instrument issued after the SAFE, in its currency and on or before the election date, whose cap, discount or post-money conversion is better than the terms in force.",
        field: "sourceSecurityId",
      });
    }
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
