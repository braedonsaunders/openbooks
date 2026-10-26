import { sql } from "drizzle-orm";
import { cmp, normalizeMoney } from "../money/money.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { requirePayrollFeature } from "./feature-gate.ts";
import {
  employeeTaxYearFenceKey,
  employerLevyFenceKey,
  takeEmployeeTaxYearFences,
  takeEmployerLevyFences,
} from "./fences.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { PayrollError } from "./error.ts";
import { requireNativeFileReadAuthority } from "../records/file-read-authority.ts";
import { PAYROLL_COUNTRY_PACKS } from "./pack-registry.ts";
import {
  validateOpeningLevySourceFacts,
  type OpeningLevySourceFacts,
} from "./opening-levy-source-facts.ts";
import { canonicalNonNegativeDecimal } from "../money/exact-decimal.ts";
import { takeOpeningSourceYearFence } from "../organization/payroll-source-fence.ts";
import {
  currentOpeningLevySourceSql,
  openingLevySourceCorrectionRequestSha256,
  requireUnconsumedOpeningLevySource,
  type OpeningLevySourceCorrection,
} from "./opening-levy-source-correction-authority.ts";

export type OpeningLevyProgram =
  "ca_wcb" | "ca_eht" | "ca_cnt" | "us_futa" | "us_sui" | "us_pa_lst";
export type OpeningLevySourceAllocation = {
  programKey: OpeningLevyProgram;
  region: string;
  subRegion: string;
  filingAccountId: string | null;
  federalAccountId: string | null;
  amount: string;
};

export type OpeningLevySourceAllocationInput = {
  programKey: string;
  region: string;
  subRegion?: string;
  filingAccountId?: string | null;
  federalAccountId: string | null;
  amount: string;
};

type StoredEmployerAuthority = {
  id: string;
  openingBalanceId: string;
  employeePartyId: string;
  taxYear: number;
  subsidiaryId: string;
  sourceFileId: string;
  sourceVersionId: string;
  sourceSha256: string;
  sourceReference: string;
  openingSha256: string;
};

function canonicalAllocations(
  input: readonly OpeningLevySourceAllocationInput[],
): OpeningLevySourceAllocation[] {
  if (!Array.isArray(input))
    throw new PayrollError(
      "Record the complete statutory levy opening allocation, including explicit zeros",
    );
  const seen = new Set<string>();
  return input
    .map((raw) => {
      if (
        !raw ||
        typeof raw !== "object" ||
        !["ca_wcb", "ca_eht", "ca_cnt", "us_futa", "us_sui", "us_pa_lst"].includes(
          raw.programKey,
        ) ||
        typeof raw.region !== "string" ||
        typeof raw.amount !== "string" ||
        (raw.subRegion !== undefined && typeof raw.subRegion !== "string") ||
        (raw.filingAccountId !== undefined &&
          raw.filingAccountId !== null &&
          typeof raw.filingAccountId !== "string") ||
        (raw.federalAccountId !== null &&
          (typeof raw.federalAccountId !== "string" || !isUuid(raw.federalAccountId)))
      ) {
        throw new PayrollError(
          "Choose a declared statutory programme, original jurisdiction and exact-decimal opening amount",
        );
      }
      const programKey = raw.programKey as OpeningLevyProgram;
      const region = raw.region.trim().toUpperCase();
      const subRegion = (raw.subRegion ?? "").trim();
      const filingAccountId = raw.filingAccountId ?? null;
      const federalAccountId = raw.federalAccountId;
      if (filingAccountId !== null && !isUuid(filingAccountId))
        throw new PayrollError("Choose a native EIN account for the US wage-base opening");
      const policy = Object.values(PAYROLL_COUNTRY_PACKS)
        .map((pack) => pack.openingLevySource)
        .find((policy) => policy?.programKeys.includes(programKey));
      const scopeValid = policy?.validateScope({
        programKey,
        region,
        subRegion,
        filingAccountId,
        federalAccountId,
      });
      if (!scopeValid)
        throw new PayrollError(
          `${programKey} needs its original programme jurisdiction and legal-employer account scope`,
        );
      if (canonicalNonNegativeDecimal(raw.amount, 4) === null)
        throw new PayrollError(
          "Opening allocation must be an exact non-negative decimal with at most four decimal places",
        );
      let amount: string;
      try {
        amount = normalizeMoney(raw.amount);
      } catch (error) {
        throw new PayrollError(
          `Opening allocation ${programKey}/${region} is not an exact non-negative amount: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (cmp(amount, "0") < 0)
        throw new PayrollError("Statutory levy opening allocations cannot be negative");
      const key = [
        programKey,
        region,
        subRegion,
        filingAccountId ?? "",
        federalAccountId ?? "",
      ].join("|");
      if (seen.has(key))
        throw new PayrollError(
          `Duplicate statutory levy opening allocation ${programKey}/${region}/${subRegion}`,
        );
      seen.add(key);
      return { programKey, region, subRegion, filingAccountId, federalAccountId, amount };
    })
    .sort((a, b) =>
      [a.programKey, a.region, a.subRegion, a.filingAccountId ?? "", a.federalAccountId ?? ""]
        .join("|")
        .localeCompare(
          [
            b.programKey,
            b.region,
            b.subRegion,
            b.filingAccountId ?? "",
            b.federalAccountId ?? "",
          ].join("|"),
        ),
    );
}

/** Whether the original statutory report must enumerate its levy allocations. */
export function openingLevySourceRequiresAllocations(country: string): boolean {
  return PAYROLL_COUNTRY_PACKS[country]?.openingLevySource !== undefined;
}

function requiredAllocations(country: string, rows: readonly OpeningLevySourceAllocation[]) {
  const policy = PAYROLL_COUNTRY_PACKS[country]?.openingLevySource;
  if (policy) return policy.validateRequired(rows);
  if (rows.length)
    throw new PayrollError(
      "This original country has no declared opening levy allocation programmes; retain its generic opening amounts with an empty allocation set",
    );
}

async function loadOpening(input: { orgId: string; openingBalanceId: string }, lock = false) {
  return (
    (
      await db.execute<{
        id: string;
        employeePartyId: string;
        taxYear: number;
        wcbAssessableYtd: string;
        ehtRemunerationYtd: string;
        insurableYtd: string;
      }>(
        sql`
    select b.id, b.employee_party_id as "employeePartyId", b.tax_year as "taxYear",
      b.wcb_assessable_ytd::text as "wcbAssessableYtd", b.eht_remuneration_ytd::text as "ehtRemunerationYtd",
      b.insurable_ytd::text as "insurableYtd"
      from payroll_opening_balances b
      left join payroll_opening_employer_authorities a on a.org_id=b.org_id and a.opening_balance_id=b.id
     where b.org_id=${input.orgId} and b.id=${input.openingBalanceId}
     ${lock ? sql`for update of b` : sql``}
  `,
        "objects",
      )
    )[0] ?? null
  );
}

export type OpeningLevySourceAuthorityInput = {
  orgId: string;
  actorId: string;
  openingBalanceId: string;
  expectedOpeningSha256: string;
  expectedOpeningChildrenSha256: string;
  sourceFileId: string;
  sourceVersionId: string;
  sourceSha256: string;
  sourceReference: string;
  originalCountry: OpeningLevySourceFacts["originalCountry"];
  originalCurrency: OpeningLevySourceFacts["originalCurrency"];
  coverageStart: string;
  coverageEnd: string;
  coverageComplete: true;
  allocations: readonly OpeningLevySourceAllocationInput[];
  reason: string;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
};
export type OpeningLevySourceAuthorityResult = {
  id: string;
  openingBalanceId: string;
  subsidiaryId: string;
  allocationSha256: string;
};

export async function qualifyOpeningLevySourceAuthority(
  input: OpeningLevySourceAuthorityInput,
): Promise<OpeningLevySourceAuthorityResult> {
  return saveOpeningLevySourceAuthority(input, null);
}

/** Requalification appends evidence while preserving the original legal payer and every opening amount. */
export async function replaceOpeningLevySourceAuthority(
  input: OpeningLevySourceAuthorityInput,
  correction: OpeningLevySourceCorrection,
): Promise<OpeningLevySourceAuthorityResult> {
  return saveOpeningLevySourceAuthority(input, correction);
}

async function saveOpeningLevySourceAuthority(
  input: OpeningLevySourceAuthorityInput,
  correction: OpeningLevySourceCorrection | null,
): Promise<OpeningLevySourceAuthorityResult> {
  if (
    ![
      input.orgId,
      input.actorId,
      input.openingBalanceId,
      input.sourceFileId,
      input.sourceVersionId,
    ].every(isUuid) ||
    !/^[a-f0-9]{64}$/.test(input.expectedOpeningChildrenSha256) ||
    input.allowedSubsidiaryIds === undefined ||
    !/^[a-f0-9]{64}$/.test(input.sourceSha256) ||
    !/^[a-f0-9]{64}$/.test(input.expectedOpeningSha256)
  ) {
    throw new PayrollError(
      "Choose a native opening balance and its exact retained legal-employer qualification",
    );
  }
  if (
    typeof input.reason !== "string" ||
    !input.reason.trim() ||
    input.reason.trim().length > 2000
  ) {
    throw new PayrollError(
      "Record why the original statutory levy opening allocations are being qualified",
    );
  }
  const reason = input.reason.trim();
  if (
    typeof input.sourceReference !== "string" ||
    !input.sourceReference.trim() ||
    input.sourceReference.trim().length > 2000
  ) {
    throw new PayrollError(
      "Record the country, currency, coverage and allocation reference in the original Cabinet source",
    );
  }
  const sourceReference = input.sourceReference.trim();
  const allocations = canonicalAllocations(input.allocations);
  const requestSha256 = correction
    ? openingLevySourceCorrectionRequestSha256(correction, {
        orgId: input.orgId,
        actorId: input.actorId,
        openingBalanceId: input.openingBalanceId,
        expectedOpeningSha256: input.expectedOpeningSha256,
        expectedOpeningChildrenSha256: input.expectedOpeningChildrenSha256,
        sourceFileId: input.sourceFileId,
        sourceVersionId: input.sourceVersionId,
        sourceSha256: input.sourceSha256,
        sourceReference,
        originalCountry: input.originalCountry,
        originalCurrency: input.originalCurrency,
        coverageStart: input.coverageStart,
        coverageEnd: input.coverageEnd,
        coverageComplete: input.coverageComplete,
        allocations,
        reason,
      })
    : null;
  return withOrgTransaction(input.orgId, async () => {
    await requirePayrollFeature(db, input.orgId);
    const permission = correction ? "payroll.manage" : "payroll.run";
    if (!(await actorHasPermission(db, input.orgId, input.actorId, permission))) {
      throw new PayrollError(
        correction
          ? "Payroll manage permission is required to correct an opening source certificate"
          : "Payroll run permission is required to qualify statutory levy opening history",
      );
    }
    let opening = await loadOpening(input);
    if (!opening) throw new PayrollError("The native payroll opening record is unavailable");
    await takeOpeningSourceYearFence(db, input.orgId, opening.taxYear);
    const commandAuthority = await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      null,
      permission,
    );
    await takeEmployeeTaxYearFences(db, [
      employeeTaxYearFenceKey(input.orgId, opening.employeePartyId, opening.taxYear),
    ]);
    {
      const levyFenceKeys: string[] = [];
      for (const [country, pack] of Object.entries(PAYROLL_COUNTRY_PACKS)) {
        let levies: readonly { key: string; timing: string }[];
        try {
          levies = pack.employerAggregateLevies?.(opening.taxYear) ?? [];
        } catch {
          continue;
        }
        for (const levy of levies)
          if (levy.timing === "per_run")
            levyFenceKeys.push(
              employerLevyFenceKey(input.orgId, opening.taxYear, country, levy.key),
            );
      }
      await takeEmployerLevyFences(db, levyFenceKeys);
    }
    const retainedIdentity = { employeePartyId: opening.employeePartyId, taxYear: opening.taxYear };
    opening = await loadOpening(input, true);
    if (
      !opening ||
      opening.employeePartyId !== retainedIdentity.employeePartyId ||
      opening.taxYear !== retainedIdentity.taxYear
    ) {
      throw new PayrollError(
        "The native opening identity changed; reload before qualifying its statutory source",
      );
    }
    const childrenMatch = (
      await db.execute<{ matches: boolean }>(
        sql`
      select encode(public.digest(public.payroll_opening_source_children(${input.orgId},${input.openingBalanceId},${opening.employeePartyId},${opening.taxYear})::text,'sha256'),'hex')=${input.expectedOpeningChildrenSha256} as matches
    `,
        "objects",
      )
    )[0]?.matches;
    if (!childrenMatch)
      throw new PayrollError(
        "The original opening component, programme or account amounts changed; reload their exact source before qualification",
      );
    const employerAuthority = (
      await db.execute<StoredEmployerAuthority & { matches: boolean }>(
        sql`
      select a.id, a.opening_balance_id as "openingBalanceId", a.employee_party_id as "employeePartyId",
        a.tax_year as "taxYear", a.subsidiary_id as "subsidiaryId", a.source_file_id as "sourceFileId",
        a.source_version_id as "sourceVersionId", a.source_sha256 as "sourceSha256",
        a.source_reference as "sourceReference", a.opening_sha256 as "openingSha256",
        (a.opening_sha256=${input.expectedOpeningSha256}
         and a.opening_snapshot=to_jsonb(b)
         and a.opening_sha256=encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')) as matches
       from payroll_opening_employer_authorities a
       join payroll_opening_balances b on b.org_id=a.org_id and b.id=a.opening_balance_id
      where a.org_id=${input.orgId} and a.opening_balance_id=${input.openingBalanceId}
      for share of a,b
    `,
        "objects",
      )
    )[0];
    if (!employerAuthority)
      throw new PayrollError(
        "Qualify the original opening legal employer and exact source file before allocating statutory history",
      );
    await requireNativeFileReadAuthority(
      { orgId: input.orgId, actorId: input.actorId, fileId: employerAuthority.sourceFileId },
      db,
    );
    if (!employerAuthority.matches)
      throw new PayrollError(
        "The source-qualified opening changed; reload its retained amounts before allocating statutory history",
      );
    const employer = (
      await db.execute<{ id: string }>(
        sql`
      select id from subsidiaries where org_id=${input.orgId} and id=${employerAuthority.subsidiaryId}
        ${payrollSubsidiaryScopeFilter(sql`id`, input.allowedSubsidiaryIds)}
        ${payrollSubsidiaryScopeFilter(sql`id`, commandAuthority)} for share
    `,
        "objects",
      )
    )[0];
    if (!employer)
      throw new PayrollError(
        "The original opening legal employer is outside your payroll authority",
      );
    validateOpeningLevySourceFacts(
      input,
      opening.taxYear,
      PAYROLL_COUNTRY_PACKS[input.originalCountry],
    );
    requiredAllocations(input.originalCountry, allocations);
    await requireNativeFileReadAuthority(
      { orgId: input.orgId, actorId: input.actorId, fileId: input.sourceFileId },
      db,
    );

    const retainedFile = await db.execute(
      sql`select v.id from files f join file_versions v on v.file_id=f.id
      where f.org_id=${input.orgId} and f.id=${input.sourceFileId} and not f.is_inactive
        and v.id=${input.sourceVersionId} and v.content_hash=${input.sourceSha256} and v.created_by=${input.actorId}
      for share of f,v`,
      "objects",
    );
    if (retainedFile.length !== 1)
      throw new PayrollError(
        "Select the active original Cabinet file and its exact retained version and hash",
      );

    if (correction) {
      const replay = await db.execute<{ id: string; allocationSha256: string; matches: boolean }>(
        sql`
        select h.id,h.allocation_sha256 as "allocationSha256",
          (h.request_sha256=${requestSha256} and h.created_by=${input.actorId}
            and h.opening_balance_id=${input.openingBalanceId} and h.subsidiary_id=${employerAuthority.subsidiaryId}
            and h.sealed) as matches
          from payroll_opening_levy_source_authorities h
         where h.org_id=${input.orgId} and h.request_id=${correction.requestId}
      `,
        "objects",
      );
      if (replay.length) {
        if (replay.length !== 1 || !replay[0]!.matches)
          throw new PayrollError(
            "This source correction request already preserves different evidence; reload and review its retained result",
          );
        return {
          id: replay[0]!.id,
          openingBalanceId: input.openingBalanceId,
          subsidiaryId: employerAuthority.subsidiaryId,
          allocationSha256: replay[0]!.allocationSha256,
        };
      }
    }

    const prior = await db.execute<{
      id: string;
      sealed: boolean;
      allocationSha256: string;
      matches: boolean;
    }>(
      sql`
      select h.id,h.sealed,h.allocation_sha256 as "allocationSha256",
        (h.employer_authority_id=${employerAuthority.id} and h.change_reason=${reason}
          and h.opening_sha256=${input.expectedOpeningSha256}
          and h.source_file_id=${input.sourceFileId} and h.source_version_id=${input.sourceVersionId}
          and h.source_sha256=${input.sourceSha256} and h.source_reference=${sourceReference}
          and h.original_country=${input.originalCountry} and h.original_currency=${input.originalCurrency}
          and h.coverage_start=${input.coverageStart}::date and h.coverage_end=${input.coverageEnd}::date
          and h.coverage_complete=${input.coverageComplete}) as matches
        from payroll_opening_levy_source_authorities h
       where h.org_id=${input.orgId} and h.opening_balance_id=${input.openingBalanceId}
         and ${currentOpeningLevySourceSql("h")}
       for update of h
    `,
      "objects",
    );
    if (!correction && prior.length) {
      const storedRows = await db.execute<{
        programKey: string;
        region: string;
        subRegion: string;
        filingAccountId: string | null;
        federalAccountId: string | null;
        amount: string;
      }>(
        sql`
        select program_key as "programKey",region,sub_region as "subRegion",filing_account_id as "filingAccountId",federal_account_id as "federalAccountId",amount::text
          from payroll_opening_levy_source_allocations where org_id=${input.orgId} and authority_id=${prior[0]!.id}
         order by program_key,region,sub_region,filing_account_id nulls first,federal_account_id nulls first
      `,
        "objects",
      );
      const same =
        prior.length === 1 &&
        prior[0]!.sealed &&
        JSON.stringify(storedRows) === JSON.stringify(allocations) &&
        prior[0]!.matches;
      if (!same)
        throw new PayrollError(
          "Statutory levy opening source authority already preserves different allocation evidence",
        );
      return {
        id: prior[0]!.id,
        openingBalanceId: input.openingBalanceId,
        subsidiaryId: employerAuthority.subsidiaryId,
        allocationSha256: prior[0]!.allocationSha256,
      };
    }

    if (correction) {
      if (
        prior.length !== 1 ||
        !prior[0]!.sealed ||
        prior[0]!.id !== correction.expectedAuthorityId ||
        prior[0]!.allocationSha256 !== correction.expectedAllocationSha256
      ) {
        throw new PayrollError(
          "The sealed opening certificate changed; reload its current source and allocation digest before correcting it",
        );
      }
      await requireUnconsumedOpeningLevySource(db, {
        orgId: input.orgId,
        taxYear: opening.taxYear,
        subsidiaryId: employerAuthority.subsidiaryId,
        employeePartyId: opening.employeePartyId,
        openingBalanceId: input.openingBalanceId,
        authorityId: correction.expectedAuthorityId,
      });
    }

    await PAYROLL_COUNTRY_PACKS[input.originalCountry]?.openingLevySource?.validateOpening({
      orgId: input.orgId,
      subsidiaryId: employerAuthority.subsidiaryId,
      opening,
      allocations,
    });

    const id = (
      await db.execute<{ id: string }>(sql`select public.uuid_generate_v7() as id`, "objects")
    )[0]?.id;
    if (!id)
      throw new PayrollError(
        "The opening levy source authority could not allocate its native identity",
      );
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into payroll_opening_levy_source_authorities
        (id,org_id,opening_balance_id,employer_authority_id,employee_party_id,tax_year,subsidiary_id,
         source_file_id,source_version_id,source_sha256,source_reference,change_reason,opening_sha256,
         original_country,original_currency,coverage_start,coverage_end,coverage_complete,
         opening_children_snapshot,opening_children_sha256,
         allocation_sha256,allocation_snapshot,sealed,created_by,supersedes_authority_id,request_id,request_sha256)
      values (${id},${input.orgId},${input.openingBalanceId},${employerAuthority.id},${opening.employeePartyId},${opening.taxYear},
        ${employerAuthority.subsidiaryId},${input.sourceFileId},${input.sourceVersionId},
        ${input.sourceSha256},${sourceReference},${reason},${employerAuthority.openingSha256},
        ${input.originalCountry},${input.originalCurrency},${input.coverageStart}::date,${input.coverageEnd}::date,${input.coverageComplete},
        public.payroll_opening_source_children(${input.orgId},${input.openingBalanceId},${opening.employeePartyId},${opening.taxYear}),
        encode(public.digest(public.payroll_opening_source_children(${input.orgId},${input.openingBalanceId},${opening.employeePartyId},${opening.taxYear})::text,'sha256'),'hex'),
        repeat('0',64),'[]'::jsonb,false,${input.actorId},${correction?.expectedAuthorityId ?? null},${correction?.requestId ?? null},${requestSha256}) returning id
    `,
      "objects",
    );
    if (inserted.length !== 1)
      throw new PayrollError("The opening levy source authority was not saved");
    for (const row of allocations) {
      const saved = await db.execute(
        sql`
        insert into payroll_opening_levy_source_allocations
          (org_id,authority_id,program_key,region,sub_region,filing_account_id,federal_account_id,amount,created_by)
        values (${input.orgId},${id},${row.programKey},${row.region},${row.subRegion},${row.filingAccountId},${row.federalAccountId},${row.amount},${input.actorId})
        returning id
      `,
        "objects",
      );
      if (saved.length !== 1)
        throw new PayrollError(
          `The ${row.programKey} ${row.region} opening allocation was not saved`,
        );
    }
    const sealed = await db.execute<{ id: string; allocationSha256: string }>(
      sql`
      update payroll_opening_levy_source_authorities h
         set allocation_snapshot=(select coalesce(jsonb_agg(jsonb_build_object(
           'programKey',a.program_key,'region',a.region,'subRegion',a.sub_region,
           'filingAccountId',a.filing_account_id,'federalAccountId',a.federal_account_id,'amount',a.amount::text
         ) order by a.program_key,a.region,a.sub_region,a.filing_account_id nulls first,a.federal_account_id nulls first),'[]'::jsonb)
           from payroll_opening_levy_source_allocations a where a.org_id=h.org_id and a.authority_id=h.id),
             allocation_sha256=encode(public.digest((select coalesce(jsonb_agg(jsonb_build_object(
               'programKey',a.program_key,'region',a.region,'subRegion',a.sub_region,
               'filingAccountId',a.filing_account_id,'federalAccountId',a.federal_account_id,'amount',a.amount::text
             ) order by a.program_key,a.region,a.sub_region,a.filing_account_id nulls first,a.federal_account_id nulls first),'[]'::jsonb)::text
               from payroll_opening_levy_source_allocations a where a.org_id=h.org_id and a.authority_id=h.id),'sha256'),'hex'),
             sealed=true
       where h.org_id=${input.orgId} and h.id=${id} and not h.sealed
      returning id,allocation_sha256 as "allocationSha256"
    `,
      "objects",
    );
    if (sealed.length !== 1)
      throw new PayrollError("The exact statutory levy opening allocation could not be sealed");
    const audit = await db.execute(
      sql`
      insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      select h.org_id,'payroll_opening_levy_source_authorities',h.id,'insert',
        jsonb_build_object('before',(select to_jsonb(previous) from payroll_opening_levy_source_authorities previous
          where previous.org_id=h.org_id and previous.id=h.supersedes_authority_id),
          'after',to_jsonb(h),'allocations',h.allocation_snapshot,'reason',${reason}::text,
          'requestId',h.request_id,'requestSha256',h.request_sha256),${input.actorId}
        from payroll_opening_levy_source_authorities h where h.org_id=${input.orgId} and h.id=${id} returning id
    `,
      "objects",
    );
    if (audit.length !== 1)
      throw new PayrollError("The statutory levy opening allocation audit was not retained");
    const observable = await db.execute<{ id: string; allocationSha256: string }>(
      sql`
      select h.id,h.allocation_sha256 as "allocationSha256" from payroll_opening_levy_source_authorities h
       where h.org_id=${input.orgId} and h.id=${id} and h.sealed and ${currentOpeningLevySourceSql("h")}
    `,
      "objects",
    );
    if (
      observable.length !== 1 ||
      observable[0]!.allocationSha256 !== sealed[0]!.allocationSha256
    ) {
      throw new PayrollError(
        "The sealed statutory opening certificate is unavailable through its current source resolution",
      );
    }
    return {
      id,
      openingBalanceId: input.openingBalanceId,
      subsidiaryId: employerAuthority.subsidiaryId,
      allocationSha256: sealed[0]!.allocationSha256,
    };
  });
}

export async function readOpeningLevySourceContext(input: {
  orgId: string;
  actorId: string;
  employeePartyId: string;
  taxYear: number;
  sourceFileId?: string;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
}) {
  if (
    ![input.orgId, input.actorId, input.employeePartyId].every(isUuid) ||
    input.allowedSubsidiaryIds === undefined ||
    (input.sourceFileId !== undefined && !isUuid(input.sourceFileId)) ||
    !Number.isInteger(input.taxYear)
  )
    throw new PayrollError("Choose a native employee opening and year");
  const { assertTaxYear } = await import("./opening-balances.ts");
  assertTaxYear(input.taxYear);
  return withOrgTransaction(input.orgId, async () => {
    await requirePayrollFeature(db, input.orgId);
    const commandAuthority = await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      null,
      "payroll.read",
    );
    const employers = await db.execute<{ id: string }>(
      sql`
      select distinct e.employer_subsidiary_id as id
        from worker_employments e
       where e.org_id=${input.orgId} and e.worker_party_id=${input.employeePartyId}
         ${payrollSubsidiaryScopeFilter(sql`e.employer_subsidiary_id`, input.allowedSubsidiaryIds)}
         ${payrollSubsidiaryScopeFilter(sql`e.employer_subsidiary_id`, commandAuthority)}
    `,
      "objects",
    );
    if (!employers.length)
      throw new PayrollError(
        "The employee opening has no native employer in your payroll authority",
      );
    const rows = await db.execute<{
      openingBalanceId: string;
      employeePartyId: string;
      taxYear: number;
      openingSha256: string;
      employerAuthorityId: string | null;
      subsidiaryId: string | null;
      originalCountry: string | null;
      originalCurrency: string | null;
      coverageStart: string | null;
      coverageEnd: string | null;
      coverageComplete: boolean | null;
      sourceFileId: string | null;
      sourceVersionId: string | null;
      sourceSha256: string | null;
      sourceReference: string | null;
      levyAuthorityId: string | null;
      levyReason: string | null;
      allocationSha256: string | null;
      openingChildrenSha256: string;
      sealed: boolean | null;
      levyMatches: boolean | null;
    }>(
      sql`
      select b.id as "openingBalanceId",b.employee_party_id as "employeePartyId",b.tax_year as "taxYear",
        encode(public.digest(to_jsonb(b)::text,'sha256'),'hex') as "openingSha256",
        e.id as "employerAuthorityId",e.subsidiary_id as "subsidiaryId",
        h.original_country as "originalCountry",h.original_currency as "originalCurrency",
        h.coverage_start::text as "coverageStart",h.coverage_end::text as "coverageEnd",h.coverage_complete as "coverageComplete",
        h.source_file_id as "sourceFileId",h.source_version_id as "sourceVersionId",h.source_sha256 as "sourceSha256",
        h.source_reference as "sourceReference",h.id as "levyAuthorityId",h.change_reason as "levyReason",
        h.allocation_sha256 as "allocationSha256",encode(public.digest(public.payroll_opening_source_children(b.org_id,b.id,b.employee_party_id,b.tax_year)::text,'sha256'),'hex') as "openingChildrenSha256",h.sealed,
        (h.sealed and h.employer_authority_id=e.id and h.opening_sha256=e.opening_sha256
          and h.opening_sha256=encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
          and e.opening_snapshot=to_jsonb(b) and e.opening_sha256=encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
          and h.subsidiary_id=e.subsidiary_id
          and h.allocation_snapshot=(select coalesce(jsonb_agg(jsonb_build_object(
            'programKey',x.program_key,'region',x.region,'subRegion',x.sub_region,
            'filingAccountId',x.filing_account_id,'federalAccountId',x.federal_account_id,'amount',x.amount::text
          ) order by x.program_key,x.region,x.sub_region,x.filing_account_id nulls first,x.federal_account_id nulls first),'[]'::jsonb)
            from payroll_opening_levy_source_allocations x where x.org_id=h.org_id and x.authority_id=h.id)
          and exists (select 1 from files f join file_versions v on v.file_id=f.id
            where f.org_id=h.org_id and f.id=h.source_file_id and v.id=h.source_version_id and v.content_hash=h.source_sha256)
          and h.opening_children_snapshot=public.payroll_opening_source_children(h.org_id,h.opening_balance_id,h.employee_party_id,h.tax_year)
          and h.opening_children_sha256=encode(public.digest(h.opening_children_snapshot::text,'sha256'),'hex')
          and h.allocation_sha256=encode(public.digest(h.allocation_snapshot::text,'sha256'),'hex')) as "levyMatches"
       from payroll_opening_balances b
       left join payroll_opening_employer_authorities e on e.org_id=b.org_id and e.opening_balance_id=b.id
       left join payroll_opening_levy_source_authorities h on h.org_id=b.org_id and h.opening_balance_id=b.id
         and ${currentOpeningLevySourceSql("h")}
      where b.org_id=${input.orgId} and b.employee_party_id=${input.employeePartyId} and b.tax_year=${input.taxYear}
    `,
      "objects",
    );
    if (rows.length > 1) throw new PayrollError("The employee/year opening identity is ambiguous");
    const record = rows[0] ?? null;
    if (record?.sourceFileId)
      await requireNativeFileReadAuthority(
        { orgId: input.orgId, actorId: input.actorId, fileId: record.sourceFileId },
        db,
      );
    if (record?.levyAuthorityId && !record.levyMatches) {
      throw new PayrollError(
        "The statutory levy opening source no longer matches its immutable legal-employer evidence",
      );
    }
    if (record?.levyAuthorityId) {
      validateOpeningLevySourceFacts(
        {
          originalCountry: record.originalCountry!,
          originalCurrency: record.originalCurrency!,
          coverageStart: record.coverageStart!,
          coverageEnd: record.coverageEnd!,
          coverageComplete: record.coverageComplete as true,
        },
        record.taxYear,
        PAYROLL_COUNTRY_PACKS[record.originalCountry!],
      );
    }
    if (record?.subsidiaryId) {
      if (!employers.some((employer) => employer.id === record.subsidiaryId)) {
        throw new PayrollError(
          "The original opening legal employer is outside your payroll authority",
        );
      }
      const employer = await db.execute(
        sql`select id from subsidiaries where org_id=${input.orgId} and id=${record.subsidiaryId}
        ${payrollSubsidiaryScopeFilter(sql`id`, input.allowedSubsidiaryIds)}
        ${payrollSubsidiaryScopeFilter(sql`id`, commandAuthority)}`,
        "objects",
      );
      if (employer.length !== 1)
        throw new PayrollError(
          "The original opening legal employer is outside your payroll authority",
        );
    }
    const allocations = record?.levyAuthorityId
      ? await db.execute<OpeningLevySourceAllocation>(
          sql`
      select program_key as "programKey",region,sub_region as "subRegion",filing_account_id as "filingAccountId",federal_account_id as "federalAccountId",amount::text
        from payroll_opening_levy_source_allocations
       where org_id=${input.orgId} and authority_id=${record.levyAuthorityId}
       order by program_key,region,sub_region,filing_account_id nulls first,federal_account_id nulls first
    `,
          "objects",
        )
      : [];
    const eins = record?.subsidiaryId
      ? await db.execute<{ id: string; name: string; isActive: boolean }>(
          sql`
      select id,name,is_active as "isActive" from payroll_filing_accounts
       where org_id=${input.orgId} and country='US' and program_type='us_ein'
         and (subsidiary_id=${record.subsidiaryId} or subsidiary_id is null)
       order by name,id
    `,
          "objects",
        )
      : [];
    const suiAccounts = record?.subsidiaryId
      ? await db.execute<{ id: string; name: string; stateCode: string; isActive: boolean }>(
          sql`
      select id,name,state_code as "stateCode",is_active as "isActive" from payroll_filing_accounts
       where org_id=${input.orgId} and country='US' and program_type='us_state_sui'
         and state_code is not null and (subsidiary_id=${record.subsidiaryId} or subsidiary_id is null)
       order by state_code,name,id
    `,
          "objects",
        )
      : [];
    const openingSuiStates = record
      ? (
          await db.execute<{ region: string }>(
            sql`
      select state as region from payroll_opening_sui_wages sw
        join payroll_opening_balances b on b.org_id=sw.org_id and b.id=sw.opening_balance_id
       where b.org_id=${input.orgId} and b.id=${record.openingBalanceId}
       order by state
    `,
            "objects",
          )
        ).map((row) => row.region)
      : [];
    const openingSuiAccountIds = record
      ? (
          await db.execute<{ id: string }>(
            sql`
      select distinct filing_account_id as id from payroll_opening_account_bases
       where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} and tax_year=${input.taxYear}
         and program_key='us_sui'
    `,
            "objects",
          )
        ).map((row) => row.id)
      : [];
    if (input.sourceFileId)
      await requireNativeFileReadAuthority(
        { orgId: input.orgId, actorId: input.actorId, fileId: input.sourceFileId },
        db,
      );
    const source = input.sourceFileId
      ? ((
          await db.execute<{ id: string; versionId: string; sha256: string; name: string }>(
            sql`
      select f.id,v.id as "versionId",v.content_hash as sha256,f.name from files f
        join file_versions v on v.file_id=f.id and v.id=f.current_version_id
       where f.org_id=${input.orgId} and f.id=${input.sourceFileId} and not f.is_inactive and v.created_by=${input.actorId}
    `,
            "objects",
          )
        )[0] ?? null)
      : null;
    if (input.sourceFileId && (!source || !/^[a-f0-9]{64}$/.test(source.sha256))) {
      throw new PayrollError(
        "Select the exact original file uploaded to Cabinet by the qualifying operator",
      );
    }
    let correctionRefusal: string | null = null;
    if (record?.levyAuthorityId && record.subsidiaryId) {
      try {
        await requireUnconsumedOpeningLevySource(db, {
          orgId: input.orgId,
          taxYear: record.taxYear,
          subsidiaryId: record.subsidiaryId,
          employeePartyId: record.employeePartyId,
          openingBalanceId: record.openingBalanceId,
          authorityId: record.levyAuthorityId,
        });
      } catch (error) {
        if (!(error instanceof PayrollError)) throw error;
        correctionRefusal = error.message;
      }
    }
    return {
      record,
      allocations,
      eins,
      suiAccounts,
      openingSuiStates,
      openingSuiAccountIds,
      source,
      correctionRefusal,
      countries: Object.values(PAYROLL_COUNTRY_PACKS).map((pack) => ({
        country: pack.country,
        currency: pack.statutoryCurrency,
      })),
    };
  });
}
