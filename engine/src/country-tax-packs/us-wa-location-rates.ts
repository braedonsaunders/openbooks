/**
 * Washington location-code sales and use tax rates, quarter by quarter.
 *
 * The Department of Revenue publishes the full local table every quarter as
 * an Excel workbook ("Excel (sortable) alphabetical by city") on its local
 * sales and use tax page, alongside the quarterly change flyers:
 *
 *   https://dor.wa.gov/taxes-rates/sales-use-tax-rates/local-sales-use-tax
 *   https://dor.wa.gov/sites/default/files/2026-08/Q426_Excel_LSU-rates-alpha.xlsx
 *
 * Each workbook names its effective quarter on the title row ("Effective
 * October 1 - December 31, 2026") and carries one row per sales-tax
 * location: county, location name, four-digit-style location code, local
 * rate, state rate, and combined rate as decimals (0.04 is 4%). Changed
 * rows are marked in the workbook; the combined rate always equals local
 * plus state.
 *
 * OpenBooks does not install four hundred location codes as tax codes.
 * The operator looks up the location rate for the filing quarter here,
 * prices their location's tax code from it, and reports location detail in
 * the local section of the Washington Combined Excise Tax Return. This
 * module is the native form of that table: `loadWaLocationRateQuarter`
 * validates one published quarter (exact-decimal arithmetic, declared
 * source, quarter stamping), `parseWaLocationRateCsv` reads a CSV export
 * of the workbook sheet, and `waLocationRateOn` answers the rate for a
 * location code on a date. To load a new quarter, download its workbook,
 * export the rate sheet to CSV, and pass the text with the quarter id and
 * the workbook's file citation; the importer refuses anything that does
 * not add up rather than carrying a wrong rate.
 */

/** One published quarterly file behind a loaded quarter. */
export interface WaLocationRateSource {
  id: string;
  title: string;
  url: string;
  /** Date the file was retrieved, yyyy-mm-dd. */
  asOf: string;
}

/** One location row as transcribed from the published sheet. */
export interface WaLocationRateInputRow {
  county: string;
  locationName: string;
  /** DOR location code as printed (for example "2717"). */
  locationCode: string;
  /** Sheet decimals: 0.04 is 4%. */
  localRate: string;
  stateRate: string;
  combinedRate: string;
}

/** One validated, effective-dated location rate. Percents: 4 is 4%. */
export interface WaLocationRateRow {
  county: string;
  locationName: string;
  locationCode: string;
  localRatePercent: string;
  stateRatePercent: string;
  combinedRatePercent: string;
  effectiveFrom: string;
  effectiveTo: string;
  sourceId: string;
}

export type WaLocationRateTable = readonly WaLocationRateRow[];

const QUARTER_MONTHS: Readonly<Record<string, { from: string; to: string }>> = {
  Q1: { from: "-01-01", to: "-03-31" },
  Q2: { from: "-04-01", to: "-06-30" },
  Q3: { from: "-07-01", to: "-09-30" },
  Q4: { from: "-10-01", to: "-12-31" },
};

/** Effective window of a Washington sales-tax quarter such as "2026-Q4". */
export function waLocationQuarterWindow(quarter: string): { effectiveFrom: string; effectiveTo: string } {
  const match = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!match) {
    throw new Error(
      `unknown Washington sales-tax quarter "${quarter}"; use yyyy-Qn (for example 2026-Q4), the department's own quarter naming`,
    );
  }
  const months = QUARTER_MONTHS[`Q${match[2]}`]!;
  return { effectiveFrom: `${match[1]}${months.from}`, effectiveTo: `${match[1]}${months.to}` };
}

/** Decimal string to exact basis points (1/100 of a percent point): "0.0258" is 258. */
function toBasisPoints(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 10000 + Number((match[2] ?? "").padEnd(4, "0"));
}

/** Sheet decimal to pack percent string: "0.0258" is "2.58". */
function toPercent(decimal: string): string {
  const basisPoints = toBasisPoints(decimal)!;
  const whole = Math.trunc(basisPoints / 100);
  const rest = String(basisPoints % 100).padStart(2, "0").replace(/0+$/, "");
  return rest === "" ? String(whole) : `${whole}.${rest}`;
}

/** Round a float-artifact decimal (0.10500000000000001) to four places. */
function roundArtifact(decimal: string): string {
  const num = Number(decimal);
  if (!Number.isFinite(num)) return decimal;
  return String(Math.round(num * 10000) / 10000);
}

function problem(rowLabel: string, detail: string, remedy: string): Error {
  return new Error(`Washington location ${rowLabel} ${detail} — ${remedy}`);
}

export interface WaLocationRateQuarterSpec {
  /** Department quarter id, yyyy-Qn. */
  quarter: string;
  source: WaLocationRateSource;
  rows: readonly WaLocationRateInputRow[];
  /**
   * State share every row must carry (the 6.5% state rate). Passed in so
   * the table can never silently drift from the taxed state rate: a future
   * state-rate change refuses the load until this expectation is updated.
   */
  expectedStateRatePercent: string;
}

/**
 * Validate one published quarter into an effective-dated table. Refuses,
 * naming the row: an unknown quarter, a malformed location code, a rate
 * that is not an exact decimal, a combined rate that is not local plus
 * state, a state share that moved, or a location code listed twice.
 */
export function loadWaLocationRateQuarter(spec: WaLocationRateQuarterSpec): WaLocationRateTable {
  const { effectiveFrom, effectiveTo } = waLocationQuarterWindow(spec.quarter);
  const seen = new Set<string>();
  return spec.rows.map((row) => {
    const label = `"${row.locationName}" (${row.locationCode || "no code"})`;
    const code = row.locationCode.trim();
    if (!/^\d{1,4}$/.test(code)) {
      throw problem(label, "has no numeric DOR location code", "re-export the department sheet without editing codes");
    }
    if (seen.has(code)) {
      throw problem(label, `repeats location code ${code} in ${spec.quarter}`, "keep one row per location code per quarter");
    }
    seen.add(code);
    const local = toBasisPoints(row.localRate);
    const state = toBasisPoints(row.stateRate);
    const combined = toBasisPoints(row.combinedRate);
    if (local === null || local < 0 || local > 200000) {
      throw problem(label, `carries an unusable local rate "${row.localRate}"`, "re-export the department sheet without editing rates");
    }
    if (state === null || combined === null) {
      throw problem(label, "carries an unusable state or combined rate", "re-export the department sheet without editing rates");
    }
    if (local + state !== combined) {
      throw problem(
        label,
        `does not add up (local ${row.localRate} + state ${row.stateRate} is not combined ${row.combinedRate})`,
        "re-export the department sheet without editing rates",
      );
    }
    if (toPercent(row.stateRate) !== spec.expectedStateRatePercent) {
      throw problem(
        label,
        `carries state share ${toPercent(row.stateRate)}% instead of the expected ${spec.expectedStateRatePercent}%`,
        "confirm the statewide rate change with the department, then update the expected state share",
      );
    }
    if (!row.county.trim() || !row.locationName.trim()) {
      throw problem(label, "names no county or location", "re-export the department sheet without editing names");
    }
    return {
      county: row.county.trim(),
      locationName: row.locationName.trim(),
      locationCode: code,
      localRatePercent: toPercent(row.localRate),
      stateRatePercent: toPercent(row.stateRate),
      combinedRatePercent: toPercent(row.combinedRate),
      effectiveFrom,
      effectiveTo,
      sourceId: spec.source.id,
    };
  });
}

/** Split one CSV line on commas honoring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      fields.push(field);
      field = "";
      continue;
    }
    field += char;
  }
  fields.push(field);
  return fields.map((entry) => entry.trim());
}

function isHeaderRow(fields: readonly string[]): boolean {
  const joined = fields.join(" ").toLowerCase();
  return joined.includes("location code") && joined.includes("local") && joined.includes("combined");
}

function columnIndex(fields: readonly string[], ...names: readonly string[]): number {
  const lowered = fields.map((field) => field.toLowerCase().replace(/\s+/g, " "));
  for (const name of names) {
    const found = lowered.findIndex((field) => field.includes(name));
    if (found >= 0) return found;
  }
  return -1;
}

/**
 * Read a CSV export of the department's quarterly workbook sheet: the
 * title row, the header row (County, Location name, Location code, Local
 * rate, State rate, Combined sales tax), the location rows, and the
 * footnote block. Title and footnote rows carry no numeric location code
 * with three rate decimals and are skipped; every other row must parse as
 * a location or the load refuses naming the line. Workbook float
 * artifacts (0.10500000000000001) are rounded to four places before the
 * arithmetic check, which still refuses a genuinely edited rate.
 */
export function parseWaLocationRateCsv(csvText: string): WaLocationRateInputRow[] {
  const lines = csvText.split(/\r?\n/);
  let header: readonly string[] | null = null;
  const rows: WaLocationRateInputRow[] = [];
  for (const [lineNumber, line] of lines.entries()) {
    if (!line.trim()) continue;
    const fields = splitCsvLine(line);
    if (!header) {
      if (isHeaderRow(fields)) header = fields;
      continue;
    }
    const county = fields[columnIndex(header, "county")] ?? "";
    const locationName = fields[columnIndex(header, "location name")] ?? "";
    const locationCode = fields[columnIndex(header, "location code")] ?? "";
    const localRate = roundArtifact(fields[columnIndex(header, "local rate")] ?? "");
    const stateRate = roundArtifact(fields[columnIndex(header, "state rate")] ?? "");
    const combinedRate = roundArtifact(fields[columnIndex(header, "combined")] ?? "");
    const looksLikeData = /^\d{1,4}$/.test(locationCode.trim())
      && toBasisPoints(localRate) !== null
      && toBasisPoints(stateRate) !== null
      && toBasisPoints(combinedRate) !== null;
    if (!looksLikeData) continue;
    if (!county.trim() || !locationName.trim()) {
      throw new Error(
        `Washington location CSV line ${lineNumber + 1} has rates but names no county or location — `
        + `re-export the department sheet without editing names`,
      );
    }
    rows.push({ county, locationName, locationCode, localRate, stateRate, combinedRate });
  }
  if (!header) {
    throw new Error(
      "Washington location CSV has no department header row (County, Location name, Location code, Local rate, State rate, Combined sales tax) — "
      + "export the quarterly rate sheet to CSV without rearranging columns",
    );
  }
  if (rows.length === 0) {
    throw new Error(
      "Washington location CSV carries no location rows past the header — "
      + "export the full quarterly rate sheet, not the change flyer",
    );
  }
  return rows;
}

/**
 * The published rate for a location code on a date (yyyy-mm-dd), or
 * undefined when no loaded quarter covers it. Callers refuse an unknown
 * location or date by name with the department table as the remedy; an
 * undefined here is never priced as zero.
 */
export function waLocationRateOn(
  table: WaLocationRateTable,
  locationCode: string,
  date: string,
): WaLocationRateRow | undefined {
  return table.find(
    (row) => row.locationCode === locationCode.trim() && row.effectiveFrom <= date && date <= row.effectiveTo,
  );
}

/**
 * Validated extract of three published quarters: Tacoma 2717 at 10.4% for
 * Q2 2026 and 10.5% from Q3 2026, Puyallup Tribe – Tacoma 2741 matching
 * it, Algona 1701 at 10.4%, and Adams County unincorporated areas at 8%.
 * A transcription sample proving the importer, not the full four hundred
 * locations: load each new quarter's workbook through
 * parseWaLocationRateCsv plus loadWaLocationRateQuarter.
 */
const WA_LOCATION_RATE_SOURCES: Readonly<Record<string, WaLocationRateSource>> = {
  wa_dor_lsu_q2_2026: {
    id: "wa_dor_lsu_q2_2026",
    title: "Washington Department of Revenue — City of Tacoma local law enforcement programs change notice, quarter 2 (April 1 – June 30, 2026)",
    url: "https://dor.wa.gov/sites/default/files/2026-01/Q226_Tacoma_LLEP.pdf",
    asOf: "2026-10-10",
  },
  wa_dor_lsu_q3_2026: {
    id: "wa_dor_lsu_q3_2026",
    title: "Washington Department of Revenue — Local sales and use tax rates, quarter 3 (July 1 – September 30, 2026)",
    url: "https://dor.wa.gov/sites/default/files/2026-05/Q326_Excel_LSU-rates-alpha.xlsx",
    asOf: "2026-10-10",
  },
  wa_dor_lsu_q4_2026: {
    id: "wa_dor_lsu_q4_2026",
    title: "Washington Department of Revenue — Local sales and use tax rates, quarter 4 (October 1 – December 31, 2026)",
    url: "https://dor.wa.gov/sites/default/files/2026-08/Q426_Excel_LSU-rates-alpha.xlsx",
    asOf: "2026-10-10",
  },
};

function quarterFixture(
  quarter: string,
  sourceId: keyof typeof WA_LOCATION_RATE_SOURCES,
  rows: ReadonlyArray<
    [county: string, locationName: string, locationCode: string, localRate: string, combinedRate: string]
  >,
): WaLocationRateTable {
  return loadWaLocationRateQuarter({
    quarter,
    source: WA_LOCATION_RATE_SOURCES[sourceId],
    expectedStateRatePercent: "6.5",
    rows: rows.map(([county, locationName, locationCode, localRate, combinedRate]) => ({
      county,
      locationName,
      locationCode,
      localRate,
      stateRate: "0.065",
      combinedRate,
    })),
  });
}

export const WA_LOCATION_RATE_FIXTURE: WaLocationRateTable = [
  ...quarterFixture("2026-Q2", "wa_dor_lsu_q2_2026", [["Pierce", "Tacoma", "2717", "0.039", "0.104"]]),
  ...quarterFixture("2026-Q3", "wa_dor_lsu_q3_2026", [
    ["Pierce", "Tacoma", "2717", "0.04", "0.105"],
    ["Pierce", "Puyallup Tribe - Tacoma", "2741", "0.04", "0.105"],
    ["King", "Algona", "1701", "0.039", "0.104"],
    ["Adams", "Adams County Unincorp. Areas", "100", "0.015", "0.08"],
  ]),
  ...quarterFixture("2026-Q4", "wa_dor_lsu_q4_2026", [
    ["Pierce", "Tacoma", "2717", "0.04", "0.105"],
    ["Pierce", "Puyallup Tribe - Tacoma", "2741", "0.04", "0.105"],
    ["King", "Algona", "1701", "0.039", "0.104"],
    ["Adams", "Adams County Unincorp. Areas", "100", "0.015", "0.08"],
  ]),
];

