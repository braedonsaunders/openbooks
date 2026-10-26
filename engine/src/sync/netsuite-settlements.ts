import { fromUnits, toUnits } from "../money/money.ts";
import { netSuiteCurrencyIso } from "./netsuite-native.ts";
import {
  applicationLinksDigest,
  settlementDigest,
  type SettlementObservation,
  type SettlementExclusion,
} from "./settlement-observation.ts";
import type { SourceApplicationLink } from "./source.ts";

export interface NsApplicationLink {
  previousdoc: string;
  previousline: string;
  nextdoc: string;
  nextline: string;
  foreignamount: string;
  payaccount?: string | null;
  appaccount?: string | null;
  payposting?: string | null;
  appposting?: string | null;
  paystatus?: string | null;
  appstatus?: string | null;
  paymodified?: string | null;
  appmodified?: string | null;
  /**
   * The PAYING transaction's currency display value
   * (`BUILTIN.DF(t.currency)` — the denomination of foreignamount). Raw ids
   * resolve through the same alias/ISO rule the document builder uses.
   */
  paycurrency?: string | null;
  /** The PAYING transaction's exchange rate (transaction→base). */
  payexrate?: string | null;
}

/** Enforce a stable application-link identity across governed export retries. */
export function uniqueNetSuiteApplicationLinks(rows: NsApplicationLink[]): NsApplicationLink[] {
  const unique = new Map<string, { digest: string; row: NsApplicationLink }>();
  for (const row of rows) {
    const key = `${row.previousdoc}:${row.previousline}:${row.nextdoc}:${row.nextline}`;
    const prior = unique.get(key);
    if (prior) {
      if (prior.digest !== settlementDigest(row)) {
        throw new Error(`NetSuite returned conflicting application link ${key}`);
      }
      continue;
    }
    unique.set(key, {
      digest: settlementDigest(row),
      row,
    });
  }
  return [...unique.values()].map(({ row }) => row);
}

type Query = <T>(query: string) => Promise<T[]>;

/** Read workflow links first; only positively posted endpoints admit settlement. */
export async function readNetSuiteSettlements(
  query: Query,
  options: { sourceAccount: string; bookRef: string; baseCurrency: string; refs?: string[] },
): Promise<{
  applications: SourceApplicationLink[];
  observation: SettlementObservation;
  payerDigests: Map<string, string>;
}> {
  if (
    !options.sourceAccount.trim() ||
    !/^\d+$/.test(options.bookRef) ||
    (options.refs && (!options.refs.length || options.refs.some((ref) => !/^\d+$/.test(ref))))
  ) {
    throw new Error("NetSuite settlement source account, book, or reference scope is invalid");
  }
  const refs = options.refs ? [...new Set(options.refs)].sort() : undefined;
  const scoped = refs
    ? ` AND (${Array.from({ length: Math.ceil(refs.length / 150) }, (_, index) => {
        const ids = refs.slice(index * 150, (index + 1) * 150).join(",");
        return `n.nextdoc IN (${ids}) OR n.previousdoc IN (${ids})`;
      }).join(" OR ")})`
    : "";
  const predicate = `n.linktype='Payment'${scoped}`;
  const countQuery = `SELECT COUNT(*) AS n FROM nexttransactionlinelink n WHERE ${predicate}`;
  const rowsQuery = `SELECT n.previousdoc,n.previousline,n.nextdoc,n.nextline,n.foreignamount,
    BUILTIN.DF(t.currency) AS paycurrency,t.exchangerate AS payexrate,
    t.posting AS payposting,p.posting AS appposting,t.status AS paystatus,p.status AS appstatus,
    TO_CHAR(t.lastmodifieddate,'YYYY-MM-DD HH24:MI:SS') AS paymodified,
    TO_CHAR(p.lastmodifieddate,'YYYY-MM-DD HH24:MI:SS') AS appmodified,
    payline.account AS payaccount,appline.account AS appaccount
    FROM nexttransactionlinelink n
    LEFT JOIN transaction t ON t.id=n.nextdoc
    LEFT JOIN transaction p ON p.id=n.previousdoc
    LEFT JOIN transactionaccountingline payline
      ON payline.transaction=n.nextdoc AND payline.transactionline=n.nextline
     AND payline.accountingbook=${options.bookRef} AND payline.posting='T'
    LEFT JOIN transactionaccountingline appline
      ON appline.transaction=n.previousdoc AND appline.transactionline=n.previousline
     AND appline.accountingbook=${options.bookRef} AND appline.posting='T'
    WHERE ${predicate}
    ORDER BY n.previousdoc,n.previousline,n.nextdoc,n.nextline`;
  const readCount = async () => {
    const rows = await query<{ n: string | number }>(countQuery);
    const stated = rows[0]?.n;
    const count = Number(stated);
    if (
      rows.length !== 1 ||
      (typeof stated !== "number" && (typeof stated !== "string" || !/^\d+$/.test(stated))) ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw new Error(
        "NetSuite application graph count is unavailable; settlements were not reconciled",
      );
    }
    return count;
  };
  const observedFrom = new Date().toISOString();
  const count = await readCount();
  const readRows = async () => {
    const rows = await query<NsApplicationLink>(rowsQuery);
    if (rows.length !== count || uniqueNetSuiteApplicationLinks(rows).length !== count) {
      throw new Error(
        "NetSuite application graph is incomplete or changed during reading; settlements were not reconciled",
      );
    }
    return rows;
  };
  const rows = await readRows();
  const graphDigest = settlementDigest(rows);
  // Cardinality cannot detect same-count edits to amounts, accounts, or lifecycle.
  if (settlementDigest(await readRows()) !== graphDigest || (await readCount()) !== count) {
    throw new Error(
      "NetSuite application graph changed during reading; settlements were not reconciled",
    );
  }
  const eligible: NsApplicationLink[] = [];
  const nonpostingRefs = new Set<string>();
  const exclusions: SettlementExclusion[] = [];
  for (const link of rows) {
    const label = `${link.nextdoc}:${link.nextline}→${link.previousdoc}:${link.previousline}`;
    if (
      ![link.previousdoc, link.previousline, link.nextdoc, link.nextline].every((value) =>
        String(value ?? "").trim(),
      )
    ) {
      throw new Error(
        "NetSuite settlement link identity is unavailable; restore source access and retry the sync",
      );
    }
    if (link.foreignamount == null || String(link.foreignamount).trim() === "") {
      throw new Error(
        `NetSuite settlement ${label} has no source amount; restore source access and retry the sync`,
      );
    }
    if (toUnits(link.foreignamount) <= 0n) continue;
    if (
      !["T", "F"].includes(link.payposting ?? "") ||
      !["T", "F"].includes(link.appposting ?? "")
    ) {
      throw new Error(
        `NetSuite settlement ${label} has unknown endpoint posting state; restore source transaction access and retry the sync`,
      );
    }
    if (link.payposting === "F" || link.appposting === "F") {
      if (link.payposting === "F") nonpostingRefs.add(String(link.nextdoc));
      if (link.appposting === "F") nonpostingRefs.add(String(link.previousdoc));
      exclusions.push({
        paymentRef: String(link.nextdoc),
        appliedRef: String(link.previousdoc),
        paymentLineRef: String(link.nextline),
        appliedLineRef: String(link.previousline),
        amount: fromUnits(toUnits(link.foreignamount)),
        paymentPosting: link.payposting === "F" ? "F" : "T",
        appliedPosting: link.appposting === "F" ? "F" : "T",
        paymentStatus: link.paystatus ?? null,
        appliedStatus: link.appstatus ?? null,
        reason: link.payposting === "F" ? "nonposting_payment" : "nonposting_target",
      });
      continue;
    }
    if (!String(link.payaccount ?? "").trim() || !String(link.appaccount ?? "").trim()) {
      throw new Error(
        `NetSuite settlement control-account identity is unavailable for posted link ${label} in book ${options.bookRef}; restore source accounting-line access or correct the source transaction, then retry the sync`,
      );
    }
    eligible.push(link);
  }
  const applications = toSourceApplicationLinks(eligible, options.baseCurrency);
  const rowsByPayer = new Map<string, NsApplicationLink[]>();
  for (const row of rows) {
    const key = String(row.nextdoc);
    const group = rowsByPayer.get(key) ?? [];
    group.push(row);
    rowsByPayer.set(key, group);
  }
  return {
    applications,
    payerDigests: new Map([...rowsByPayer].map(([ref, group]) => [ref, settlementDigest(group)])),
    observation: {
      version: 1,
      source: "netsuite",
      sourceAccount: options.sourceAccount,
      bookRef: options.bookRef,
      scope: refs ? { kind: "references", refs } : { kind: "all" },
      consistency: "repeated_read",
      observedFrom,
      observedThrough: new Date().toISOString(),
      rawLinks: count,
      eligibleLinks: applications.length,
      graphDigest,
      applicationsDigest: applicationLinksDigest(applications),
      nonpostingRefs: [...nonpostingRefs].sort(),
      exclusions,
    },
  };
}

/**
 * Map NetSuite payment links to reconciler input: dedupe across governed
 * export retries, drop non-positive links, and state every link in its own
 * terms — the transaction-currency `foreignamount` plus the paying
 * transaction's currency and rate. The reconciler converts centrally and
 * refuses anything it cannot price; this mapper never converts and never
 * defaults a rate.
 *
 * Currency follows the document builder's rule exactly: the display value
 * resolves through `netSuiteCurrencyIso`; an unstated currency is the source
 * base (single-currency accounts state nothing); a stated-but-unresolvable
 * value stays empty so the reconciler refuses the link instead of settling
 * a guess.
 */
export function toSourceApplicationLinks(
  rows: NsApplicationLink[],
  baseCurrency: string,
): SourceApplicationLink[] {
  return uniqueNetSuiteApplicationLinks(rows)
    .filter((link) => link.foreignamount != null && toUnits(link.foreignamount) > 0n)
    .map((link) => {
      const stated = String(link.paycurrency ?? "").trim() !== "";
      return {
        paymentRef: String(link.nextdoc),
        appliedRef: String(link.previousdoc),
        amount: String(link.foreignamount),
        currency: netSuiteCurrencyIso(link.paycurrency) ?? (stated ? "" : baseCurrency),
        rate: link.payexrate ?? null,
        ...(link.payaccount != null || link.appaccount != null
          ? {
              paymentAccountRef: String(link.payaccount ?? ""),
              appliedAccountRef: String(link.appaccount ?? ""),
            }
          : {}),
      };
    });
}
