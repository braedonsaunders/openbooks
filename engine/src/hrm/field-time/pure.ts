/**
 * HR-20 pure field-time math: rounding, break subtraction, geofence
 * containment, clock sequencing, stage validation, equipment tolerance.
 *
 * Pure on purpose — no database, no clock — so the unit partition owns
 * every rule and the services only wire rows through them.
 */

import { FieldTimeError } from "./errors.ts";

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
  return BigInt(m[1]) * SCALE + BigInt(frac);
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

/** Subtract unpaid break minutes from entry hours; never below zero. */
export function subtractBreaks(hours: string, breakMinutes: number): string {
  if (!Number.isFinite(breakMinutes) || breakMinutes < 0) {
    throw new FieldTimeError(
      "invalid_break_rule",
      `Break minutes ${String(breakMinutes)} are not declared — set unpaid break minutes to 0 or more in Timesheets setup`,
    );
  }
  const value = parseTenThousandths(hours);
  // minutes → ten-thousandths of an hour: min * 10000 / 60.
  const deduction = (BigInt(Math.round(breakMinutes)) * SCALE) / 60n;
  const result = value - deduction;
  return formatTenThousandths(result < 0n ? 0n : result);
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
    return { order, approverKind, roleKey: (rec.roleKey as string | null) ?? null };
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
