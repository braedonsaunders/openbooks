/**
 * Transcribed ATO PAYG withholding coefficients for FY 2026–27 (taxYear 2027).
 *
 * Source: Taxation Administration (Withholding Schedules) Instrument 2026,
 * Federal Register of Legislation identifier F2026L00716 — "I, Ben Kelly,
 * Deputy Commissioner of Taxation, make the following instrument. Dated
 * 2 June 2026", made under "section 15-25 in Schedule 1 to the TAA", with
 * "The whole of this instrument" commencing "1 July 2026". Read from the
 * register's plain-HTML rendering (the ATO site itself 403s from this
 * vantage, including robots.txt):
 * https://www.legislation.gov.au/F2026L00716/asmade/2026-06-12/text/original/epub/OEBPS/document_1/document_1.html
 *
 * Every row below is quoted from Schedule 1 ("Coefficients for calculation
 * of amounts to be withheld (withholding amounts) from weekly payments") or
 * from Schedule 8 ("Statement of formulas for calculating study and
 * training support loans components", whose combined with-STSL tables are
 * authoritative — see the rounding note). Operative method, quoted:
 * "The formulas comprise linear equations of the form y = ax − b, where:
 * y is the weekly withholding amount expressed in dollars [and] x is the
 * number of whole dollars in the weekly earnings plus 99 cents". Stated
 * rounding, quoted: "Withholding amounts calculated as a result of applying
 * the formulas are rounded to the nearest dollar. Values ending in 50 cents
 * are rounded up to the next dollar. Do this rounding directly – that is,
 * do not make a preliminary rounding to the nearest cent." For scale 4:
 * "cents are ignored when applying the tax rate to earnings and when
 * withholding amounts are calculated."
 *
 * The instrument warns combined withholding "may differ slightly" from
 * base-plus-component sums because of "the rounding of components" — e.g.
 * scale 2 + STSL below $2,494 quotes b = 382.2935 while base b 181.7319
 * plus STSL b 200.5615 sums to 382.2934. The engine uses the combined
 * tables, never the sum. "Withholding calculated using either method is
 * accepted."
 *
 * Money discipline: coefficients are decimal STRINGS, never floats.
 */

/** One coefficient row: applies while x < lessThan; null lessThan is open. */
export interface AuSchedule1Row {
  readonly lessThan: string | null;
  readonly a: string | null;
  readonly b: string | null;
}

/**
 * Scale 1 — "Where the payee didn’t claim the tax-free threshold in Tax
 * file number declaration":
 * "Less than 188 — 0.1500 0.1500; Less than 371 — 0.2084 11.0185;
 * Less than 515 — 0.1790 0.1066; Less than 932 — 0.3227 74.1674;
 * Less than 2,246 — 0.3200 71.6508; Less than 3,303 — 0.3900 228.8816;
 * 3,303 & over — 0.4700 493.1893".
 */
export const AU_SCHEDULE1_SCALE1_2027: readonly AuSchedule1Row[] = [
  { lessThan: "188", a: "0.1500", b: "0.1500" },
  { lessThan: "371", a: "0.2084", b: "11.0185" },
  { lessThan: "515", a: "0.1790", b: "0.1066" },
  { lessThan: "932", a: "0.3227", b: "74.1674" },
  { lessThan: "2246", a: "0.3200", b: "71.6508" },
  { lessThan: "3303", a: "0.3900", b: "228.8816" },
  { lessThan: null, a: "0.4700", b: "493.1893" },
];

/**
 * Scale 2 — "Where the payee claimed the tax-free threshold in Tax file
 * number declaration":
 * "Less than 362 — – –; Less than 538 — 0.1500 54.3462;
 * Less than 673 — 0.2500 108.2135; Less than 721 — 0.1700 54.3473;
 * Less than 865 — 0.1790 60.8377; Less than 1,282 — 0.3227 185.1935;
 * Less than 2,596 — 0.3200 181.7319; Less than 3,653 — 0.3900 363.4627;
 * 3,653 & over — 0.4700 655.7704".
 */
export const AU_SCHEDULE1_SCALE2_2027: readonly AuSchedule1Row[] = [
  { lessThan: "362", a: null, b: null },
  { lessThan: "538", a: "0.1500", b: "54.3462" },
  { lessThan: "673", a: "0.2500", b: "108.2135" },
  { lessThan: "721", a: "0.1700", b: "54.3473" },
  { lessThan: "865", a: "0.1790", b: "60.8377" },
  { lessThan: "1282", a: "0.3227", b: "185.1935" },
  { lessThan: "2596", a: "0.3200", b: "181.7319" },
  { lessThan: "3653", a: "0.3900", b: "363.4627" },
  { lessThan: null, a: "0.4700", b: "655.7704" },
];

/**
 * Scale 3 — "Foreign residents":
 * "Less than 2,596 — 0.3000 0.3000; Less than 3,653 — 0.3700 181.7308;
 * 3,653 & over — 0.4500 474.0385".
 */
export const AU_SCHEDULE1_SCALE3_2027: readonly AuSchedule1Row[] = [
  { lessThan: "2596", a: "0.3000", b: "0.3000" },
  { lessThan: "3653", a: "0.3700", b: "181.7308" },
  { lessThan: null, a: "0.4500", b: "474.0385" },
];

/**
 * Scale 4 — "Where the payee didn’t provide a tax file number (TFN)":
 * "Resident $1 & over 0.4700; Foreign resident $1 & over 0.4500" with
 * "no coefficients are necessary. To calculate withholding, apply the tax
 * rate to earnings, ignoring any cents". Transcribed so the refusal names
 * the rate; the engine refuses no-TFN payees by name (see AU_REFUSED_2027).
 */
export const AU_SCHEDULE1_SCALE4_2027 = {
  residentRate: "0.4700",
  foreignRate: "0.4500",
} as const;

/**
 * Scale 5 — "Where the payee claimed the FULL exemption from Medicare levy
 * in Medicare levy variation declaration":
 * "Less than 362 — – –; Less than 721 — 0.1500 54.3462;
 * Less than 865 — 0.1590 60.8365; Less than 1,282 — 0.3027 185.1923;
 * Less than 2,596 — 0.3000 181.7308; Less than 3,653 — 0.3700 363.4615;
 * 3,653 & over — 0.4500 655.7692".
 * Transcribed so the refusal names the scale; refused because the pack
 * carries no Medicare levy variation declaration.
 */
export const AU_SCHEDULE1_SCALE5_2027: readonly AuSchedule1Row[] = [
  { lessThan: "362", a: null, b: null },
  { lessThan: "721", a: "0.1500", b: "54.3462" },
  { lessThan: "865", a: "0.1590", b: "60.8365" },
  { lessThan: "1282", a: "0.3027", b: "185.1923" },
  { lessThan: "2596", a: "0.3000", b: "181.7308" },
  { lessThan: "3653", a: "0.3700", b: "363.4615" },
  { lessThan: null, a: "0.4500", b: "655.7692" },
];

/**
 * Scale 6 — "Where the payee claimed the HALF exemption from Medicare levy
 * in Medicare levy variation declaration":
 * "Less than 362 — – –; Less than 721 — 0.1500 54.3462;
 * Less than 865 — 0.1590 60.8365; Less than 908 — 0.3027 185.1923;
 * Less than 1,135 — 0.3527 230.6135; Less than 1,282 — 0.3127 185.1923;
 * Less than 2,596 — 0.3100 181.7308; Less than 3,653 — 0.3800 363.4615;
 * 3,653 & over — 0.4600 655.7692".
 * Transcribed so the refusal names the scale; refused, as scale 5.
 */
export const AU_SCHEDULE1_SCALE6_2027: readonly AuSchedule1Row[] = [
  { lessThan: "362", a: null, b: null },
  { lessThan: "721", a: "0.1500", b: "54.3462" },
  { lessThan: "865", a: "0.1590", b: "60.8365" },
  { lessThan: "908", a: "0.3027", b: "185.1923" },
  { lessThan: "1135", a: "0.3527", b: "230.6135" },
  { lessThan: "1282", a: "0.3127", b: "185.1923" },
  { lessThan: "2596", a: "0.3100", b: "181.7308" },
  { lessThan: "3653", a: "0.3800", b: "363.4615" },
  { lessThan: null, a: "0.4600", b: "655.7692" },
];

/**
 * Scale 1 with STSL debt (Schedule 8 combined table) — "Where payee has
 * not claimed the tax-free threshold in Tax file number declaration –
 * scale 1 With study and training support loans debt":
 * "Less than 188 — 0.1500 0.1500; Less than 371 — 0.2084 11.0185;
 * Less than 515 — 0.1790 0.1066; Less than 932 — 0.3227 74.1674;
 * Less than 987 — 0.3200 71.6508; Less than 2,144 — 0.4700 219.7124;
 * Less than 2,246 — 0.4900 262.6035; Less than 2,727 — 0.5600 419.8343;
 * Less than 3,303 — 0.4900 228.8816; 3,303 & over — 0.5700 493.1893".
 */
export const AU_SCHEDULE1_SCALE1_STSL_2027: readonly AuSchedule1Row[] = [
  { lessThan: "188", a: "0.1500", b: "0.1500" },
  { lessThan: "371", a: "0.2084", b: "11.0185" },
  { lessThan: "515", a: "0.1790", b: "0.1066" },
  { lessThan: "932", a: "0.3227", b: "74.1674" },
  { lessThan: "987", a: "0.3200", b: "71.6508" },
  { lessThan: "2144", a: "0.4700", b: "219.7124" },
  { lessThan: "2246", a: "0.4900", b: "262.6035" },
  { lessThan: "2727", a: "0.5600", b: "419.8343" },
  { lessThan: "3303", a: "0.4900", b: "228.8816" },
  { lessThan: null, a: "0.5700", b: "493.1893" },
];

/**
 * Scale 2 with STSL debt (Schedule 8 combined table) — "Where payee has
 * claimed the tax-free threshold in Tax file number declaration with or
 * without leave loading – scale 2 With study and training support loans
 * debt":
 * "Less than 362 — – –; Less than 538 — 0.1500 54.3462;
 * Less than 673 — 0.2500 108.2135; Less than 721 — 0.1700 54.3473;
 * Less than 865 — 0.1790 60.8377; Less than 1,282 — 0.3227 185.1935;
 * Less than 1,337 — 0.3200 181.7319; Less than 2,494 — 0.4700 382.2935;
 * Less than 2,596 — 0.4900 432.1846; Less than 3,577 — 0.5600 613.9154;
 * Less than 3,653 — 0.4900 363.4627; 3,653 & over — 0.5700 655.7704".
 */
export const AU_SCHEDULE1_SCALE2_STSL_2027: readonly AuSchedule1Row[] = [
  { lessThan: "362", a: null, b: null },
  { lessThan: "538", a: "0.1500", b: "54.3462" },
  { lessThan: "673", a: "0.2500", b: "108.2135" },
  { lessThan: "721", a: "0.1700", b: "54.3473" },
  { lessThan: "865", a: "0.1790", b: "60.8377" },
  { lessThan: "1282", a: "0.3227", b: "185.1935" },
  { lessThan: "1337", a: "0.3200", b: "181.7319" },
  { lessThan: "2494", a: "0.4700", b: "382.2935" },
  { lessThan: "2596", a: "0.4900", b: "432.1846" },
  { lessThan: "3577", a: "0.5600", b: "613.9154" },
  { lessThan: "3653", a: "0.4900", b: "363.4627" },
  { lessThan: null, a: "0.5700", b: "655.7704" },
];

/**
 * Scale 3 with STSL debt (Schedule 8 combined table) — "Foreign residents
 * – scale 3 With study and training support loans debt":
 * "Less than 1,337 — 0.3000 0.3000; Less than 2,494 — 0.4500 200.5615;
 * Less than 2,596 — 0.4700 250.4527; Less than 3,577 — 0.5400 432.1835;
 * Less than 3,653 — 0.4700 181.7308; 3,653 & over — 0.5500 474.0385".
 */
export const AU_SCHEDULE1_SCALE3_STSL_2027: readonly AuSchedule1Row[] = [
  { lessThan: "1337", a: "0.3000", b: "0.3000" },
  { lessThan: "2494", a: "0.4500", b: "200.5615" },
  { lessThan: "2596", a: "0.4700", b: "250.4527" },
  { lessThan: "3577", a: "0.5400", b: "432.1835" },
  { lessThan: "3653", a: "0.4700", b: "181.7308" },
  { lessThan: null, a: "0.5500", b: "474.0385" },
];

/**
 * Scale 5 with STSL debt (Schedule 8 combined table) — "Where payee
 * claimed FULL exemption from Medicare levy in Medicare levy variation
 * declaration – scale 5 With study and training support loans debt":
 * "Less than 362 — – –; Less than 721 — 0.1500 54.3462;
 * Less than 865 — 0.1590 60.8365; Less than 1,282 — 0.3027 185.1923;
 * Less than 1,337 — 0.3000 181.7308; Less than 2,494 — 0.4500 382.2923;
 * Less than 2,596 — 0.4700 432.1835; Less than 3,577 — 0.5400 613.9142;
 * Less than 3,653 — 0.4700 363.4615; 3,653 & over — 0.5500 655.7692".
 */
export const AU_SCHEDULE1_SCALE5_STSL_2027: readonly AuSchedule1Row[] = [
  { lessThan: "362", a: null, b: null },
  { lessThan: "721", a: "0.1500", b: "54.3462" },
  { lessThan: "865", a: "0.1590", b: "60.8365" },
  { lessThan: "1282", a: "0.3027", b: "185.1923" },
  { lessThan: "1337", a: "0.3000", b: "181.7308" },
  { lessThan: "2494", a: "0.4500", b: "382.2923" },
  { lessThan: "2596", a: "0.4700", b: "432.1835" },
  { lessThan: "3577", a: "0.5400", b: "613.9142" },
  { lessThan: "3653", a: "0.4700", b: "363.4615" },
  { lessThan: null, a: "0.5500", b: "655.7692" },
];

/**
 * Scale 6 with STSL debt (Schedule 8 combined table) — "Where payee
 * claimed HALF exemption from Medicare levy in Medicare levy variation
 * declaration – scale 6 With study and training support loans debt":
 * "Less than 362 — – –; Less than 721 — 0.1500 54.3462;
 * Less than 865 — 0.1590 60.8365; Less than 908 — 0.3027 185.1923;
 * Less than 1,135 — 0.3527 230.6135; Less than 1,282 — 0.3127 185.1923;
 * Less than 1,337 — 0.3100 181.7308; Less than 2,494 — 0.4600 382.2923;
 * Less than 2,596 — 0.4800 432.1835; Less than 3,577 — 0.5500 613.9142;
 * Less than 3,653 — 0.4800 363.4615; 3,653 & over — 0.5600 655.7692".
 */
export const AU_SCHEDULE1_SCALE6_STSL_2027: readonly AuSchedule1Row[] = [
  { lessThan: "362", a: null, b: null },
  { lessThan: "721", a: "0.1500", b: "54.3462" },
  { lessThan: "865", a: "0.1590", b: "60.8365" },
  { lessThan: "908", a: "0.3027", b: "185.1923" },
  { lessThan: "1135", a: "0.3527", b: "230.6135" },
  { lessThan: "1282", a: "0.3127", b: "185.1923" },
  { lessThan: "1337", a: "0.3100", b: "181.7308" },
  { lessThan: "2494", a: "0.4600", b: "382.2923" },
  { lessThan: "2596", a: "0.4800", b: "432.1835" },
  { lessThan: "3577", a: "0.5500", b: "613.9142" },
  { lessThan: "3653", a: "0.4800", b: "363.4615" },
  { lessThan: null, a: "0.5600", b: "655.7692" },
];

/**
 * Schedule 8 STSL component rates for the record: "Tax-free threshold
 * claimed or foreign resident — Less than 1,337 — – –;
 * Less than 2,494 — 0.15 200.5615; Less than 3,577 — 0.17 250.4527;
 * 3,577 & over — 0.10 0.0000" and "No tax-free threshold claimed —
 * Less than 987 — – –; Less than 2,144 — 0.15 148.0615;
 * Less than 2,727 — 0.17 190.9527; 2,727 & over — 0.10 0.0000".
 * The engine withholds via the combined tables above, not by adding these.
 */
export const AU_SCHEDULE8_STSL_THRESHOLD_2027: readonly AuSchedule1Row[] = [
  { lessThan: "1337", a: null, b: null },
  { lessThan: "2494", a: "0.15", b: "200.5615" },
  { lessThan: "3577", a: "0.17", b: "250.4527" },
  { lessThan: null, a: "0.10", b: "0.0000" },
];

export const AU_SCHEDULE8_STSL_NO_THRESHOLD_2027: readonly AuSchedule1Row[] = [
  { lessThan: "987", a: null, b: null },
  { lessThan: "2144", a: "0.15", b: "148.0615" },
  { lessThan: "2727", a: "0.17", b: "190.9527" },
  { lessThan: null, a: "0.10", b: "0.0000" },
];
