/**
 * The equity overview of one legal entity as of a date: its capitalization
 * and how it divides, the latest priced round, the money raised, the stock
 * compensation posted in the year, the work that needs attention and the
 * latest recorded activity. One read-only snapshot, so every figure agrees
 * with the cap table on the same date.
 */
import { sql } from "drizzle-orm";
import { toUnits } from "../money/money.ts";
import type { CatalogRefusal } from "../platform/catalog-refusal.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  buildCapTable,
  holdingState,
  vestingTermsOf,
  voidedSecurities,
  type CapTable,
} from "./cap-table.ts";
import { reviewRecordedConversion } from "./conversion-review.ts";
import type { RoundPricing } from "./round-conversion.ts";
import {
  assertEquityReadable,
  loadLegalEntity,
  requireEquityReader,
  type LegalEntity,
} from "./internal.ts";
import { equityPostingsDue, type EquityPostingsDue } from "./period-postings.ts";
import { formatPercent, rational } from "./quantities.ts";
import { earlyExerciseSource, election83bStatus } from "./restricted-stock.ts";
import { formatLedger } from "./securities.ts";
import { loadEquityBook } from "./store.ts";
import { roundPreMoneyDrift } from "./structure.ts";
import type { SecurityEventKind, SecurityKind, ShareClassKind } from "./types.ts";
import { vestingInstallments } from "./vesting.ts";

/** Upcoming cliffs and 83(b) deadlines are listed this many days ahead. */
export const EQUITY_ATTENTION_DAYS = 30;
/** Option and warrant expirations are listed this many days ahead. */
export const EQUITY_EXPIRY_DAYS = 60;

/** One slice of the fully diluted capitalization. The slices sum to the fully diluted total. */
export interface OwnershipSlice {
  key: string;
  group: "class" | "option" | "rsu" | "warrant" | "pool";
  shareClassId: string | null;
  code: string | null;
  name: string | null;
  classKind: ShareClassKind | null;
  shares: string;
  percent: string;
}

export type EquityAttention =
  | {
      kind: "cliff";
      securityId: string;
      securityNumber: string;
      securityKind: SecurityKind;
      holderName: string;
      date: string;
      quantity: string;
    }
  | {
      kind: "election_83b";
      securityId: string;
      securityNumber: string;
      holderName: string;
      date: string;
      daysLeft: number;
    }
  | {
      kind: "restricted_deposit";
      securityId: string;
      securityNumber: string;
      holderName: string;
      shares: string;
    }
  | {
      kind: "departed";
      holderPartyId: string;
      holderName: string;
      date: string;
      units: string;
      securityId: string;
    }
  | {
      kind: "expiring";
      securityId: string;
      securityNumber: string;
      securityKind: SecurityKind;
      holderName: string;
      date: string;
      quantity: string;
    }
  | {
      kind: "conversion_terms_void";
      securityId: string;
      securityNumber: string;
      holderName: string;
      sourceSecurityNumber: string;
      certificateId: string | null;
      certificateNumber: string | null;
    }
  | {
      kind: "round_pre_money_drift";
      roundId: string;
      roundName: string;
      date: string;
      preMoneyValuation: string;
      impliedPreMoney: string;
      fullyDilutedBefore: string;
      currency: string;
    }
  | {
      kind: "conversion_price_drift";
      securityId: string;
      securityNumber: string;
      holderName: string;
      roundId: string;
      roundName: string;
      date: string;
      currency: string;
      recordedPrice: string;
      standingPrice: string;
      recordedShares: string;
      standingShares: string;
      certificateId: string | null;
      certificateNumber: string | null;
    }
  | {
      kind: "compensation_due";
      date: string;
      amount: string;
      currency: string;
      refusal: CatalogRefusal | null;
    }
  | {
      kind: "compensation_catch_up";
      date: string;
      amount: string;
      currency: string;
      postsThrough: string | null;
      postsNow: boolean;
    }
  | {
      kind: "interest_catch_up";
      date: string;
      amount: string;
      currency: string;
      postsThrough: string | null;
      postsNow: boolean;
    }
  | {
      kind: "interest_due";
      date: string;
      amount: string;
      currency: string;
      refusal: CatalogRefusal | null;
    };

export interface EquityActivity {
  key: string;
  date: string;
  kind: "issue" | "round" | SecurityEventKind;
  securityId: string | null;
  securityNumber: string | null;
  securityKind: SecurityKind | null;
  holderName: string | null;
  /** A round's name. */
  label: string | null;
  quantity: string | null;
  /** A convertible's principal, an event's amount, or a round's price per share. */
  amount: string | null;
  currency: string | null;
}

export interface EquityOverview {
  entity: LegalEntity;
  asOf: string;
  totals: CapTable["totals"];
  holders: number;
  ownership: OwnershipSlice[];
  latestRound: {
    id: string;
    name: string;
    closedOn: string;
    pricePerShare: string;
    preMoneyValuation: string;
    raised: string;
    postMoneyValuation: string;
    currency: string;
  } | null;
  /** Money raised from investors through the date, per currency: priced-round shares and convertible instruments. */
  raised: { currency: string; priced: string; convertible: string; total: string }[];
  convertiblesOutstanding: number;
  /** Stock compensation posted by runs dated from `from` through the as-of date. */
  compensationPosted: { from: string; amount: string; currency: string };
  /** The periodic runs through the latest accounting period end on or before the date (null with no period). */
  postings: EquityPostingsDue | null;
  attention: EquityAttention[];
  activity: EquityActivity[];
}

const RECENT_ACTIVITY = 8;

/** The overview of a legal entity's equity as of a date (equity.read). */
export async function loadEquityOverview(input: {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  asOf: string;
  yearStart: string;
}): Promise<EquityOverview> {
  await assertEquityReadable(input.orgId);
  return withOrgTransaction(
    input.orgId,
    async () => {
      await requireEquityReader(db, input.orgId, input.actorId, input.subsidiaryId);
      const { orgId, subsidiaryId, asOf } = input;
      const entity = await loadLegalEntity(db, orgId, subsidiaryId);
      const book = await loadEquityBook(db, orgId, subsidiaryId);
      const table = buildCapTable(book, asOf);
      const fullyDiluted = BigInt(table.totals.fullyDiluted);
      const percent = (shares: bigint): string =>
        fullyDiluted > 0n ? formatPercent(rational(shares, fullyDiluted)) : "0.0000";

      const awardShares = { option: 0n, rsu: 0n, warrant: 0n };
      for (const holding of table.holdings) {
        if (holding.kind === "option" || holding.kind === "rsu" || holding.kind === "warrant")
          awardShares[holding.kind] += BigInt(holding.asConverted);
      }
      const ownership: OwnershipSlice[] = [
        ...table.classes
          .filter((row) => BigInt(row.asConvertedOutstanding) > 0n)
          .map((row): OwnershipSlice => ({
            key: `class:${row.shareClassId}`,
            group: "class",
            shareClassId: row.shareClassId,
            code: row.code,
            name: row.name,
            classKind: row.kind,
            shares: row.asConvertedOutstanding,
            percent: percent(BigInt(row.asConvertedOutstanding)),
          })),
        ...(["option", "rsu", "warrant"] as const)
          .filter((kind) => awardShares[kind] > 0n)
          .map((kind): OwnershipSlice => ({
            key: kind,
            group: kind,
            shareClassId: null,
            code: null,
            name: null,
            classKind: null,
            shares: awardShares[kind].toString(),
            percent: percent(awardShares[kind]),
          })),
        ...(BigInt(table.totals.poolAvailable) > 0n
          ? [
              {
                key: "pool",
                group: "pool" as const,
                shareClassId: null,
                code: null,
                name: null,
                classKind: null,
                shares: table.totals.poolAvailable,
                percent: percent(BigInt(table.totals.poolAvailable)),
              },
            ]
          : []),
      ];

      const voided = voidedSecurities(book, asOf);
      const issued = book.securities.filter((row) => row.issueDate <= asOf);
      const raisedBy = new Map<string, { priced: bigint; convertible: bigint }>();
      const raise = (currency: string, field: "priced" | "convertible", amount: string | null) => {
        if (!amount) return;
        const row = raisedBy.get(currency) ?? { priced: 0n, convertible: 0n };
        row[field] += toUnits(amount);
        raisedBy.set(currency, row);
      };
      for (const security of issued) {
        if (voided.has(security.id)) continue;
        if (security.kind === "share" && security.roundId && !security.sourceSecurityId)
          raise(security.currency, "priced", security.considerationAmount);
        if (security.kind === "safe" || security.kind === "note")
          raise(security.currency, "convertible", security.considerationAmount);
      }
      const raised = [...raisedBy.entries()]
        .sort(([a], [b]) =>
          a === entity.currency ? -1 : b === entity.currency ? 1 : a < b ? -1 : 1,
        )
        .map(([currency, row]) => ({
          currency,
          priced: formatLedger(row.priced),
          convertible: formatLedger(row.convertible),
          total: formatLedger(row.priced + row.convertible),
        }));

      const closed = book.rounds
        .filter((round) => round.closedOn <= asOf)
        .sort((a, b) => (a.closedOn < b.closedOn ? 1 : a.closedOn > b.closedOn ? -1 : 0));
      const last = closed[0] ?? null;
      let latestRound: EquityOverview["latestRound"] = null;
      if (last) {
        let units = 0n;
        for (const security of issued) {
          if (
            security.kind === "share" &&
            security.roundId === last.id &&
            !security.sourceSecurityId &&
            !voided.has(security.id) &&
            security.considerationAmount
          )
            units += toUnits(security.considerationAmount);
        }
        latestRound = {
          id: last.id,
          name: last.name,
          closedOn: last.closedOn,
          pricePerShare: last.pricePerShare,
          preMoneyValuation: last.preMoneyValuation,
          raised: formatLedger(units),
          postMoneyValuation: formatLedger(toUnits(last.preMoneyValuation) + units),
          currency: last.currency,
        };
      }

      const posted =
        (
          await db.execute<{ amount: string | null }>(
            sql`
      select sum(total_amount)::text as amount from equity_compensation_runs
       where org_id = ${orgId} and subsidiary_id = ${subsidiaryId}
         and through_date between ${input.yearStart}::date and ${asOf}::date`,
            "objects",
          )
        )[0]?.amount ?? null;

      const periodEnd =
        (
          await db.execute<{ ends_on: string | null }>(
            sql`
      select max(ends_on)::text as ends_on from accounting_periods
       where org_id = ${orgId} and not is_adjustment and ends_on <= ${asOf}::date`,
            "objects",
          )
        )[0]?.ends_on ?? null;
      const postings =
        periodEnd && issued.length > 0
          ? await equityPostingsDue(orgId, subsidiaryId, entity.currency, periodEnd)
          : null;

      const holderIds = [...new Set(book.securities.map((row) => row.holderPartyId))];
      const names = new Map<string, string>();
      const departures = new Map<string, string>();
      if (holderIds.length > 0) {
        const list = `{${holderIds.join(",")}}`;
        for (const row of await db.execute<{ id: string; display_name: string }>(
          sql`
        select id, display_name from parties where org_id = ${orgId} and id = any(${list}::uuid[])`,
          "objects",
        ))
          names.set(row.id, row.display_name);
        for (const row of await db.execute<{ party_id: string; terminated_on: string }>(
          sql`
        select party_id, terminated_on::text as terminated_on from employee_roles
         where org_id = ${orgId} and party_id = any(${list}::uuid[]) and terminated_on is not null and terminated_on <= ${asOf}::date`,
          "objects",
        )) {
          departures.set(row.party_id, row.terminated_on);
        }
      }
      const nameOf = (partyId: string): string => names.get(partyId) ?? "";

      const attention: EquityAttention[] = [];
      const soon = addCalendarDays(asOf, EQUITY_ATTENTION_DAYS);
      const expiryHorizon = addCalendarDays(asOf, EQUITY_EXPIRY_DAYS);
      const departedUnits = new Map<string, { units: bigint; securityId: string }>();
      for (const security of issued) {
        if (security.quantity === null) continue;
        const state = holdingState(book, security, asOf);
        if (state.outstanding === 0n || state.status !== "outstanding") continue;
        if ((security.cliffMonths ?? 0) > 0 && (security.vestingMonths ?? 0) > 0) {
          const cliff = vestingInstallments(vestingTermsOf(security))[0];
          if (cliff && cliff.date > asOf && cliff.date <= soon) {
            attention.push({
              kind: "cliff",
              securityId: security.id,
              securityNumber: security.securityNumber,
              securityKind: security.kind,
              holderName: nameOf(security.holderPartyId),
              date: cliff.date,
              quantity: cliff.quantity.toString(),
            });
          }
        }
        const election = election83bStatus(book, security, asOf);
        if (election?.state === "open") {
          attention.push({
            kind: "election_83b",
            securityId: security.id,
            securityNumber: security.securityNumber,
            holderName: nameOf(security.holderPartyId),
            date: election.deadline,
            daysLeft: election.daysLeft ?? 0,
          });
        }
        if (earlyExerciseSource(book, security)) {
          const unvested = state.unvested;
          if (unvested > 0n)
            attention.push({
              kind: "restricted_deposit",
              securityId: security.id,
              securityNumber: security.securityNumber,
              holderName: nameOf(security.holderPartyId),
              shares: unvested.toString(),
            });
        }
        if (
          (security.kind === "option" || security.kind === "warrant") &&
          security.expirationDate &&
          security.expirationDate >= asOf &&
          security.expirationDate <= expiryHorizon
        ) {
          attention.push({
            kind: "expiring",
            securityId: security.id,
            securityNumber: security.securityNumber,
            securityKind: security.kind,
            holderName: nameOf(security.holderPartyId),
            date: security.expirationDate,
            quantity: state.outstanding.toString(),
          });
        }
        if (
          (security.kind === "option" || security.kind === "rsu") &&
          departures.has(security.holderPartyId)
        ) {
          const row = departedUnits.get(security.holderPartyId) ?? {
            units: 0n,
            securityId: security.id,
          };
          row.units += state.outstanding;
          departedUnits.set(security.holderPartyId, row);
        }
      }
      // A SAFE converted on terms an MFN election adopted from an instrument since voided, and
      // a conversion on its own terms that the round now measures at another price.
      const numberOf = new Map(book.securities.map((row) => [row.id, row.securityNumber]));
      const pricing = new Map<string, RoundPricing>();
      for (const security of issued) {
        if (security.kind !== "safe" && security.kind !== "note") continue;
        const review = await reviewRecordedConversion(
          db,
          orgId,
          book,
          security,
          asOf,
          entity.currency,
          pricing,
        );
        if (review?.voidedTerms) {
          const invalid = review.voidedTerms;
          attention.push({
            kind: "conversion_terms_void",
            securityId: security.id,
            securityNumber: security.securityNumber,
            holderName: nameOf(security.holderPartyId),
            sourceSecurityNumber: numberOf.get(invalid.sourceSecurityId) ?? "",
            certificateId: invalid.resultingSecurityId,
            certificateNumber: invalid.resultingSecurityId
              ? (numberOf.get(invalid.resultingSecurityId) ?? null)
              : null,
          });
        }
        if (review?.drift) {
          const drift = review.drift;
          const round = book.rounds.find((row) => row.id === drift.roundId)!;
          attention.push({
            kind: "conversion_price_drift",
            securityId: security.id,
            securityNumber: security.securityNumber,
            holderName: nameOf(security.holderPartyId),
            roundId: round.id,
            roundName: round.name,
            date: drift.convertedOn,
            currency: round.currency,
            recordedPrice: drift.recordedPrice,
            standingPrice: drift.standingPrice,
            recordedShares: drift.recordedShares,
            standingShares: drift.standingShares,
            certificateId: drift.resultingSecurityId,
            certificateNumber: drift.resultingSecurityId
              ? (numberOf.get(drift.resultingSecurityId) ?? null)
              : null,
          });
        }
      }
      // A round whose pre-money no longer agrees with its price and the shares before it, as later backdated activity reads them.
      for (const round of book.rounds) {
        if (round.closedOn > asOf) continue;
        const drift = roundPreMoneyDrift(book, round);
        if (!drift) continue;
        attention.push({
          kind: "round_pre_money_drift",
          roundId: round.id,
          roundName: round.name,
          date: round.closedOn,
          preMoneyValuation: round.preMoneyValuation,
          impliedPreMoney: drift.impliedPreMoney,
          fullyDilutedBefore: drift.fullyDilutedBefore,
          currency: round.currency,
        });
      }
      for (const [holderPartyId, row] of departedUnits) {
        attention.push({
          kind: "departed",
          holderPartyId,
          holderName: nameOf(holderPartyId),
          date: departures.get(holderPartyId)!,
          units: row.units.toString(),
          securityId: row.securityId,
        });
      }
      if (postings?.compensation.due) {
        attention.push({
          kind: "compensation_due",
          date: postings.throughDate,
          amount: postings.compensation.amount,
          currency: postings.compensation.currency,
          refusal: postings.compensation.refusal,
        });
      }
      if (postings?.interest.due) {
        attention.push({
          kind: "interest_due",
          date: postings.throughDate,
          amount: postings.interest.amount,
          currency: postings.interest.currency,
          refusal: postings.interest.refusal,
        });
      }
      // Cost or interest recorded after a posted run for the periods it measured: the next run catches it up.
      for (const [kind, due] of [
        ["compensation_catch_up", postings?.compensation],
        ["interest_catch_up", postings?.interest],
      ] as const) {
        const late = due?.catchUp;
        if (!late) continue;
        attention.push({
          kind,
          date: late.recognizedThrough,
          amount: late.amount,
          currency: late.currency,
          postsThrough: late.postsWith?.endsOn ?? null,
          postsNow: late.postsWith?.ended ?? false,
        });
      }
      // A conversion on terms that no longer stand misstates the cap table, so it leads.
      const urgency = (item: EquityAttention): string =>
        item.kind === "conversion_terms_void"
          ? "0000-01-01"
          : "date" in item
            ? item.date
            : "9999-12-31";
      attention.sort((a, b) => (urgency(a) < urgency(b) ? -1 : urgency(a) > urgency(b) ? 1 : 0));

      const securityById = new Map(book.securities.map((row) => [row.id, row]));
      const activity: EquityActivity[] = [
        ...issued.map((security): EquityActivity => ({
          key: `issue:${security.id}`,
          date: security.issueDate,
          kind: "issue",
          securityId: security.id,
          securityNumber: security.securityNumber,
          securityKind: security.kind,
          holderName: nameOf(security.holderPartyId),
          label: null,
          quantity: security.quantity?.toString() ?? null,
          amount:
            security.kind === "safe" || security.kind === "note"
              ? security.considerationAmount
              : null,
          currency: security.currency,
        })),
        ...book.events
          .filter((event) => event.effectiveOn <= asOf)
          .map((event): EquityActivity => {
            const security = securityById.get(event.securityId);
            return {
              key: `event:${event.id}`,
              date: event.effectiveOn,
              kind: event.kind,
              securityId: event.securityId,
              securityNumber: security?.securityNumber ?? null,
              securityKind: security?.kind ?? null,
              holderName: security ? nameOf(security.holderPartyId) : null,
              label: null,
              quantity: event.quantity?.toString() ?? null,
              amount: event.amount,
              currency: security?.currency ?? null,
            };
          }),
        ...closed.map((round): EquityActivity => ({
          key: `round:${round.id}`,
          date: round.closedOn,
          kind: "round",
          securityId: null,
          securityNumber: null,
          securityKind: null,
          holderName: null,
          label: round.name,
          quantity: null,
          amount: round.pricePerShare,
          currency: round.currency,
        })),
      ]
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.key < b.key ? -1 : 1))
        .slice(0, RECENT_ACTIVITY);

      return {
        entity,
        asOf,
        totals: table.totals,
        holders: table.holders.length,
        ownership,
        latestRound,
        raised,
        convertiblesOutstanding: table.convertibles.filter((row) => row.status === "outstanding")
          .length,
        compensationPosted: {
          from: input.yearStart,
          amount: formatLedger(posted ? toUnits(posted) : 0n),
          currency: entity.currency,
        },
        postings,
        attention,
        activity,
      };
    },
    { isolationLevel: "REPEATABLE READ", readOnly: true },
  );
}
