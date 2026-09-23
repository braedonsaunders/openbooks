/**
 * HR-20 pure field-time math: rounding, break subtraction, geofence
 * containment, clock sequencing, stage validation, equipment tolerance.
 *
 * Pure on purpose — no database, no clock — so the unit partition owns
 * every rule and the services only wire rows through them.
 */

import { FieldTimeError } from "./errors.ts";
import { canonicalTimeZone } from "../../platform/time-zone.ts";

export type RoundingMode = "nearest" | "up" | "down";

export interface RoundingRule {
  /** 0 = none, otherwise 6 or 15. Anything else is refused, never guessed. */
  incrementMinutes: number;
  mode: RoundingMode;
}

const SCALE = 10_000n;

function parseTenThousandths(hours: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(hours.trim());
  if (!m) throw new FieldTimeError("invalid_hours", `Hours ${JSON.stringify(hours)} are not a non-negative number with at most 4 decimals — re-enter the hours`);
  const frac = (m[2] ?? "").padEnd(4, "0");
  return BigInt(m[1]!) * SCALE + BigInt(frac);
}

function formatTenThousandths(v: bigint): string {
  const neg = v < 0n ? "-" : "";
  const abs = v < 0n ? -v : v;
  const whole = abs / SCALE;
  const frac = String(abs % SCALE).padStart(4, "0");
  return `${neg}${whole}.${frac}`;
}

/**
 * Round hours per the org's declared rounding rule. incrementMinutes 0
 * means none (exact). 6 minutes = a tenth of an hour, 15 = a quarter.
 */
export function roundHours(hours: string, rule: RoundingRule): string {
  if (rule.incrementMinutes === 0) return formatTenThousandths(parseTenThousandths(hours));
  if (rule.incrementMinutes !== 6 && rule.incrementMinutes !== 15) {
    throw new FieldTimeError(
      "invalid_rounding_rule",
      `Rounding increment ${rule.incrementMinutes} is not a declared rule — set rounding to none, 6 or 15 minutes in Timesheets setup`,
    );
  }
  if (rule.mode !== "nearest" && rule.mode !== "up" && rule.mode !== "down") {
    throw new FieldTimeError(
      "invalid_rounding_mode",
      `Rounding mode ${JSON.stringify(rule.mode)} is not declared — set it to nearest, up or down in Timesheets setup`,
    );
  }
  const value = parseTenThousandths(hours);
  // 6 min = 1000 ten-thousandths of an hour; 15 min = 2500.
  const step = rule.incrementMinutes === 6 ? 1000n : 2500n;
  const base = value / step;
  const rem = value % step;
  let rounded = base;
  if (rule.mode === "up") {
    if (rem !== 0n) rounded = base + 1n;
  } else if (rule.mode === "nearest") {
    if (rem * 2n >= step) rounded = base + 1n;
  }
  return formatTenThousandths(rounded * step);
}

/**
 * Largest-remainder deal: split `total` whole units across `weights`
 * so the shares sum to exactly `total`. Each share is floored, then
 * the leftover units go to the largest fractional remainders with
 * ties broken to the earlier index — deterministic for any input.
 * Zero weights deal zero; an all-zero weight vector deals all zero.
 */
export function distributeProRata(total: number, weights: number[]): number[] {
  if (!Number.isInteger(total) || total < 0) {
    throw new FieldTimeError(
      "invalid_break_rule",
      `Pro-rata total ${String(total)} is not declared — split a whole non-negative number of units`,
    );
  }
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) {
      throw new FieldTimeError(
        "invalid_break_rule",
        `Pro-rata weight ${String(w)} is not declared — weights must be finite and non-negative`,
      );
    }
  }
  const out = new Array<number>(weights.length).fill(0);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || weightSum <= 0) return out;
  const remainders: Array<{ index: number; rem: number }> = [];
  let assigned = 0;
  for (let i = 0; i < weights.length; i++) {
    const floored = Math.floor((total * weights[i]!) / weightSum);
    out[i] = floored;
    assigned += floored;
    remainders.push({ index: i, rem: (total * weights[i]!) / weightSum - floored });
  }
  remainders.sort((a, b) => b.rem - a.rem || a.index - b.index);
  for (let k = 0; k < total - assigned; k++) {
    const target = remainders[k % remainders.length]!.index;
    out[target] = out[target]! + 1;
  }
  return out;
}

/**
 * Net shift milliseconds: the larger of recorded breaks and the
 * declared unpaid rule is deducted, never below zero. Recorded breaks
 * replace the auto-deduction up to their length instead of stacking
 * on top of it.
 */
export function netShiftMs(grossMs: number, recordedBreakMs: number, unpaidBreakMinutes: number): number {
  for (const [name, value] of [["gross", grossMs], ["recorded breaks", recordedBreakMs], ["unpaid rule", unpaidBreakMinutes]] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new FieldTimeError(
        "invalid_break_rule",
        `Break ${name} ${String(value)} is not declared — set unpaid break minutes to 0 or more in Timesheets setup`,
      );
    }
  }
  return Math.max(0, grossMs - Math.max(recordedBreakMs, unpaidBreakMinutes * 60_000));
}

/**
 * Shift-level net milliseconds per segment. The declared unpaid break
 * is deducted ONCE per shift, never once per project segment: recorded
 * breaks stay in their own segment, and the remainder of the declared
 * rule not already covered by recorded breaks is dealt across segments
 * pro-rata by worked time (largest remainder, deterministic). The
 * returned nets sum to exactly
 * netShiftMs(totalGross, totalRecorded, unpaidBreakMinutes) — up to
 * whole-millisecond resolution when the declared rule names a fraction
 * of a minute.
 */
export function allocateShiftNetMs(
  grossMs: number[],
  recordedBreakMs: number[],
  unpaidBreakMinutes: number,
): number[] {
  if (grossMs.length !== recordedBreakMs.length) {
    throw new FieldTimeError(
      "invalid_break_rule",
      "Shift segments and their breaks do not line up — re-record the clock events so every segment carries its break time",
    );
  }
  for (const [name, values] of [["gross", grossMs], ["recorded breaks", recordedBreakMs]] as const) {
    for (const value of values) {
      if (!Number.isFinite(value) || value < 0) {
        throw new FieldTimeError(
          "invalid_break_rule",
          `Break ${name} ${String(value)} is not declared — set unpaid break minutes to 0 or more in Timesheets setup`,
        );
      }
    }
  }
  if (!Number.isFinite(unpaidBreakMinutes) || unpaidBreakMinutes < 0) {
    throw new FieldTimeError(
      "invalid_break_rule",
      `Break unpaid rule ${String(unpaidBreakMinutes)} is not declared — set unpaid break minutes to 0 or more in Timesheets setup`,
    );
  }
  const capped = recordedBreakMs.map((r, i) => Math.min(r, grossMs[i]!));
  const bases = grossMs.map((g, i) => g - capped[i]!);
  const totalRecorded = capped.reduce((a, b) => a + b, 0);
  const totalBase = bases.reduce((a, b) => a + b, 0);
  // The declared rule applies shift-wide: recorded breaks cover it
  // first, and only the uncovered remainder is auto-deducted.
  const residual = Math.max(0, Math.round(unpaidBreakMinutes * 60_000) - totalRecorded);
  const deductible = Math.min(residual, totalBase);
  const dealt = distributeProRata(deductible, bases);
  return bases.map((b, i) => b - dealt[i]!);
}

/**
 * The rounding quantum in ten-thousandths of an hour: 6 minutes is a
 * tenth (1000), 15 minutes a quarter (2500), no rounding a single
 * 0.0001h unit. Round-once dealing posts whole quanta per day piece so
 * the posted entries sum to exactly the rounded shift total.
 */
export function roundingQuantumUnits(rule: RoundingRule): number {
  if (rule.incrementMinutes === 0) return 1;
  if (rule.incrementMinutes === 6) return 1000;
  if (rule.incrementMinutes === 15) return 2500;
  throw new FieldTimeError(
    "invalid_rounding_rule",
    `Rounding increment ${rule.incrementMinutes} is not a declared rule — set rounding to none, 6 or 15 minutes in Timesheets setup`,
  );
}

/** Whole quanta in a rounded hours value (the exact output of roundHours). */
export function hoursToQuantumUnits(hours: string, rule: RoundingRule): number {
  const quantum = roundingQuantumUnits(rule);
  const m = /^(\d+)\.(\d{4})$/.exec(hours.trim());
  if (!m) {
    throw new FieldTimeError(
      "invalid_hours",
      `Hours ${JSON.stringify(hours)} are not a rounded hours value — round the shift total before dealing it across days`,
    );
  }
  const total = BigInt(m[1]!) * SCALE + BigInt(m[2]!);
  if (total % BigInt(quantum) !== 0n) {
    throw new FieldTimeError(
      "invalid_hours",
      `Hours ${JSON.stringify(hours)} are not a whole multiple of the rounding rule — round the shift total before dealing it across days`,
    );
  }
  return Number(total / BigInt(quantum));
}

/** Back to a 4-decimal hours value from whole quanta. */
export function quantumUnitsToHours(units: number, rule: RoundingRule): string {
  if (!Number.isInteger(units) || units < 0) {
    throw new FieldTimeError(
      "invalid_hours",
      `Quanta ${String(units)} are not a whole non-negative count — deal whole rounding units across days`,
    );
  }
  return formatTenThousandths(BigInt(units) * BigInt(roundingQuantumUnits(rule)));
}

export interface DayPiece {
  date: string;
  /** Whole milliseconds of the span falling on this zone-local date. */
  ms: number;
}

/**
 * An IANA zone the runtime can day in, or a refusal that names the
 * remedy. Validated through the shared platform zone validator (which
 * accepts every zone Intl.DateTimeFormat accepts and canonicalizes
 * aliases), so this module keeps no second copy of the rule. The remedy
 * names the real setting: Business time zone in Company Settings →
 * Organization.
 */
function requireTimeZone(timeZone: string): string {
  const canonical = canonicalTimeZone(timeZone);
  if (!canonical) {
    throw new FieldTimeError(
      "invalid_time_zone",
      `Time zone ${JSON.stringify(timeZone)} is not a known IANA time zone — set Business time zone in Company Settings → Organization before clocking across midnights`,
    );
  }
  return canonical;
}

/**
 * The zone-local calendar date of an instant, as parts. Self-contained
 * (rather than importing the platform formatter) so this database-free
 * module never loads the db-backed platform stack in unit tests.
 */
function zoneDateParts(instantMs: number, timeZone: string): { y: number; mo: number; d: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    y: Number(value("year")),
    mo: Number(value("month")),
    d: Number(value("day")),
    date: `${value("year")}-${value("month")}-${value("day")}`,
  };
}

/**
 * Whole-minute zone offset (local minus UTC) at an instant, from the
 * zone wall clock — no float date arithmetic. Modern IANA offsets are
 * whole minutes, so midnight epochs derived from this are exact to
 * the millisecond.
 */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  // en-CA midnight formats as "24" on some runtimes; normalize to 00.
  const hour = value("hour") === "24" ? "00" : value("hour");
  const asUTC = Date.UTC(
    Number(value("year")),
    Number(value("month")) - 1,
    Number(value("day")),
    Number(hour),
    Number(value("minute")),
    Number(value("second")),
  );
  return asUTC - Math.floor(instantMs / 1000) * 1000;
}

/** Epoch milliseconds of 00:00 on a zone-local date. Deterministic. */
function startOfZoneDayMs(y: number, mo: number, d: number, timeZone: string): number {
  let guess = Date.UTC(y, mo - 1, d, 12);
  for (let i = 0; i < 4; i++) {
    const next = Date.UTC(y, mo - 1, d) - zoneOffsetMs(guess, timeZone);
    if (next === guess) return next;
    guess = next;
  }
  return guess;
}

/**
 * Split [fromMs, toMs) at midnights in the org's business timezone —
 * time-entry dates are business dates, so a UTC-5 evening shift stays
 * on its one local date instead of straddling the UTC day. The caller
 * resolves the zone once per close (businessTimeZone, same basis as
 * businessToday); an unknown zone refuses here rather than guessing a
 * boundary. Integer-millisecond pieces sum to exactly the span.
 */
export function splitZoneDays(fromMs: number, toMs: number, timeZone: string): DayPiece[] {
  const zone = requireTimeZone(timeZone);
  for (const [name, value] of [["span start", fromMs], ["span end", toMs]] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new FieldTimeError(
        "invalid_occurred_at",
        `The day-split ${name} is not a valid instant — retry with the device time as ISO`,
      );
    }
  }
  const out: DayPiece[] = [];
  if (toMs <= fromMs) return out;
  let cursor = Math.floor(fromMs);
  const end = Math.floor(toMs);
  while (cursor < end) {
    const here = zoneDateParts(cursor, zone);
    const morrow = new Date(Date.UTC(here.y, here.mo - 1, here.d) + 86_400_000);
    const nextMidnight = startOfZoneDayMs(
      morrow.getUTCFullYear(), morrow.getUTCMonth() + 1, morrow.getUTCDate(), zone,
    );
    let pieceEnd = Math.min(end, nextMidnight);
    // A degenerate boundary (a midnight that does not exist or repeats
    // around a transition) never emits a zero-ms piece.
    if (pieceEnd <= cursor) pieceEnd = end;
    out.push({ date: here.date, ms: pieceEnd - cursor });
    cursor = pieceEnd;
  }
  return out;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** Haversine distance in metres. */
export function distanceMetres(a: LatLng, b: LatLng): number {
  const r = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(s));
}

export function insideCircle(point: LatLng, center: LatLng, radiusM: number): boolean {
  return distanceMetres(point, center) <= radiusM;
}

/**
 * Ray-casting point-in-polygon, concave-safe. Boundary counts as inside:
 * a worker on the fence line is on site, not a flag.
 */
export function insidePolygon(point: LatLng, polygon: LatLng[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    // On-segment check: cross product ~0 and within the bounding box.
    const cross =
      (b.lng - a.lng) * (point.lat - a.lat) - (b.lat - a.lat) * (point.lng - a.lng);
    if (Math.abs(cross) < 1e-9 &&
        point.lng >= Math.min(a.lng, b.lng) - 1e-9 &&
        point.lng <= Math.max(a.lng, b.lng) + 1e-9 &&
        point.lat >= Math.min(a.lat, b.lat) - 1e-9 &&
        point.lat <= Math.max(a.lat, b.lat) + 1e-9) {
      return true;
    }
    if (a.lat > point.lat !== b.lat > point.lat) {
      const x = a.lng + ((point.lat - a.lat) * (b.lng - a.lng)) / (b.lat - a.lat);
      if (point.lng < x) inside = !inside;
    }
  }
  return inside;
}

export type ClockKind = "clock_in" | "clock_out" | "break_start" | "break_end" | "switch";

/** The identity of one offline clock event under its idempotency key. */
export interface ClockPayload {
  kind: ClockKind;
  occurredAtMs: number;
  employeePartyId: string;
  projectId: string | null;
  projectTaskId: string | null;
  costCodeRef: string | null;
  source: string;
}

/**
 * Same key, same event? A replayed offline event returns the original
 * recording; the same idempotency key carrying a DIFFERENT event is a
 * client bug and conflicts. Transport-level fields (device, geo,
 * photo) are deliberately excluded: they may legitimately differ on a
 * genuine retry while the event itself is identical.
 */
export function sameClockPayload(a: ClockPayload, b: ClockPayload): boolean {
  const id = (v: string | null): string | null => (v == null ? null : v.toLowerCase());
  return (
    a.kind === b.kind &&
    a.occurredAtMs === b.occurredAtMs &&
    id(a.employeePartyId) === id(b.employeePartyId) &&
    id(a.projectId) === id(b.projectId) &&
    id(a.projectTaskId) === id(b.projectTaskId) &&
    (a.costCodeRef ?? null) === (b.costCodeRef ?? null) &&
    a.source === b.source
  );
}

const KIND_LABELS: Record<ClockKind, string> = {
  clock_in: "clock-in",
  clock_out: "clock-out",
  break_start: "break start",
  break_end: "break end",
  switch: "project switch",
};

/**
 * Chronology guard: any event recorded against an open pair must be
 * strictly after the open clock-in. A clock-out before its clock-in
 * would otherwise insert, compute a zero/negative segment, post no
 * entry, and still mark the pair paired — the shift vanishing behind a
 * success response. Offline and out-of-order replays hit the same
 * refusal by name, never a silent pair.
 */
export function validateEventChronology(
  kind: ClockKind,
  openOccurredAtMs: number,
  eventOccurredAtMs: number,
): void {
  for (const [name, value] of [["open clock-in", openOccurredAtMs], ["event", eventOccurredAtMs]] as const) {
    if (!Number.isFinite(value)) {
      throw new FieldTimeError(
        "invalid_occurred_at",
        `The ${name} time is not a valid instant — retry with the device time as ISO`,
      );
    }
  }
  if (eventOccurredAtMs <= openOccurredAtMs) {
    throw new FieldTimeError(
      "event_before_open",
      `The ${KIND_LABELS[kind]} at ${new Date(eventOccurredAtMs).toISOString()} is not after the open clock-in at ${new Date(openOccurredAtMs).toISOString()} — check the device clock and retry with a time after the clock-in`,
    );
  }
}

/**
 * Validate the next clock action against the worker's open state.
 * clockedIn: whether an open pair exists; onBreak: whether a break is open.
 * Refusals name the remedy; they never silently pair.
 */
export function validateClockSequence(
  kind: ClockKind,
  state: { clockedIn: boolean; onBreak: boolean },
): void {
  switch (kind) {
    case "clock_in":
      if (state.clockedIn) {
        throw new FieldTimeError(
          "already_clocked_in",
          "Already clocked in — clock out or switch project before clocking in again",
        );
      }
      return;
    case "clock_out":
      if (!state.clockedIn) {
        throw new FieldTimeError(
          "no_open_clock",
          "No open clock-in to close — clock in first, then clock out at the end of the shift",
        );
      }
      if (state.onBreak) {
        throw new FieldTimeError(
          "break_open",
          "A break is still open — end the break before clocking out",
        );
      }
      return;
    case "break_start":
      if (!state.clockedIn) {
        throw new FieldTimeError(
          "no_open_clock",
          "No open clock-in to break from — clock in first, then start a break",
        );
      }
      if (state.onBreak) {
        throw new FieldTimeError(
          "break_open",
          "A break is already open — end the current break before starting another",
        );
      }
      return;
    case "break_end":
      if (!state.onBreak) {
        throw new FieldTimeError(
          "no_open_break",
          "No open break to end — start a break first",
        );
      }
      return;
    case "switch":
      if (!state.clockedIn) {
        throw new FieldTimeError(
          "no_open_clock",
          "No open clock-in to switch — clock in first, then switch project or cost code",
        );
      }
      if (state.onBreak) {
        throw new FieldTimeError(
          "break_open",
          "A break is still open — end the break before switching project",
        );
      }
      return;
  }
}

export interface ApprovalStage {
  order: number;
  approverKind: "supervisor" | "project_manager" | "payroll" | "role";
  roleKey?: string | null;
}

/** Validate a multi-stage chain: dense orders from 1, known kinds, role named. */
export function validateStages(raw: unknown): ApprovalStage[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new FieldTimeError(
      "invalid_stages",
      "The approval chain needs at least one stage — add a stage in Timesheets setup or turn multi-stage approval off",
    );
  }
  if (raw.length > 5) {
    throw new FieldTimeError(
      "invalid_stages",
      "The approval chain holds at most five stages — remove stages in Timesheets setup",
    );
  }
  const stages = raw.map((s, i) => {
    const rec = s as Record<string, unknown>;
    const order = rec.order;
    const approverKind = rec.approverKind;
    if (typeof order !== "number" || !Number.isInteger(order) || order < 1) {
      throw new FieldTimeError(
        "invalid_stages",
        `Stage ${i + 1} needs a positive integer order — fix the chain in Timesheets setup`,
      );
    }
    if (
      approverKind !== "supervisor" &&
      approverKind !== "project_manager" &&
      approverKind !== "payroll" &&
      approverKind !== "role"
    ) {
      throw new FieldTimeError(
        "invalid_stages",
        `Stage ${i + 1} names an unknown approver — use supervisor, project_manager, payroll or role in Timesheets setup`,
      );
    }
    if (approverKind === "role" && (typeof rec.roleKey !== "string" || rec.roleKey.trim() === "")) {
      throw new FieldTimeError(
        "invalid_stages",
        `Stage ${i + 1} approves by role but names none — set the role key in Timesheets setup`,
      );
    }
    return {
      order,
      approverKind: approverKind as ApprovalStage["approverKind"],
      roleKey: (rec.roleKey as string | null) ?? null,
    };
  });
  const orders = stages.map((s) => s.order).sort((a, b) => a - b);
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i + 1) {
      throw new FieldTimeError(
        "invalid_stages",
        "Stage orders must run 1, 2, 3 without gaps — renumber the chain in Timesheets setup",
      );
    }
  }
  return stages.sort((a, b) => a.order - b.order);
}

/** Equipment hours must fit inside the entry plus the org's tolerance. */
export function checkEquipmentTolerance(
  entryHours: string,
  equipmentHours: string,
  toleranceHours: string,
): void {
  const entry = parseTenThousandths(entryHours);
  const equip = parseTenThousandths(equipmentHours);
  const tol = parseTenThousandths(toleranceHours);
  if (equip > entry + tol) {
    throw new FieldTimeError(
      "equipment_over_tolerance",
      `Equipment hours ${equipmentHours} exceed entry hours ${entryHours} plus tolerance ${toleranceHours} — split the equipment time onto its own entry`,
    );
  }
}
