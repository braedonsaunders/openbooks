import { sql } from "drizzle-orm";
import { add, cmp, mulDecimalFactors, sum } from "../money/money.ts";
import type { db } from "../platform/db.ts";
import type { PayrollWorkAllocation } from "./statutory-context.ts";

type Queryable = Pick<typeof db, "execute">;

interface WorkRow extends Record<string, unknown> {
  region: string;
  subregion: string | null;
  workedOn: string;
  hours: string;
}

interface AllocationRow extends Record<string, unknown> {
  region: string;
  subregion: string | null;
  serviceDays: number | null;
  workShare: string | null;
  source: string;
}

interface SourceAllocation {
  region: string;
  subregion: string | null;
  workShare: string;
  serviceDaysCurrentPeriod: number | null;
  serviceDaysYearToDate: number | null;
  source: string;
  hours: string;
}

const SHARE_SCALE = 10n ** 10n;
function shareUnits(value: string): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,10}))?$/.exec(value);
  if (!match) throw new Error(`invalid work allocation share "${value}"`);
  const fraction = (match[3] ?? "").padEnd(10, "0");
  const magnitude = BigInt(match[2]!) * SHARE_SCALE + BigInt(fraction);
  return match[1] === "-" ? -magnitude : magnitude;
}
function shareText(units: bigint): string {
  const whole = units / SHARE_SCALE;
  const fraction = (units < 0n ? -units : units) % SHARE_SCALE;
  return `${whole}.${fraction.toString().padStart(10, "0")}`;
}
function ratioShare(numerator: string, denominator: string): string {
  const asUnits = (value: string) => {
    const [whole = "0", fraction = ""] = value.split(".");
    return BigInt(whole) * 10_000n + BigInt((fraction + "0000").slice(0, 4));
  };
  const n = asUnits(numerator);
  const d = asUnits(denominator);
  return shareText((n * SHARE_SCALE + d / 2n) / d);
}

/**
 * Derive the statutory work-location contract from approved service records,
 * with HR's period allocation as the source for untimed/salaried work. The YTD
 * day count is reconstructed from approved dated work; source wages are read
 * only from committed stub factors so this function never trusts a running
 * total supplied by a caller.
 */
export async function loadPayrollWorkAllocations(
  tx: Queryable,
  input: {
    orgId: string;
    employeePartyId: string;
    employmentId: string | null;
    periodStart: string;
    periodEnd: string;
    taxYear: number;
    documentId: string;
    currentWages: string;
  },
): Promise<PayrollWorkAllocation[]> {
  const ytdStart = `${input.taxYear}-01-01`;
  const work = await tx.execute<WorkRow>(sql`
    select work_region as region, work_subregion as subregion,
           worked_on::text as "workedOn", hours::text as hours
      from time_entries
     where org_id = ${input.orgId} and employee_party_id = ${input.employeePartyId}
       and status = 'approved' and work_region is not null
       and worked_on between ${ytdStart}::date and ${input.periodEnd}::date
     order by worked_on, id
  `);
  const currentWork = work.rows.filter((row) => row.workedOn >= input.periodStart && row.workedOn <= input.periodEnd);
  const ytdDaysByRegion = new Map<string, Set<string>>();
  for (const row of work.rows) {
    const days = ytdDaysByRegion.get(row.region) ?? new Set<string>();
    days.add(row.workedOn);
    ytdDaysByRegion.set(row.region, days);
  }
  const byRegion = new Map<string, { region: string; subregion: string | null; days: Set<string>; hours: string }>();
  for (const row of currentWork) {
    const key = `${row.region}\u0000${row.subregion ?? ""}`;
    const bucket = byRegion.get(key) ?? {
      region: row.region, subregion: row.subregion, days: new Set<string>(), hours: "0",
    };
    bucket.days.add(row.workedOn);
    bucket.hours = add(bucket.hours, row.hours);
    byRegion.set(key, bucket);
  }

  const hr = input.employmentId
    ? await tx.execute<AllocationRow>(sql`
        select region, subregion, service_days as "serviceDays",
               work_share::text as "workShare", source
          from payroll_work_location_allocations
         where org_id = ${input.orgId} and employment_id = ${input.employmentId}
           and period_start = ${input.periodStart}::date and period_end = ${input.periodEnd}::date
         order by region, subregion
      `)
    : { rows: [] as AllocationRow[] };
  const hrYtd = input.employmentId
    ? await tx.execute<{ region: string; serviceDays: number }>(sql`
        select region, sum(service_days)::int as "serviceDays"
          from payroll_work_location_allocations
         where org_id = ${input.orgId} and employment_id = ${input.employmentId}
           and period_end >= ${ytdStart}::date and period_end <= ${input.periodEnd}::date
           and service_days is not null
           and not exists (
             select 1 from time_entries te
              where te.org_id = payroll_work_location_allocations.org_id
                and te.employee_party_id = (
                  select we.worker_party_id from worker_employments we
                   where we.org_id = payroll_work_location_allocations.org_id
                     and we.id = payroll_work_location_allocations.employment_id
                )
                and te.status = 'approved' and te.work_region is not null
                and te.worked_on between payroll_work_location_allocations.period_start
                                     and payroll_work_location_allocations.period_end
           )
         group by region
      `)
    : { rows: [] as { region: string; serviceDays: number }[] };
  const hrYtdDays = new Map(hrYtd.rows.map((row) => [row.region, row.serviceDays]));

  const source: SourceAllocation[] = currentWork.length > 0
    ? (() => {
      const regions = new Map<string, { hours: string; source: string }>();
      const local = [...byRegion.values()].filter((bucket) => bucket.subregion !== null);
      for (const bucket of byRegion.values()) {
        const current = regions.get(bucket.region) ?? { hours: "0", source: "approved_time_entries" };
        current.hours = add(current.hours, bucket.hours);
        regions.set(bucket.region, current);
      }
      return [
        ...[...regions].map(([region, bucket]) => ({
          region, subregion: null, workShare: "0",
          serviceDaysCurrentPeriod: [...(ytdDaysByRegion.get(region) ?? [])]
            .filter((day) => day >= input.periodStart && day <= input.periodEnd).length,
          serviceDaysYearToDate: ytdDaysByRegion.get(region)?.size ?? 0,
          source: bucket.source, hours: bucket.hours,
        })),
        ...local.map((bucket) => ({
          region: bucket.region, subregion: bucket.subregion, workShare: "0",
          serviceDaysCurrentPeriod: bucket.days.size,
          serviceDaysYearToDate: ytdDaysByRegion.get(bucket.region)?.size ?? 0,
          source: "approved_time_entries", hours: bucket.hours,
        })),
      ];
    })()
    : (() => {
      const rowsByRegion = new Map<string, AllocationRow[]>();
      for (const row of hr.rows) rowsByRegion.set(row.region, [...(rowsByRegion.get(row.region) ?? []), row]);
      const regions: SourceAllocation[] = [];
      for (const [region, rows] of rowsByRegion) {
        const explicitRegion = rows.find((row) => row.subregion === null);
        const leaves = rows.filter((row) => row.subregion !== null);
        const serviceDays = explicitRegion?.serviceDays ?? (leaves.some((row) => row.serviceDays !== null)
          ? leaves.reduce((total, row) => total + (row.serviceDays ?? 0), 0) : null);
        regions.push({
          region, subregion: null,
          workShare: explicitRegion?.workShare ?? leaves.reduce((total, row) =>
            add(total, row.workShare ?? "0"), "0"),
          serviceDaysCurrentPeriod: serviceDays,
          serviceDaysYearToDate: ytdDaysByRegion.has(region) || hrYtdDays.has(region)
            ? (ytdDaysByRegion.get(region)?.size ?? 0) + (hrYtdDays.get(region) ?? 0)
            : null,
          source: explicitRegion?.source ?? leaves[0]?.source ?? "hr_records",
          hours: "0",
        });
      }
      return [
        ...regions,
        ...hr.rows.filter((row) => row.subregion !== null).map((row) => ({
          region: row.region, subregion: row.subregion, workShare: row.workShare ?? "0",
          serviceDaysCurrentPeriod: row.serviceDays,
          serviceDaysYearToDate: ytdDaysByRegion.has(row.region) || hrYtdDays.has(row.region)
            ? (ytdDaysByRegion.get(row.region)?.size ?? 0) + (hrYtdDays.get(row.region) ?? 0)
            : null,
          source: row.source, hours: "0",
        })),
      ];
    })();

  if (source.length === 0) return [];
  const regional = source.filter((entry) => entry.subregion === null);
  const local = source.filter((entry) => entry.subregion !== null);
  const totalHours = sum(regional.map((entry) => entry.hours));
  if (cmp(totalHours, "0") === 0) {
    const totalShares = regional.reduce((total, entry) => total + shareUnits(entry.workShare), 0n);
    if (totalShares === 0n) {
      // HR may enter days instead of a wage share. Apply their recorded days
      // proportionally; the stored service-day count remains an integer fact.
      const days = regional.map((entry) => String(entry.serviceDaysCurrentPeriod ?? 0));
      const totalDays = days.reduce((total, value) => total + BigInt(value), 0n);
      if (totalDays > 0n) {
        regional.forEach((entry, index) => {
          entry.workShare = shareText((BigInt(days[index]!) * SHARE_SCALE + totalDays / 2n) / totalDays);
        });
      }
    }
    for (const regionEntry of regional) {
      const regionLocal = local.filter((entry) => entry.region === regionEntry.region);
      const totalLocalShares = regionLocal.reduce((total, entry) => total + shareUnits(entry.workShare), 0n);
      if (totalLocalShares !== 0n || !regionLocal.some((entry) => entry.serviceDaysCurrentPeriod !== null)) continue;
      const localDays = regionLocal.reduce((total, entry) => total + BigInt(entry.serviceDaysCurrentPeriod ?? 0), 0n);
      if (localDays > 0n) regionLocal.forEach((entry) => {
        const withinRegion = (BigInt(entry.serviceDaysCurrentPeriod ?? 0) * SHARE_SCALE + localDays / 2n) / localDays;
        entry.workShare = shareText((shareUnits(regionEntry.workShare) * withinRegion + SHARE_SCALE / 2n) / SHARE_SCALE);
      });
    }
    const normalizedShares = regional.reduce((total, entry) => total + shareUnits(entry.workShare), 0n);
    if (normalizedShares !== SHARE_SCALE) {
      // Leave unusable shares visible to the jurisdiction rule, which can
      // refuse the required allocation by name instead of guessing.
      return source.map(({ region, subregion, workShare, source: provenance,
        serviceDaysCurrentPeriod, serviceDaysYearToDate }) => ({
        region, subRegion: subregion, workShare, source: provenance,
        serviceDaysCurrentPeriod, serviceDaysYearToDate, sourceWagesCurrentPeriod: null,
        sourceWagesYearToDate: null,
      }));
    }
  } else {
    regional.forEach((entry) => { entry.workShare = ratioShare(entry.hours, totalHours); });
    local.forEach((entry) => { entry.workShare = ratioShare(entry.hours, totalHours); });
    const shareTotal = regional.reduce((total, entry) => total + shareUnits(entry.workShare), 0n);
    if (shareTotal !== SHARE_SCALE) {
      const largest = regional.reduce((best, row) => cmp(row.hours, best.hours) > 0 ? row : best);
      largest.workShare = shareText(shareUnits(largest.workShare) + SHARE_SCALE - shareTotal);
    }
  }

  const priorStubs = await tx.execute<{ count: number; traced: number }>(sql`
    select count(*)::int as count,
           count(*) filter (where exists (
             select 1 from jsonb_each_text(coalesce(stub.factors, '{}'::jsonb)) fact(key, value)
              where fact.key like 'work_source_wages:%'
           ))::int as traced
      from pay_stubs stub
      join pay_runs run on run.org_id = stub.org_id and run.document_id = stub.pay_run_document_id
      join documents doc on doc.org_id = run.org_id and doc.id = run.document_id
     where stub.org_id = ${input.orgId} and stub.employee_party_id = ${input.employeePartyId}
       and stub.tax_year = ${input.taxYear} and stub.pay_run_document_id <> ${input.documentId}
       and run.run_status = 'committed' and doc.status <> 'voided'
  `);
  const priorStubCount = priorStubs.rows[0]?.count ?? 0;
  const sourceWageHistoryComplete = priorStubCount === 0 || priorStubs.rows[0]?.traced === priorStubCount;
  const wageFactors = await tx.execute<{ region: string; wages: string }>(sql`
    select fact.key as region, sum(fact.value::numeric)::text as wages
      from pay_stubs stub
      join pay_runs run on run.org_id = stub.org_id and run.document_id = stub.pay_run_document_id
      join documents doc on doc.org_id = run.org_id and doc.id = run.document_id
      cross join lateral jsonb_each_text(coalesce(stub.factors, '{}'::jsonb)) fact(key, value)
     where stub.org_id = ${input.orgId} and stub.employee_party_id = ${input.employeePartyId}
       and stub.tax_year = ${input.taxYear} and stub.pay_run_document_id <> ${input.documentId}
       and run.run_status = 'committed' and doc.status <> 'voided'
       and fact.key like 'work_source_wages:%'
     group by fact.key
  `);
  const ytdWages = new Map(wageFactors.rows.map((row) => [row.region.slice("work_source_wages:".length), row.wages]));
  return source.map(({ region, subregion, workShare, source: provenance,
    serviceDaysCurrentPeriod, serviceDaysYearToDate }) => ({
    region,
    subRegion: subregion,
    workShare,
    source: provenance,
    serviceDaysCurrentPeriod,
    serviceDaysYearToDate,
    sourceWagesCurrentPeriod: mulDecimalFactors(input.currentWages, [workShare]),
    sourceWagesYearToDate: ytdWages.get(region) ?? (sourceWageHistoryComplete ? "0.0000" : null),
    periodsYearToDate: priorStubCount + 1,
  }));
}
