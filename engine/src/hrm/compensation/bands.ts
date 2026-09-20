import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import { resolveWage, laborCostingSettings } from "../../projects/labor-costing.ts";
import {
  requireAggregateCompensationRead,
  requireHrmCompensationManage,
  requireHrmCompensationRead,
} from "../authorization.ts";
import { CompensationError } from "./errors.ts";
import { mul } from "../../money/money.ts";
import { bandPlacement, compaRatio } from "./compensation-math.ts";
import { requireActorId, requireId, requireOrgId, requireReason } from "../recruiting/input.ts";

/**
 * Pay bands (HR-12, 0221): versioned SHOULD-pay rows plus the placement
 * read.
 *
 * A band change is a new row, never an overwrite: creating a band whose
 * scope + effective_from collides with a live row closes the prior row
 * first, in the same transaction. Resolution picks the narrowest live
 * band covering the employment's scope (level → family → employer
 * subsidiary → location, most specific wins); employment versions read
 * their band through the position at the as-of date — band ids are never
 * copied onto employments.
 */

export type BandBasis = "annual" | "hourly";

export interface PayBandDTO {
  readonly id: string;
  readonly familyId: string | null;
  readonly levelId: string;
  readonly employerSubsidiaryId: string | null;
  readonly locationId: string | null;
  readonly currency: string;
  readonly basis: BandBasis;
  readonly min: string;
  readonly target: string;
  readonly max: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface BandScope {
  readonly familyId: string | null;
  readonly levelId: string;
  readonly employerSubsidiaryId: string | null;
  readonly locationId: string | null;
}

type BandRow = {
  id: string;
  family_id: string | null;
  level_id: string;
  employer_subsidiary_id: string | null;
  location_id: string | null;
  currency: string;
  basis: string;
  min: string;
  target: string;
  max: string;
  effective_from: string;
  effective_to: string | null;
};

function toBandDTO(row: BandRow): PayBandDTO {
  return {
    id: row.id,
    familyId: row.family_id,
    levelId: row.level_id,
    employerSubsidiaryId: row.employer_subsidiary_id,
    locationId: row.location_id,
    currency: row.currency,
    basis: (row.basis === "hourly" ? "hourly" : "annual") as BandBasis,
    min: String(row.min),
    target: String(row.target),
    max: String(row.max),
    effectiveFrom: String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to === null ? null : String(row.effective_to).slice(0, 10),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireMoney(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^\d+(\.\d{1,4})?$/.test(value) || !(Number(value) > 0)) {
    throw new CompensationError(
      "INVALID_INPUT",
      `${what} must be a positive amount with at most 4 decimals — refuse the figure, never coerce it`,
    );
  }
  return value;
}

export interface CreatePayBandQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly scope: BandScope;
  readonly currency: string;
  readonly basis: BandBasis;
  readonly min: string;
  readonly target: string;
  readonly max: string;
  readonly effectiveFrom: string;
  readonly reason: string;
}

/** Open a band version: closes the live row of the same scope first, in one transaction. Never an overwrite. */
export async function createPayBand(query: CreatePayBandQuery): Promise<PayBandDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const reason = requireReason(query.reason);
  void reason;
  const levelId = requireId(query.scope.levelId, "scope.levelId");
  const min = requireMoney(query.min, "band min");
  const target = requireMoney(query.target, "band target");
  const max = requireMoney(query.max, "band max");
  if (!(Number(min) <= Number(target) && Number(target) <= Number(max))) {
    throw new CompensationError(
      "REFUSED",
      `band ${min} / ${target} / ${max} is not ordered min <= target <= max — reorder the three figures instead of storing a band nobody can sit in`,
    );
  }
  if (typeof query.currency !== "string" || !/^[A-Z]{3}$/.test(query.currency)) {
    throw new CompensationError("INVALID_INPUT", "band currency must be an ISO 4217 code (e.g. USD)");
  }
  if (query.basis !== "annual" && query.basis !== "hourly") {
    throw new CompensationError("INVALID_INPUT", "band basis is annual or hourly");
  }
  if (!DATE_RE.test(query.effectiveFrom)) {
    throw new CompensationError("INVALID_INPUT", "effectiveFrom (YYYY-MM-DD) required");
  }
  const scope = query.scope;
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    const level = (await db.execute<{ id: string; family_id: string | null }>(sql`
      select id, family_id from hrm_job_levels where org_id = ${orgId} and id = ${levelId}`)).rows[0];
    if (!level) {
      throw new CompensationError("NOT_FOUND", "job level is not visible in this organization");
    }
    if (scope.familyId !== null && scope.familyId !== level.family_id) {
      throw new CompensationError(
        "REFUSED",
        "the band scope names a family the level does not belong to — scope the band to the level's own family, or to no family for the org-wide ladder",
      );
    }
    try {
      // Close the live row of this exact scope first (effective_to = day
      // before the new start); the overlap exclusion arbitrates races.
      await db.execute(sql`
        update hrm_pay_bands set effective_to = (${query.effectiveFrom}::date - 1),
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId}
           and family_id is not distinct from ${scope.familyId}
           and level_id = ${levelId}
           and employer_subsidiary_id is not distinct from ${scope.employerSubsidiaryId}
           and location_id is not distinct from ${scope.locationId}
           and currency = ${query.currency} and basis = ${query.basis}
           and effective_from <= ${query.effectiveFrom}::date
           and (effective_to is null or effective_to >= ${query.effectiveFrom}::date)`);
      const row = (await db.execute<BandRow>(sql`
        insert into hrm_pay_bands
          (org_id, family_id, level_id, employer_subsidiary_id, location_id, currency, basis,
           min, target, max, effective_from, created_by, updated_by)
        values (${orgId}, ${scope.familyId}, ${levelId}, ${scope.employerSubsidiaryId},
                ${scope.locationId}, ${query.currency}, ${query.basis},
                ${min}, ${target}, ${max}, ${query.effectiveFrom}, ${actorId}, ${actorId})
        returning id, family_id, level_id, employer_subsidiary_id, location_id, currency, basis,
                  min::text as min, target::text as target, max::text as max,
                  effective_from::text as effective_from, effective_to::text as effective_to`)).rows[0];
      if (!row) throw new CompensationError("REFUSED", "the band insert matched no row — the save is refused, never a silent success");
      return toBandDTO(row);
    } catch (e) {
      if (e instanceof CompensationError) throw e;
      throw e;
    }
  });
}

export async function listPayBands(query: {
  orgId: string;
  actorId: string;
  levelId?: string | null;
  asOf?: string | null;
}): Promise<readonly PayBandDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  await requireHrmCompensationRead(db, orgId, actorId);
  const asOf = query.asOf ?? (await businessToday(orgId));
  const rows = (await db.execute<BandRow>(sql`
    select id, family_id, level_id, employer_subsidiary_id, location_id, currency, basis,
           min::text as min, target::text as target, max::text as max,
           effective_from::text as effective_from, effective_to::text as effective_to
      from hrm_pay_bands
     where org_id = ${orgId}
       and (${query.levelId ?? null}::uuid is null or level_id = ${query.levelId ?? null}::uuid)
       and effective_from <= ${asOf}::date
       and (effective_to is null or effective_to >= ${asOf}::date)
     order by level_id, employer_subsidiary_id nulls last, location_id nulls last`)).rows;
  return rows.map(toBandDTO);
}

/**
 * The narrowest live band covering a scope at a date: an exact level +
 * subsidiary + location row beats a level-only row, which beats wider.
 * Returns null when no band covers the scope — the caller renders
 * "no band", never a zero.
 */
export async function resolveBandForScope(
  orgId: string,
  scope: BandScope & { currency: string; basis: BandBasis },
  asOf: string,
): Promise<PayBandDTO | null> {
  const rows = (await db.execute<BandRow>(sql`
    select id, family_id, level_id, employer_subsidiary_id, location_id, currency, basis,
           min::text as min, target::text as target, max::text as max,
           effective_from::text as effective_from, effective_to::text as effective_to
      from hrm_pay_bands
     where org_id = ${orgId}
       and level_id = ${scope.levelId}
       and (family_id is null or family_id is not distinct from ${scope.familyId})
       and (employer_subsidiary_id is null or employer_subsidiary_id is not distinct from ${scope.employerSubsidiaryId})
       and (location_id is null or location_id is not distinct from ${scope.locationId})
       and currency = ${scope.currency} and basis = ${scope.basis}
       and effective_from <= ${asOf}::date
       and (effective_to is null or effective_to >= ${asOf}::date)
     order by (case when employer_subsidiary_id is not null then 0 else 1 end),
              (case when location_id is not null then 0 else 1 end),
              (case when family_id is not null then 0 else 1 end),
              effective_from desc
     limit 1`)).rows;
  const row = rows[0];
  return row ? toBandDTO(row) : null;
}

export interface PlacementRead {
  readonly employmentId: string;
  readonly asOf: string;
  readonly band: PayBandDTO | null;
  readonly currentRate: string | null;
  readonly currency: string | null;
  readonly compaRatio: string | null;
  readonly placement: "below_min" | "in_range" | "above_max" | "no_band";
}

/**
 * Band placement for one employment at a date: rate over the target of
 * the band covering their position's level at that date. Refuses by name
 * when no band covers the scope (the UI shows "no band") or when no
 * payroll-side rate exists (the line cannot be priced) — never zero.
 */
export async function compaRatioFor(
  orgId: string,
  actorId: string,
  employmentId: string,
  asOf: string,
): Promise<PlacementRead> {
  // hrm.compensation.read suffices: a compensation analyst reads
  // placement without the employment record grant, so the subject loads
  // directly (org-scoped, never caller-supplied identity) instead of
  // through the employment-read gate.
  void actorId;
  const employment = (await db.execute<{
    worker_party_id: string;
    employer_subsidiary_id: string;
  }>(sql`
    select worker_party_id, employer_subsidiary_id
      from worker_employments where org_id = ${orgId} and id = ${employmentId}`)).rows[0];
  if (!employment) {
    throw new CompensationError("NOT_FOUND", "employment is not visible in this organization");
  }
  const primary = (await db.execute<{
    assignment_id: string;
    department_id: string | null;
    location_id: string | null;
    position_id: string | null;
  }>(sql`
    select assignment_id, department_id, location_id, position_id
      from employment_assignment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
       and effective_from <= ${asOf}::date
       and (effective_to is null or effective_to >= ${asOf}::date)
       and recorded_until is null
     order by is_primary desc, effective_from desc
     limit 1`)).rows[0];
  if (!primary) {
    throw new CompensationError(
      "REFUSED",
      "the employment holds no assignment at this date — placement needs a positioned assignment; check the as-of date",
    );
  }
  // The position (and its level) at the as-of date, through the
  // assignment's position link — never a copied band id.
  const position = (await db.execute<{
    level_id: string | null;
    department_id: string | null;
    location_id: string | null;
    employer_subsidiary_id: string;
  }>(sql`
    select pv.job_level_id as level_id, pv.department_id, pv.location_id, pv.employer_subsidiary_id
      from position_versions pv
     where pv.org_id = ${orgId} and pv.position_id = ${primary.position_id}
       and pv.effective_from <= ${asOf}::date
       and (pv.effective_to is null or pv.effective_to >= ${asOf}::date)
       and pv.recorded_until is null
     order by pv.effective_from desc
     limit 1`)).rows[0];
  if (!position?.level_id) {
    throw new CompensationError(
      "REFUSED",
      "no band covers this employment: the assignment names no architected position at this date — place the position on a job level before reading placement",
    );
  }
  const level = (await db.execute<{ family_id: string | null }>(sql`
    select family_id from hrm_job_levels where org_id = ${orgId} and id = ${position.level_id}`)).rows[0];
  // The payroll-side effective wage at the date, through the
  // labor-costing wage rate service — never a typed number.
  const wage = await resolveWage(orgId, employment.worker_party_id, asOf, {
    departmentId: position.department_id ?? primary.department_id,
    subsidiaryId: position.employer_subsidiary_id,
  });
  if (!wage) {
    throw new CompensationError(
      "REFUSED",
      "no payroll-side wage covers this employment at this date — placement needs a priced line; set the wage in Labor Costing first",
    );
  }
  const settings = await laborCostingSettings(orgId);
  const basis: BandBasis = "annual";
  // Annual truth without a round-trip: an annual native row prices
  // directly (dividing by annual hours and back would shed dust);
  // hourly natives and fallback scopes annualise through the wage.
  const native = (await db.execute<{ rate: string; basis: string }>(sql`
    select rate::text as rate, basis
      from labor_cost_rates
     where org_id = ${orgId} and employee_party_id = ${employment.worker_party_id} and is_active
       and effective_from <= ${asOf}::date
       and (effective_to is null or effective_to >= ${asOf}::date)
     order by effective_from desc
     limit 1`)).rows[0];
  const annualRate =
    native && native.basis === "year"
      ? String(native.rate)
      : native
        ? mul(String(native.rate), String(settings.annualHours))
        : mul(wage.wage, String(settings.annualHours));
  const band = await resolveBandForScope(
    orgId,
    {
      familyId: level?.family_id ?? null,
      levelId: position.level_id,
      employerSubsidiaryId: position.employer_subsidiary_id,
      locationId: position.location_id ?? primary.location_id,
      currency: wage.currency,
      basis,
    },
    asOf,
  );
  if (!band) {
    throw new CompensationError(
      "REFUSED",
      "no band covers this employment's scope at this date — declare a band for the level before reading placement",
    );
  }
  const placed = bandPlacement(annualRate, band.min, band.target, band.max);
  return {
    employmentId,
    asOf,
    band,
    currentRate: annualRate,
    currency: wage.currency,
    compaRatio: placed.compaRatio,
    placement: placed.placement,
  };
}

/** Aggregate band read for list surfaces (permission gate + subsidiary scope for the caller to filter by). */
export async function requireBandsReadScope(
  orgId: string,
  actorId: string,
): Promise<Set<string> | null> {
  return requireAggregateCompensationRead(db, orgId, actorId);
}
