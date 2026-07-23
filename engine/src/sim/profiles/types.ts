/**
 * A profile is pure config describing a company to simulate. Adding an industry
 * = adding a profile; no engine code changes. The runner + activities read these
 * knobs to decide what happens, how often, and how large.
 */

export interface VendorSpec {
  name: string;
  /** Payment terms in days (net-N). */
  termDays: number;
  /** Which expense categories this vendor bills for (keys into the CoA). */
  expenseCategories: string[];
  /** Typical bill size range, in base currency. */
  billMin: number;
  billMax: number;
}

export interface CustomerSpec {
  name: string;
  termDays: number;
  /** Which revenue categories this customer buys (keys into the CoA). */
  revenueCategories: string[];
  invoiceMin: number;
  invoiceMax: number;
  /**
   * How this customer pays: probability weights over on-time / late / very-late
   * / short-pay (dispute a portion) / never (goes to collections).
   */
  payment: PaymentBehavior;
}

export interface PaymentBehavior {
  onTime: number;
  late: number;
  veryLate: number;
  shortPay: number;
  delinquent: number;
}

/** Expected number of events per business day (a rate; the scheduler samples it). */
export interface Cadence {
  billsPerDay: number;
  invoicesPerDay: number;
  expenseReportsPerDay: number;
  journalPerDay: number;
  /** Day-of-month the AP pay run fires (e.g. 15 and month end handled separately). */
  payRunDayOfMonth: number;
  /** Day-of-month (of the FOLLOWING month) the prior period is closed. */
  closeDayOfMonth: number;
}

export interface Profile {
  id: string;
  name: string;
  industry: string;
  baseCurrency: string;
  country: string;
  /** ISO 4217-ish description only; the CoA is fixed but categories vary by use. */
  vendors: VendorSpec[];
  customers: CustomerSpec[];
  /** Actor headcount hint (roles are fixed; this scales realism of provenance). */
  cadence: Cadence;
  /**
   * Which capabilities this profile is expected to exercise. The coverage check
   * fails the run if any listed capability never fired.
   */
  expectedCapabilities: string[];
}
