/**
 * The venture-backed SaaS cap table the Northstar Cloud demonstration
 * records: incorporation with restricted founder stock, an equity incentive
 * plan, two SAFEs and a convertible note, a priced Series Seed that converts
 * them, a Series A, a lender warrant, employee options and RSUs, exercises
 * and a departure. Dates are a year offset from the demonstration year and a
 * month-day, so the story ends in the demonstration year.
 */

/** A story date: years relative to the demonstration year, and the month-day. */
export type StoryDate = readonly [yearOffset: number, monthDay: string];

export function storyDate(year: number, [offset, monthDay]: StoryDate): string {
  return `${year + offset}-${monthDay}`;
}

export interface CapTableEmployee {
  /** The authored party identity. */
  key: string;
  name: string;
  title: string;
  hired: StoryDate;
  left?: StoryDate;
}

/** Employees who hold awards under the plan. */
export const CAP_TABLE_EMPLOYEES: readonly CapTableEmployee[] = [
  {
    key: "equity-holder-diego",
    name: "Diego Alvarez",
    title: "Founding engineer",
    hired: [-3, "07-10"],
  },
  {
    key: "equity-holder-hannah",
    name: "Hannah Brooks",
    title: "Product designer",
    hired: [-3, "07-10"],
  },
  {
    key: "equity-holder-kenji",
    name: "Kenji Watanabe",
    title: "Senior backend engineer",
    hired: [-3, "11-06"],
  },
  {
    key: "equity-holder-liam",
    name: "Liam O'Connor",
    title: "Customer success lead",
    hired: [-3, "11-06"],
    left: [-1, "04-30"],
  },
  { key: "equity-holder-maya", name: "Maya Chen", title: "VP Engineering", hired: [-2, "03-04"] },
  {
    key: "equity-holder-fatima",
    name: "Fatima Noor",
    title: "Data engineer",
    hired: [-2, "03-04"],
  },
  {
    key: "equity-holder-sofia",
    name: "Sofia Rossi",
    title: "Product manager",
    hired: [-2, "03-04"],
  },
  {
    key: "equity-holder-grace",
    name: "Grace Mensah",
    title: "Marketing director",
    hired: [-2, "08-12"],
  },
  {
    key: "equity-holder-noah",
    name: "Noah Fischer",
    title: "Site reliability engineer",
    hired: [-2, "08-12"],
  },
  {
    key: "equity-holder-isabella",
    name: "Isabella Duarte",
    title: "Account executive",
    hired: [-1, "02-10"],
  },
  {
    key: "equity-holder-owen",
    name: "Owen Patel",
    title: "Finance controller",
    hired: [-1, "02-10"],
  },
  { key: "equity-holder-ethan", name: "Ethan Park", title: "VP Sales", hired: [-1, "12-01"] },
  { key: "equity-holder-zara", name: "Zara Ahmed", title: "Head of People", hired: [0, "03-09"] },
];

export interface OptionGrant {
  key: string;
  /** The holder's authored party identity. */
  holder: string;
  granted: StoryDate;
  shares: string;
  /** Exercise price: the common stock's fair market value on the grant date. */
  strike: string;
  riskFreeRatePercent: string;
  earlyExercise?: boolean;
}

/** Four-year monthly vesting with a one-year cliff, at-the-money, ten-year term. */
export const OPTION_GRANTS: readonly OptionGrant[] = [
  {
    key: "diego",
    holder: "equity-holder-diego",
    granted: [-3, "07-10"],
    shares: "240000",
    strike: "0.0500",
    riskFreeRatePercent: "3.90",
  },
  {
    key: "hannah",
    holder: "equity-holder-hannah",
    granted: [-3, "07-10"],
    shares: "144000",
    strike: "0.0500",
    riskFreeRatePercent: "3.90",
  },
  {
    key: "kenji",
    holder: "equity-holder-kenji",
    granted: [-3, "11-06"],
    shares: "192000",
    strike: "0.0500",
    riskFreeRatePercent: "4.40",
  },
  {
    key: "liam",
    holder: "equity-holder-liam",
    granted: [-3, "11-06"],
    shares: "96000",
    strike: "0.0500",
    riskFreeRatePercent: "4.40",
  },
  {
    key: "maya",
    holder: "equity-holder-maya",
    granted: [-2, "03-04"],
    shares: "288000",
    strike: "0.1200",
    riskFreeRatePercent: "4.20",
    earlyExercise: true,
  },
  {
    key: "fatima",
    holder: "equity-holder-fatima",
    granted: [-2, "03-04"],
    shares: "120000",
    strike: "0.1200",
    riskFreeRatePercent: "4.20",
  },
  {
    key: "sofia",
    holder: "equity-holder-sofia",
    granted: [-2, "03-04"],
    shares: "144000",
    strike: "0.1200",
    riskFreeRatePercent: "4.20",
  },
  {
    key: "grace",
    holder: "equity-holder-grace",
    granted: [-2, "08-12"],
    shares: "120000",
    strike: "0.3500",
    riskFreeRatePercent: "3.85",
  },
  {
    key: "noah",
    holder: "equity-holder-noah",
    granted: [-2, "08-12"],
    shares: "96000",
    strike: "0.3500",
    riskFreeRatePercent: "3.85",
  },
  {
    key: "isabella",
    holder: "equity-holder-isabella",
    granted: [-1, "02-10"],
    shares: "72000",
    strike: "0.4200",
    riskFreeRatePercent: "4.35",
  },
  {
    key: "owen",
    holder: "equity-holder-owen",
    granted: [-1, "02-10"],
    shares: "48000",
    strike: "0.4200",
    riskFreeRatePercent: "4.35",
  },
  {
    key: "jordan",
    holder: "employee",
    granted: [0, "03-09"],
    shares: "48000",
    strike: "1.0500",
    riskFreeRatePercent: "4.05",
  },
  {
    key: "kenji-refresh",
    holder: "equity-holder-kenji",
    granted: [0, "07-13"],
    shares: "48000",
    strike: "1.1000",
    riskFreeRatePercent: "3.95",
  },
];

export interface RsuAward {
  key: string;
  holder: string;
  granted: StoryDate;
  shares: string;
  /** The common stock's fair value on the grant date. */
  sharePrice: string;
}

/** Four-year quarterly vesting with a one-year cliff. */
export const RSU_AWARDS: readonly RsuAward[] = [
  {
    key: "ethan",
    holder: "equity-holder-ethan",
    granted: [-1, "12-01"],
    shares: "80000",
    sharePrice: "0.9500",
  },
  {
    key: "zara",
    holder: "equity-holder-zara",
    granted: [0, "03-09"],
    shares: "40000",
    sharePrice: "1.0500",
  },
];

export interface RoundInvestment {
  key: string;
  holder: string;
  shares: string;
}

/** The priced rounds: the class each sells, its price and its new-money investors. */
export const PRICED_ROUNDS = {
  seed: {
    name: "Series Seed",
    classCode: "SEED",
    className: "Series Seed Preferred",
    closed: [-2, "06-28"] as StoryDate,
    price: "1.2000",
    authorizedShares: "6000000",
    seniority: 1,
    investors: [
      { key: "seed-lead", holder: "seed-lead", shares: "2500000" },
      { key: "seed-pro-rata", holder: "seed-investor", shares: "500000" },
    ] as RoundInvestment[],
  },
  seriesA: {
    name: "Series A",
    classCode: "SERIESA",
    className: "Series A Preferred",
    closed: [-1, "09-30"] as StoryDate,
    price: "3.2000",
    authorizedShares: "5000000",
    seniority: 2,
    investors: [
      { key: "series-a-lead", holder: "series-a-lead", shares: "3750000" },
      { key: "series-a-pro-rata", holder: "seed-lead", shares: "625000" },
    ] as RoundInvestment[],
  },
} as const;
