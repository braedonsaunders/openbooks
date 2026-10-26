/**
 * Settling a SAFE or convertible note: conversion in a round, repayment or
 * cancellation.
 *
 * A settlement relieves exactly what the ledger carries for the instrument:
 *  - the principal, as its issuance entry credited it (account, currency and
 *    rate of that line);
 *  - for a note, the accrued interest, read back from every equity line
 *    identified with the note. Interest accrued since the last interest run
 *    is accrued first, on the settlement date, by its own entry
 *    (Dr interest expense / Cr accrued interest), so the note settles
 *    principal plus interest accrued to that date, to the minor unit.
 * The credits are measured at the settlement value: the carrying amount
 * remeasured at the settlement-date spot rate (an equity-classified SAFE
 * keeps its historical measurement). Any difference against the historical
 * measurement is a realized exchange difference. Instruments in the
 * functional currency have none.
 */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { effectiveConvertibleTerms } from "./cap-table.ts";
import { equityError, fig } from "./errors.ts";
import { functionalUnits, spotRate } from "./fx.ts";
import { noteInterest } from "./interest.ts";
import { currencyExponent } from "./internal.ts";
import {
  instrumentBalance,
  isEquityAccount,
  postEquityEntry,
  realizedFxAccount,
  requirePolicyAccount,
  resolveAccountPolicy,
  type EquityLeg,
} from "./posting.ts";
import { ledgerUnits } from "./quantities.ts";
import type { EquityBook, SecurityRecord } from "./types.ts";

export interface Settlement {
  /** Debits relieving the principal and accrued interest, and the realized exchange difference if any. */
  legs: EquityLeg[];
  /** Functional ledger units the settlement's credits total. */
  settlementUnits: bigint;
  /** Principal and accrued interest in the instrument's currency (ledger units). */
  principalTxnUnits: bigint;
  interestTxnUnits: bigint;
  /** Spot rate of the instrument's currency on the settlement date. */
  fxRate: string;
  /** Interest accrued from the last run to the settlement date. */
  accrual: { txnUnits: bigint; functionalUnits: bigint; entryId: string | null } | null;
}

/**
 * Interest a note has accrued on the ledger, in its own currency: run lines
 * and settlement accruals. With `asOf`, only runs through that date and
 * settlements dated on or before it count.
 */
export async function accruedToDate(
  orgId: string,
  securityId: string,
  asOf?: string | null,
): Promise<bigint> {
  const row = (
    await db.execute<{ runs: string; events: string }>(
      sql`
    select coalesce((select sum(l.period_amount) from equity_interest_run_lines l
                      join equity_interest_runs r on r.org_id = l.org_id and r.id = l.run_id
                     where l.org_id = ${orgId} and l.security_id = ${securityId}
                       ${asOf ? sql`and r.through_date <= ${asOf}::date` : sql``}), 0)::text as runs,
           coalesce((select sum(e.interest_accrued_amount) from equity_security_events e
                     where e.org_id = ${orgId} and e.security_id = ${securityId}
                       ${asOf ? sql`and e.effective_on <= ${asOf}::date` : sql``}
                       and not exists (select 1 from equity_security_events r where r.org_id = e.org_id and r.kind = 'reverse' and r.reverses_event_id = e.id)
                       and not exists (select 1 from equity_security_events v where v.org_id = e.org_id and v.kind = 'void' and v.security_id = e.resulting_security_id)), 0)::text as events`,
      "objects",
    )
  )[0];
  return toUnits(row?.runs ?? "0") + toUnits(row?.events ?? "0");
}

/** The credit the issuance posted to the convertible instruments account of the policy in force on the issue date. */
async function principalLine(
  orgId: string,
  subsidiaryId: string,
  security: SecurityRecord,
): Promise<{
  accountId: string;
  currency: string;
  fxRate: string;
  units: bigint;
  txnUnits: bigint;
}> {
  const issuedUnder = await resolveAccountPolicy(db, orgId, subsidiaryId, security.issueDate);
  const rows = await db.execute<{
    account_id: string;
    currency: string;
    fx_rate: string;
    amount: string;
    txn_amount: string;
  }>(
    sql`
    select l.account_id, l.currency, l.fx_rate::text as fx_rate, l.amount::text as amount, l.txn_amount::text as txn_amount
      from equity_securities s
      join journal_lines l on l.org_id = s.org_id and l.entry_id = s.journal_entry_id
     where s.org_id = ${orgId} and s.id = ${security.id} and l.amount < 0
       and l.account_id = ${issuedUnder.convertibleInstrumentsAccountId}`,
    "objects",
  );
  if (rows.length !== 1) {
    throw equityError("issuanceEntryUnknown", { security: fig.text(security.securityNumber) });
  }
  const row = rows[0]!;
  return {
    accountId: row.account_id,
    currency: row.currency,
    fxRate: row.fx_rate,
    units: -toUnits(row.amount),
    txnUnits: -toUnits(row.txn_amount),
  };
}

/**
 * Accrue a note's interest to `on` and build the legs that relieve the
 * instrument. Posts the accrual entry; the caller posts the settlement.
 */
export async function settleConvertible(input: {
  orgId: string;
  subsidiaryId: string;
  actorId: string;
  book: EquityBook;
  security: SecurityRecord;
  on: string;
  functional: string;
  eventId: string;
}): Promise<Settlement> {
  const { security, on, functional } = input;
  const exponent = await currencyExponent(db, security.currency);
  const fxRate = await spotRate(db, input.orgId, security.currency, functional, on, functional);
  const principal = await principalLine(input.orgId, input.subsidiaryId, security);
  const legs: EquityLeg[] = [
    {
      accountId: principal.accountId,
      units: principal.units,
      foreign: {
        currency: principal.currency,
        txnUnits: principal.txnUnits,
        fxRate: principal.fxRate,
      },
    },
  ];
  let interestTxnUnits = 0n;
  let accrual: Settlement["accrual"] = null;
  let interestHistorical = 0n;
  if (security.kind === "note") {
    const { terms } = effectiveConvertibleTerms(input.book, security, on);
    interestTxnUnits = ledgerUnits(noteInterest(terms, on), exponent);
    const accrued = await accruedToDate(input.orgId, security.id);
    const stub = interestTxnUnits - accrued;
    if (stub !== 0n) {
      const policy = await resolveAccountPolicy(db, input.orgId, input.subsidiaryId, on);
      const stubFunctional = functionalUnits(stub, fxRate);
      const entryId = await postEquityEntry(db, {
        orgId: input.orgId,
        subsidiaryId: input.subsidiaryId,
        currency: functional,
        postingDate: on,
        entryNumberBase: `EQ-${security.securityNumber}-INT`,
        memo: `Interest on ${security.securityNumber} to ${on}`,
        idempotencyKey: `equity:event:${input.eventId}:accrual`,
        actorId: input.actorId,
        auditAction: "equity.interest",
        auditChanges: {
          securityId: security.id,
          eventId: input.eventId,
          interest: stub.toString(),
        },
        legs: [
          {
            accountId: requirePolicyAccount(policy, "interestExpenseAccountId"),
            units: stubFunctional,
          },
          {
            accountId: requirePolicyAccount(policy, "accruedInterestAccountId"),
            units: -stubFunctional,
            foreign: { currency: security.currency, txnUnits: -stub, fxRate },
            balance: { securityId: security.id, role: "interest" },
          },
        ],
      });
      accrual = { txnUnits: stub, functionalUnits: stubFunctional, entryId };
    }
    const groups = await instrumentBalance(
      db,
      input.orgId,
      input.subsidiaryId,
      security.id,
      "interest",
    );
    const carried = groups.reduce((sum, group) => sum - group.txnUnits, 0n);
    if (
      carried !== interestTxnUnits ||
      groups.some((group) => group.currency !== security.currency)
    ) {
      throw equityError("interestUnreconciled", {
        carried: fig.money(fromUnits(carried), security.currency),
        accrued: fig.money(fromUnits(interestTxnUnits), security.currency),
        security: fig.text(security.securityNumber),
        date: fig.date(on),
      });
    }
    for (const group of groups) {
      legs.push({
        accountId: group.accountId,
        units: -group.units,
        foreign: { currency: group.currency, txnUnits: -group.txnUnits, fxRate: group.fxRate },
        balance: { securityId: security.id, role: "interest" },
      });
      interestHistorical -= group.units;
    }
  }
  const remeasurePrincipal =
    security.currency !== functional &&
    !(await isEquityAccount(db, input.orgId, principal.accountId));
  const principalSettlement = remeasurePrincipal
    ? functionalUnits(principal.txnUnits, fxRate)
    : principal.units;
  const interestSettlement = functionalUnits(interestTxnUnits, fxRate);
  const settlementUnits = principalSettlement + interestSettlement;
  const difference = settlementUnits - (principal.units + interestHistorical);
  if (difference !== 0n) {
    legs.push({
      accountId: await realizedFxAccount(db, input.orgId),
      units: difference,
      memo: `Realized exchange difference on ${security.securityNumber}`,
    });
  }
  return {
    legs,
    settlementUnits,
    principalTxnUnits: principal.txnUnits,
    interestTxnUnits,
    fxRate,
    accrual,
  };
}
