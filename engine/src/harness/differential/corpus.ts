import { Rng } from "../../sim/rng.ts";
import { addDays, eachDay, isMonthEnd, isWeekend } from "../../sim/manifest.ts";
import { fromCents, toCents } from "./reference-ledger.ts";
import type {
  Corpus,
  CorpusAccount,
  CorpusEvent,
  CorpusParty,
  JournalEvent,
  PaymentEvent,
} from "../corpus-lib/types.ts";

/**
 * Deterministic corpus generator. Same seed → byte-identical corpus, so the
 * published artifacts under corpus/differential/ are reproducible by anyone
 * from source. The generator deliberately mixes routine traffic with the cases
 * that break naive implementations: multi-line documents with odd cents,
 * partial payments, standalone credit memos, batched vendor payments, employee
 * expense reports, month-end accruals with next-month reversals, and
 * one-cent rounding-stress journals.
 *
 * Validity rule: the generator never emits an event the reference ledger would
 * reject — callers still run computeExpected() afterwards, which re-validates
 * every event independently.
 */

const ACCOUNTS: CorpusAccount[] = [
  ["bank", "1000", "Operating Cash", "asset_bank"],
  ["ar", "1100", "Accounts Receivable", "asset_receivable"],
  ["prepaid", "1200", "Prepaid Expenses", "asset_current_other"],
  ["equipment", "1500", "Equipment", "asset_fixed"],
  ["accumDep", "1590", "Accumulated Depreciation", "asset_fixed"],
  ["ap", "2000", "Accounts Payable", "liability_payable"],
  ["accrued", "2100", "Accrued Liabilities", "liability_current_other"],
  ["employeePayable", "2110", "Employee Reimbursements Payable", "liability_current_other"],
  ["notesPayable", "2800", "Notes Payable", "liability_long_term"],
  ["commonStock", "3000", "Common Stock", "equity"],
  ["retainedEarnings", "3200", "Retained Earnings", "equity"],
  ["revenueService", "4000", "Service Revenue", "income"],
  ["revenueProduct", "4010", "Product Revenue", "income"],
  ["revenueConsulting", "4020", "Consulting Revenue", "income"],
  ["cogs", "5000", "Cost of Services", "cogs"],
  ["materials", "5100", "Materials & Supplies", "cogs"],
  ["subcontractor", "5200", "Subcontractor Costs", "cogs"],
  ["rent", "6100", "Rent", "expense"],
  ["utilities", "6200", "Utilities", "expense"],
  ["insurance", "6300", "Insurance", "expense"],
  ["office", "6400", "Office & Software", "expense"],
  ["professionalFees", "6500", "Professional Fees", "expense"],
  ["travel", "6650", "Travel", "expense"],
  ["depreciation", "6700", "Depreciation Expense", "expense"],
  ["bankFees", "6800", "Bank & Merchant Fees", "expense"],
].map(([key, number, name, type]) => ({ key: key!, number: number!, name: name!, type: type! }));

const CUSTOMERS = [
  "Harborview Logistics", "Bluefield Manufacturing", "Cedar & Vine Hospitality", "Northgate Property Group",
  "Summit Analytics", "Ironwood Retail Co.", "Lakeshore Medical Partners", "Vantage Engineering",
];
const VENDORS = [
  "Metro Office Supply", "Pinnacle Insurance Brokers", "GridWorks Utilities", "Beacon Legal LLP",
  "Crestline Building Materials", "Apex Subcontracting", "CityWide Property Rentals", "Streamline SaaS Tools",
];
const EMPLOYEES = ["Jordan Reyes", "Morgan Whitfield"];

const REVENUE = ["revenueService", "revenueProduct", "revenueConsulting"];
const EXPENSE_BY_VENDOR: Record<string, string[]> = {
  v1: ["office"], v2: ["insurance", "prepaid"], v3: ["utilities"], v4: ["professionalFees"],
  v5: ["materials", "cogs"], v6: ["subcontractor"], v7: ["rent"], v8: ["office", "bankFees"],
};

interface OpenDoc {
  id: string;
  party: string;
  /** Remaining open magnitude in cents. */
  remaining: bigint;
}

export function generateCorpus(opts: { seed: string; startDate: string; endDate: string; name?: string }): Corpus {
  const rng = Rng.fromSeed(`differential:${opts.seed}`);
  const parties: CorpusParty[] = [
    ...CUSTOMERS.map((name, i) => ({ key: `c${i + 1}`, name, roles: ["customer" as const] })),
    ...VENDORS.map((name, i) => ({ key: `v${i + 1}`, name, roles: ["vendor" as const] })),
    ...EMPLOYEES.map((name, i) => ({ key: `e${i + 1}`, name, roles: ["employee" as const] })),
  ];

  const events: CorpusEvent[] = [];
  let seq = 0;
  const nextId = () => `EVT-${String(++seq).padStart(6, "0")}`;

  // date → payment tranches scheduled for that day.
  const arSchedule = new Map<string, { party: string; doc: string; amount: bigint }[]>();
  const apSchedule = new Map<string, { party: string; doc: string; amount: bigint }[]>();
  const schedule = (
    map: Map<string, { party: string; doc: string; amount: bigint }[]>,
    date: string,
    entry: { party: string; doc: string; amount: bigint },
  ) => {
    if (date > opts.endDate) return; // stays open past the window — feeds the aging compare
    (map.get(date) ?? map.set(date, []).get(date)!).push(entry);
  };

  const recentInvoices: OpenDoc[] = [];

  // Split a total into n positive lines that cross-foot exactly (remainder on the last).
  const splitLines = (r: Rng, totalCents: bigint, n: number): bigint[] => {
    if (n <= 1) return [totalCents];
    const out: bigint[] = [];
    let left = totalCents;
    for (let i = 0; i < n - 1; i++) {
      const share = left / BigInt(n - i) + BigInt(r.int(-50, 50));
      const clamped = share < 1n ? 1n : share >= left ? left - BigInt(n - i - 1) : share;
      out.push(clamped);
      left -= clamped;
    }
    out.push(left);
    return out;
  };

  // Opening capitalization — day one, balanced, away from the AR/AP subledgers.
  const opening: JournalEvent = {
    id: nextId(),
    kind: "journal",
    date: opts.startDate,
    memo: "Opening balances",
    lines: [
      { account: "bank", amount: "250000.00" },
      { account: "equipment", amount: "120000.00" },
      { account: "accumDep", amount: "-40000.00" },
      { account: "commonStock", amount: "-10000.00" },
      { account: "notesPayable", amount: "-180000.00" },
      { account: "retainedEarnings", amount: "-140000.00" },
    ],
  };
  events.push(opening);

  let pendingAccrual: bigint | null = null;

  for (const date of eachDay(opts.startDate, opts.endDate)) {
    const day = rng.stream(`day:${date}`);
    const weekend = isWeekend(date);

    // Reverse last month's accrual on the 1st.
    if (date.endsWith("-01") && pendingAccrual !== null) {
      events.push({
        id: nextId(), kind: "journal", date, memo: "Reverse prior-month accrual",
        lines: [
          { account: "accrued", amount: fromCents(pendingAccrual) },
          { account: "professionalFees", amount: fromCents(-pendingAccrual) },
        ],
      });
      pendingAccrual = null;
    }

    // --- customer invoices -------------------------------------------------
    const invCount = weekend ? (day.chance(0.15) ? 1 : 0) : day.int(0, 3);
    for (let i = 0; i < invCount; i++) {
      const r = day.stream(`inv:${i}`);
      const party = `c${r.int(1, CUSTOMERS.length)}`;
      const total = toCents(r.money(400, 18000));
      const n = r.int(1, 3);
      const id = nextId();
      events.push({
        id, kind: "customer_invoice", date, party, dueDate: addDays(date, 30),
        lines: splitLines(r, total, n).map((cents, k) => ({
          account: r.pick(REVENUE), amount: fromCents(cents), description: `Service line ${k + 1}`,
        })),
      });
      recentInvoices.push({ id, party, remaining: total });
      if (recentInvoices.length > 40) recentInvoices.shift();

      // Payment plan: full (85%), two tranches (10%), never (5%).
      const roll = r.next();
      if (roll < 0.85) {
        schedule(arSchedule, addDays(date, r.int(8, 45)), { party, doc: id, amount: total });
      } else if (roll < 0.95) {
        const first = (total * BigInt(r.int(30, 70))) / 100n;
        if (first > 0n && first < total) {
          schedule(arSchedule, addDays(date, r.int(8, 30)), { party, doc: id, amount: first });
          if (r.chance(0.6)) {
            schedule(arSchedule, addDays(date, r.int(35, 70)), { party, doc: id, amount: total - first });
          }
        } else {
          schedule(arSchedule, addDays(date, r.int(8, 45)), { party, doc: id, amount: total });
        }
      }
    }

    // --- standalone customer credit memos (returns/adjustments) -------------
    if (!weekend && day.chance(0.06) && recentInvoices.length > 0) {
      const r = day.stream("credit");
      const target = r.pick(recentInvoices);
      const credit = (target.remaining * BigInt(r.int(5, 25))) / 100n;
      if (credit > 0n) {
        events.push({
          id: nextId(), kind: "customer_credit", date, party: target.party,
          memo: `Adjustment re ${target.id}`,
          lines: [{ account: r.pick(REVENUE), amount: fromCents(credit), description: "Credit adjustment" }],
        });
      }
    }

    // --- vendor bills --------------------------------------------------------
    const billCount = weekend ? 0 : day.int(0, 2);
    for (let i = 0; i < billCount; i++) {
      const r = day.stream(`bill:${i}`);
      const vendorKey = `v${r.int(1, VENDORS.length)}`;
      const accounts = EXPENSE_BY_VENDOR[vendorKey]!;
      const total = toCents(r.money(120, 9000));
      const n = Math.min(accounts.length, r.int(1, 2));
      const id = nextId();
      events.push({
        id, kind: "vendor_bill", date, party: vendorKey, dueDate: addDays(date, 30),
        lines: splitLines(r, total, n).map((cents, k) => ({
          account: accounts[k % accounts.length]!, amount: fromCents(cents),
        })),
      });
      if (!r.chance(0.08)) {
        schedule(apSchedule, addDays(date, r.int(20, 40)), { party: vendorKey, doc: id, amount: total });
      }
    }

    // --- employee expense reports -------------------------------------------
    if (!weekend && day.chance(0.15)) {
      const r = day.stream("exp");
      const emp = `e${r.int(1, EMPLOYEES.length)}`;
      const total = toCents(r.money(40, 900));
      const id = nextId();
      events.push({
        id, kind: "expense_report", date, party: emp,
        lines: [{ account: "travel", amount: fromCents(total), description: "Travel & per diem" }],
      });
      schedule(apSchedule, addDays(date, r.int(5, 14)), { party: emp, doc: id, amount: total });
    }

    // --- scheduled payments, batched per party per day -----------------------
    for (const [map, kind] of [
      [arSchedule, "customer_payment"],
      [apSchedule, "vendor_payment"],
    ] as const) {
      const due = map.get(date);
      if (!due) continue;
      map.delete(date);
      const byParty = new Map<string, { doc: string; amount: bigint }[]>();
      for (const t of due) (byParty.get(t.party) ?? byParty.set(t.party, []).get(t.party)!).push(t);
      for (const [party, tranches] of byParty) {
        const payment: PaymentEvent = {
          id: nextId(), kind, date, party,
          allocations: tranches.map((t) => ({ event: t.doc, amount: fromCents(t.amount) })),
        };
        events.push(payment);
      }
    }

    // --- month-end: depreciation, accrual, and a rounding-stress journal -----
    if (isMonthEnd(date)) {
      const r = day.stream("close");
      const dep = toCents(r.money(1800, 2600));
      events.push({
        id: nextId(), kind: "journal", date, memo: "Monthly depreciation",
        lines: [
          { account: "depreciation", amount: fromCents(dep) },
          { account: "accumDep", amount: fromCents(-dep) },
        ],
      });
      pendingAccrual = toCents(r.money(900, 4200));
      events.push({
        id: nextId(), kind: "journal", date, memo: "Month-end accrual (reverses next month)",
        lines: [
          { account: "professionalFees", amount: fromCents(pendingAccrual) },
          { account: "accrued", amount: fromCents(-pendingAccrual) },
        ],
      });
      // Rounding stress: three legs that only balance if cents are exact.
      events.push({
        id: nextId(), kind: "journal", date, memo: "Rounding-stress reclass",
        lines: [
          { account: "office", amount: "0.01" },
          { account: "bankFees", amount: "0.01" },
          { account: "materials", amount: "-0.02" },
        ],
      });
    }
  }

  return {
    schemaVersion: 1,
    name: opts.name ?? `differential-${opts.seed}`,
    seed: opts.seed,
    currency: "CAD",
    country: "CA",
    startDate: opts.startDate,
    endDate: opts.endDate,
    accounts: ACCOUNTS,
    parties,
    events,
  };
}
