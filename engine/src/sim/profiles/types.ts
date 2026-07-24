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

/** A chart-of-accounts entry: [semanticKey, number, name, accountType]. */
export type CoaEntry = [string, string, string, string];

/**
 * A SaaS subscription plan. Each becomes a `subscription_plans` row backed by a
 * service `item` that carries a straight-line recognition rule spanning `termMonths`
 * (1 = monthly plan recognized in-month; 12 = annual plan billed up-front and
 * recognized ratably over the year — the classic deferred-revenue case). Billing
 * runs through the real recurring-billing engine; revenue drains deferred → earned
 * via the real revenue-recognition engine.
 */
export interface PlanSpec {
  key: string;
  name: string;
  /** Price per billing period (monthly plans: per month; annual: per year). */
  amount: number;
  interval: "monthly" | "annually";
  /** Recognition term in months (1 for monthly, 12 for annual). */
  termMonths: number;
}

/** A cohort of subscribers on a plan, opened at provisioning (seat count varies). */
export interface SubscriberSpec {
  customer: string;
  plan: string;
  /** Seats/quantity. */
  quantity: number;
}

/** The five governed construction billing methods (project_types keys). */
export type BillingMethod =
  | "time_and_materials"
  | "schedule_of_values"
  | "fixed_price"
  | "not_to_exceed"
  | "cost_plus";

/**
 * A construction job in the seeded portfolio. The company runs a MIX of billing
 * methods concurrently (like a real GC): T&M and NTE jobs bill accumulated crew
 * time + equipment + materials; SOV jobs run AIA progress draws with retainage;
 * fixed-price jobs bill milestones; cost-plus bills cost + a fee. Crews log field
 * tickets against every active job daily, so labor cost — and thus margin —
 * emerges bottom-up regardless of how the job is billed.
 */
export interface JobSpec {
  /** Customer this job is for (matched by name against the profile's customers). */
  customer: string;
  name: string;
  code: string;
  method: BillingMethod;
  /** Contract/NTE ceiling or fixed price (fixed_price / not_to_exceed / cost_plus fee base). */
  contractValue?: number;
  /** G703 schedule-of-values lines (schedule_of_values jobs). Σ = contract. */
  sovLines?: { description: string; scheduledValue: number }[];
  /** Crew headcount assigned to this job (drives daily labor volume). Default 3. */
  crewSize?: number;
  /** Does this job put owned equipment on site (billed at a day rate on T&M work)? */
  equipment?: boolean;
  /** Monthly consumed material cost, billed at a markup on T&M jobs. Default 0. */
  monthlyMaterials?: number;
}

export interface Profile {
  id: string;
  name: string;
  industry: string;
  baseCurrency: string;
  country: string;
  /**
   * This company's complete chart of accounts — every company has its OWN chart
   * (different names/numbers/accounts). Must define the semantic keys the
   * generator/ops/opening-balances reference; may add any industry-specific
   * accounts. If omitted, world.ts's DEFAULT_COA is used.
   */
  coa?: CoaEntry[];
  /** Opening-balance scale (1 = mid-size services firm; larger = bigger company). */
  openingScale?: number;
  /**
   * The company's cost structure, so the P&L is enterprise-realistic instead of
   * revenue-with-token-costs. Each month the environment books a payroll run and
   * a delivery-cost accrual sized to the month's delivered revenue, giving a
   * coherent gross/net margin. Labor that already flows through T&M time entries
   * (construction field crews) is EXCLUDED via `laborPctOfRevenue` being the
   * *non-T&M* labor only.
   */
  economics?: {
    /** Payroll (salaries+benefits+tax) as a fraction of monthly revenue. */
    laborPctOfRevenue: string;
    /** Direct delivery cost (COGS not otherwise billed via AP) as a fraction of revenue. */
    cogsPctOfRevenue: string;
  };
  /**
   * The billable workforce (consultants / crew), each with an hourly cost rate
   * and bill rate. When present (and the chart wires laborWip/laborClearing), the
   * company runs FULLY BOTTOM-UP: workers log billable time against engagements,
   * labor cost flows through the ledger, work is billed at the bill rate, and
   * payroll actuals wash the clearing — so margin emerges from rates × utilization
   * − overhead, not a top-down peg. Defaults to a generic crew if omitted.
   */
  workforce?: { name: string; costRate: string; billRate: string }[];
  /** How many active engagements/jobs to open per customer (bottom-up billing). */
  engagementsPerCustomer?: number;
  /**
   * A construction company's job portfolio — a mix of billing methods run
   * concurrently and driven bottom-up (crews log field tickets against each job
   * daily; the PM autopilot bills each per its method monthly). When present, this
   * is the ONLY source of revenue (set cadence.invoicesPerDay to 0), so the P&L
   * margin emerges from rates × utilization − overhead, at real GC fidelity.
   */
  jobPortfolio?: JobSpec[];
  /** Billed equipment day-rate per crew-day on jobs that put equipment on site. */
  equipmentDayRate?: number;
  /** Markup on consumed materials when billed on T&M work (e.g. 0.15 = +15%). */
  materialMarkup?: number;
  /**
   * SaaS subscription plans + the subscriber base opened at provisioning. When
   * present, the company runs on RECURRING revenue: the recurring-billing engine
   * bills subscriptions on their cycle, invoices park in deferred revenue, and the
   * revenue-recognition engine drains deferred → earned ratably. Churn/expansion,
   * dunning, and usage overages ride on top.
   */
  subscriptionPlans?: PlanSpec[];
  subscribers?: SubscriberSpec[];
  /** Fraction of subscribers billed monthly for usage overages (0-1). */
  usageBillingRate?: number;
  /** SaaS fixed monthly payroll/opex (R&D + S&M + G&A), booked month-end. */
  saasMonthlyPayroll?: number;
  /**
   * Monthly office/PM/admin overhead payroll — the staff a contractor carries
   * beyond the billable field crew (project managers, estimators, admin, yard).
   * Booked as a month-end operating expense so company NET margin lands realistic
   * (~10%) even though job-level GROSS margin is high (~45%). */
  officeOverheadPerMonth?: number;
  /** Target billable utilization (0-1): fraction of an 8h day a worker bills. */
  utilization?: number;
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
