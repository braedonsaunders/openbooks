import type { CapTable } from "@openbooks/engine/equity";

/**
 * The cap table as the filtered table reads it: one dimension (share class
 * or holder) and one instrument (every instrument, or shares, options, RSUs
 * or warrants). The rows and columns follow from the two filters; counts
 * stay exact whole-share strings and every total is summed in bigint.
 */

export const CAP_TABLE_DIMENSIONS = ["class", "holder"] as const;
export type CapTableDimension = (typeof CAP_TABLE_DIMENSIONS)[number];
export const CAP_TABLE_INSTRUMENTS = ["share", "option", "rsu", "warrant"] as const;
export type CapTableInstrument = (typeof CAP_TABLE_INSTRUMENTS)[number] | "all";

/** A column: a fixed measure, or one share class's issued shares on the holder dimension. */
export type CapTableColumn =
  | {
      key:
        | "authorized"
        | "outstanding"
        | "asConverted"
        | "awards"
        | "pool"
        | "fullyDiluted"
        | "options"
        | "rsus"
        | "warrants"
        | "instrumentOutstanding"
        | "vested"
        | "unvested";
      kind: "shares";
    }
  | { key: "outstandingPercent" | "fullyDilutedPercent"; kind: "percent" }
  | { key: `class:${string}`; kind: "shares"; code: string };

export interface CapTableLine {
  key: string;
  /** The share class or the holder the line is for. */
  shareClassId: string | null;
  holderPartyId: string | null;
  /** The holder basis's line for the plans' unallocated pool. */
  pool?: true;
  values: Record<string, string>;
}

export interface CapTableLayout {
  columns: CapTableColumn[];
  lines: CapTableLine[];
  /**
   * The totals row: every share-count column summed (authorized included),
   * and each percentage column as the lines' share of the whole cap table,
   * so a search or an instrument filter totals what it shows.
   */
  totals: Record<string, string>;
}

export function parseDimension(value: string | undefined | null): CapTableDimension {
  return value === "holder" ? "holder" : "class";
}

export function parseInstrument(value: string | undefined | null): CapTableInstrument {
  return (CAP_TABLE_INSTRUMENTS as readonly string[]).includes(value ?? "")
    ? (value as CapTableInstrument)
    : "all";
}

const big = (value: string | undefined): bigint =>
  value && /^-?\d+$/.test(value) ? BigInt(value) : 0n;

/** `part` of `whole` as a percentage to four places, rounded half up, in exact integer arithmetic. */
export function exactPercent(part: bigint, whole: bigint): string {
  if (whole <= 0n) return "0.0000";
  const negative = part < 0n;
  const scaled = ((negative ? -part : part) * 1_000_000n * 2n + whole) / (whole * 2n);
  const text = scaled.toString().padStart(5, "0");
  return `${negative && scaled > 0n ? "-" : ""}${text.slice(0, -4)}.${text.slice(-4)}`;
}

/** The share-count measure each percentage column is a share of. */
const PERCENT_BASIS = {
  outstandingPercent: "asConverted",
  fullyDilutedPercent: "fullyDiluted",
} as const;

function sumColumns(
  table: CapTable,
  columns: CapTableColumn[],
  lines: CapTableLine[],
): Record<string, string> {
  const totals: Record<string, string> = {};
  const sum = (key: string) => lines.reduce((acc, line) => acc + big(line.values[key]), 0n);
  for (const column of columns) {
    if (column.kind === "shares") totals[column.key] = sum(column.key).toString();
  }
  for (const column of columns) {
    if (column.kind !== "percent") continue;
    const basis = PERCENT_BASIS[column.key];
    const whole =
      basis === "asConverted"
        ? big(table.totals.asConvertedOutstanding)
        : big(table.totals.fullyDiluted);
    totals[column.key] = exactPercent(sum(basis), whole);
  }
  return totals;
}

type AwardKind = "option" | "rsu" | "warrant";

/** Outstanding, vested and unvested units of one award kind, per share class and per holder. */
function awardPositions(table: CapTable, kind: AwardKind) {
  const byClass = new Map<string, { outstanding: bigint; vested: bigint; unvested: bigint }>();
  const byHolder = new Map<string, { outstanding: bigint; vested: bigint; unvested: bigint }>();
  for (const holding of table.holdings) {
    if (holding.kind !== kind || big(holding.outstanding) === 0n) continue;
    for (const [map, key] of [
      [byClass, holding.shareClassId],
      [byHolder, holding.holderPartyId],
    ] as const) {
      const row = map.get(key) ?? { outstanding: 0n, vested: 0n, unvested: 0n };
      row.outstanding += big(holding.outstanding);
      row.vested += big(holding.vested);
      row.unvested += big(holding.unvested);
      map.set(key, row);
    }
  }
  return { byClass, byHolder };
}

const positionValues = (row: { outstanding: bigint; vested: bigint; unvested: bigint }) => ({
  instrumentOutstanding: row.outstanding.toString(),
  vested: row.vested.toString(),
  unvested: row.unvested.toString(),
});

/** Every filter the cap table view applies; the export applies the same ones. */
export interface CapTableFilters {
  dimension: CapTableDimension;
  instrument: CapTableInstrument;
  /** Text search over the class code and name, or the holder's name. */
  query: string;
}

/** The filters a cap table URL (the page's, or its export's) carries. */
export function capTableFilters(params: {
  by?: string | null;
  instrument?: string | null;
  q?: string | null;
}): CapTableFilters {
  return {
    dimension: parseDimension(params.by),
    instrument: parseInstrument(params.instrument),
    query: (params.q ?? "").trim(),
  };
}

/**
 * Rows and columns of the cap table for its filters. A search keeps the
 * lines whose class code or name, or holder name, contains the text (case
 * folded), and the totals sum the lines that remain.
 */
export function capTableLayout(
  table: CapTable,
  filters: CapTableFilters,
  parties: Readonly<Record<string, string>> = {},
): CapTableLayout {
  const { dimension, instrument } = filters;
  const layout = unfilteredLayout(table, dimension, instrument);
  const query = filters.query.toLocaleLowerCase();
  if (!query) return layout;
  const classes = new Map(
    table.classes.map((row) => [row.shareClassId, `${row.code} ${row.name}`]),
  );
  // A search names classes or holders; the pool line belongs to neither.
  const lines = layout.lines.filter((line) => {
    if (line.pool) return false;
    const text = line.shareClassId
      ? (classes.get(line.shareClassId) ?? "")
      : (parties[line.holderPartyId ?? ""] ?? "");
    return text.toLocaleLowerCase().includes(query);
  });
  return { columns: layout.columns, lines, totals: sumColumns(table, layout.columns, lines) };
}

function unfilteredLayout(
  table: CapTable,
  dimension: CapTableDimension,
  instrument: CapTableInstrument,
): CapTableLayout {
  const award =
    instrument === "option" || instrument === "rsu" || instrument === "warrant" ? instrument : null;
  let columns: CapTableColumn[];
  let lines: CapTableLine[];
  if (dimension === "class") {
    if (award) {
      const { byClass } = awardPositions(table, award);
      columns = [
        { key: "instrumentOutstanding", kind: "shares" },
        { key: "vested", kind: "shares" },
        { key: "unvested", kind: "shares" },
      ];
      lines = table.classes
        .filter((row) => byClass.has(row.shareClassId))
        .map((row) => ({
          key: row.shareClassId,
          shareClassId: row.shareClassId,
          holderPartyId: null,
          values: positionValues(byClass.get(row.shareClassId)!),
        }));
    } else if (instrument === "share") {
      columns = [
        { key: "authorized", kind: "shares" },
        { key: "outstanding", kind: "shares" },
        { key: "asConverted", kind: "shares" },
        { key: "outstandingPercent", kind: "percent" },
      ];
      lines = table.classes.map((row) => ({
        key: row.shareClassId,
        shareClassId: row.shareClassId,
        holderPartyId: null,
        values: {
          authorized: row.authorized,
          outstanding: row.outstanding,
          asConverted: row.asConvertedOutstanding,
          outstandingPercent: row.outstandingPercent,
        },
      }));
    } else {
      columns = [
        { key: "authorized", kind: "shares" },
        { key: "outstanding", kind: "shares" },
        { key: "asConverted", kind: "shares" },
        { key: "awards", kind: "shares" },
        { key: "pool", kind: "shares" },
        { key: "fullyDiluted", kind: "shares" },
        { key: "outstandingPercent", kind: "percent" },
        { key: "fullyDilutedPercent", kind: "percent" },
      ];
      lines = table.classes.map((row) => ({
        key: row.shareClassId,
        shareClassId: row.shareClassId,
        holderPartyId: null,
        values: {
          authorized: row.authorized,
          outstanding: row.outstanding,
          asConverted: row.asConvertedOutstanding,
          awards: row.awardsOutstanding,
          pool: row.poolAvailable,
          fullyDiluted: row.fullyDiluted,
          outstandingPercent: row.outstandingPercent,
          fullyDilutedPercent: row.fullyDilutedPercent,
        },
      }));
    }
  } else if (award) {
    const { byHolder } = awardPositions(table, award);
    columns = [
      { key: "instrumentOutstanding", kind: "shares" },
      { key: "vested", kind: "shares" },
      { key: "unvested", kind: "shares" },
    ];
    lines = table.holders
      .filter((row) => byHolder.has(row.holderPartyId))
      .map((row) => ({
        key: row.holderPartyId,
        shareClassId: null,
        holderPartyId: row.holderPartyId,
        values: positionValues(byHolder.get(row.holderPartyId)!),
      }));
  } else {
    const classColumns: CapTableColumn[] = table.classes.map((row) => ({
      key: `class:${row.shareClassId}`,
      kind: "shares",
      code: row.code,
    }));
    const holders =
      instrument === "share"
        ? table.holders.filter((row) => big(row.asConvertedOutstanding) > 0n)
        : table.holders;
    columns =
      instrument === "share"
        ? [
            ...classColumns,
            { key: "asConverted", kind: "shares" },
            { key: "outstandingPercent", kind: "percent" },
          ]
        : [
            ...classColumns,
            { key: "options", kind: "shares" },
            { key: "rsus", kind: "shares" },
            { key: "warrants", kind: "shares" },
            { key: "fullyDiluted", kind: "shares" },
            { key: "outstandingPercent", kind: "percent" },
            { key: "fullyDilutedPercent", kind: "percent" },
          ];
    lines = holders.map((row): CapTableLine => ({
      key: row.holderPartyId,
      shareClassId: null,
      holderPartyId: row.holderPartyId,
      values: {
        ...Object.fromEntries(
          table.classes.map((shareClass) => [
            `class:${shareClass.shareClassId}`,
            row.sharesByClass[shareClass.shareClassId] ?? "0",
          ]),
        ),
        asConverted: row.asConvertedOutstanding,
        options: row.options,
        rsus: row.rsus,
        warrants: row.warrants,
        fullyDiluted: row.fullyDiluted,
        outstandingPercent: row.outstandingPercent,
        fullyDilutedPercent: row.fullyDilutedPercent,
      },
    }));
    // Fully diluted by holder includes the shares the plans still hold
    // unallocated, so the holders and the pool add up to the class basis.
    if (instrument === "all" && big(table.unallocatedPool.fullyDiluted) > 0n) {
      lines.push({
        key: "pool",
        shareClassId: null,
        holderPartyId: null,
        pool: true,
        values: {
          ...Object.fromEntries(
            table.classes.map((shareClass) => [`class:${shareClass.shareClassId}`, "0"]),
          ),
          asConverted: "0",
          options: "0",
          rsus: "0",
          warrants: "0",
          fullyDiluted: table.unallocatedPool.fullyDiluted,
          fullyDilutedPercent: table.unallocatedPool.fullyDilutedPercent,
        },
      });
    }
  }
  return { columns, lines, totals: sumColumns(table, columns, lines) };
}
