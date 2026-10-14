import { sql } from 'drizzle-orm';
import { add, cmp, normalizeMoney, sum } from '../money/money.ts';
import { db, withOrgTransaction } from '../platform/db.ts';
import { isUuid } from '../platform/uuid.ts';
import { actorHasPermission } from '../organization/actor-permissions.ts';
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts';
import { requirePayrollFeature } from './feature-gate.ts';
import { employeeTaxYearFenceKey, takeEmployeeTaxYearFences } from './fences.ts';
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from './scope.ts';
import { PayrollError } from './error.ts';
import { requireNativeFileReadAuthority } from '../records/file-read-authority.ts';
import { canonicalNonNegativeDecimal } from '../money/exact-decimal.ts';

export type OpeningLevyProgram = 'ca_wcb' | 'ca_eht' | 'ca_cnt' | 'us_futa' | 'us_sui' | 'us_pa_lst';
export type OpeningLevySourceAllocation = {
  programKey: OpeningLevyProgram;
  region: string;
  subRegion: string;
  filingAccountId: string | null;
  amount: string;
};

export type OpeningLevySourceAllocationInput = {
  programKey: string;
  region: string;
  subRegion?: string;
  filingAccountId?: string | null;
  amount: string;
};

const CA_PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'] as const;
const CA_EHT_PROVINCES = ['BC', 'MB', 'NL', 'ON'] as const;
const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA',
  'MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX',
  'UT','VT','VA','WA','WV','WI','WY',
] as const;
const CA_PROGRAMS = new Set<OpeningLevyProgram>(['ca_wcb', 'ca_eht', 'ca_cnt']);
const US_PROGRAMS = new Set<OpeningLevyProgram>(['us_futa', 'us_sui', 'us_pa_lst']);

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

function canonicalAllocations(input: readonly OpeningLevySourceAllocationInput[]): OpeningLevySourceAllocation[] {
  if (!Array.isArray(input) || input.length === 0) throw new PayrollError('Record the complete statutory levy opening allocation, including explicit zeros');
  const seen = new Set<string>();
  return input.map((raw) => {
    if (!raw || typeof raw !== 'object' || !['ca_wcb','ca_eht','ca_cnt','us_futa','us_sui','us_pa_lst'].includes(raw.programKey)
      || typeof raw.region !== 'string' || typeof raw.amount !== 'string'
      || raw.subRegion !== undefined && typeof raw.subRegion !== 'string'
      || raw.filingAccountId !== undefined && raw.filingAccountId !== null && typeof raw.filingAccountId !== 'string') {
      throw new PayrollError('Choose a declared statutory programme, original jurisdiction and exact-decimal opening amount');
    }
    const programKey = raw.programKey as OpeningLevyProgram;
    const region = raw.region.trim().toUpperCase();
    const subRegion = (raw.subRegion ?? '').trim();
    const filingAccountId = raw.filingAccountId ?? null;
    if (filingAccountId !== null && !isUuid(filingAccountId)) throw new PayrollError('Choose a native EIN account for the US wage-base opening');
    const scopeValid = programKey === 'ca_wcb'
      ? (CA_PROVINCES as readonly string[]).includes(region) && !subRegion && filingAccountId === null
      : programKey === 'ca_eht'
        ? (CA_EHT_PROVINCES as readonly string[]).includes(region) && !subRegion && filingAccountId === null
        : programKey === 'ca_cnt'
          ? region === 'QC' && !subRegion && filingAccountId === null
          : programKey === 'us_futa'
            ? region === 'US' && !subRegion && filingAccountId !== null
            : programKey === 'us_sui'
              ? (US_STATES as readonly string[]).includes(region) && !subRegion
              : region === 'PA' && /^[0-9]{6}$/.test(subRegion) && filingAccountId === null;
    if (!scopeValid) throw new PayrollError(`${programKey} needs its original programme jurisdiction and legal-employer account scope`);
    if (canonicalNonNegativeDecimal(raw.amount, 4) === null) throw new PayrollError('Opening allocation must be an exact non-negative decimal with at most four decimal places');
    let amount: string;
    try { amount = normalizeMoney(raw.amount); }
    catch (error) { throw new PayrollError(`Opening allocation ${programKey}/${region} is not an exact non-negative amount: ${error instanceof Error ? error.message : String(error)}`); }
    if (cmp(amount, '0') < 0) throw new PayrollError('Statutory levy opening allocations cannot be negative');
    const key = [programKey, region, subRegion, filingAccountId ?? ''].join('|');
    if (seen.has(key)) throw new PayrollError(`Duplicate statutory levy opening allocation ${programKey}/${region}/${subRegion}`);
    seen.add(key);
    return { programKey, region, subRegion, filingAccountId, amount };
  }).sort((a, b) => [a.programKey, a.region, a.subRegion, a.filingAccountId ?? ''].join('|')
    .localeCompare([b.programKey, b.region, b.subRegion, b.filingAccountId ?? ''].join('|')));
}

function requiredAllocations(country: string, rows: readonly OpeningLevySourceAllocation[]) {
  const byProgram = new Map<OpeningLevyProgram, OpeningLevySourceAllocation[]>();
  for (const row of rows) byProgram.set(row.programKey, [...(byProgram.get(row.programKey) ?? []), row]);
  if (country === 'CA') {
    if (rows.some((row) => !CA_PROGRAMS.has(row.programKey))) throw new PayrollError('A Canadian opening cannot contain US levy allocations');
    for (const province of CA_PROVINCES) if (!byProgram.get('ca_wcb')?.some((row) => row.region === province)) {
      throw new PayrollError(`Declare the original WCB/WSIB opening for ${province}, including zero when the source confirms none`);
    }
    for (const province of CA_EHT_PROVINCES) if (!byProgram.get('ca_eht')?.some((row) => row.region === province)) {
      throw new PayrollError(`Declare the original EHT opening for ${province}, including zero when the source confirms none`);
    }
    if (!byProgram.get('ca_cnt')?.some((row) => row.region === 'QC')) {
      throw new PayrollError('Declare the original Québec CNT opening, including zero when the source confirms none');
    }
    return;
  }
  if (country !== 'US') throw new PayrollError(`Statutory levy opening source authority does not support ${country}`);
  if (rows.some((row) => !US_PROGRAMS.has(row.programKey))) throw new PayrollError('A US opening cannot contain Canadian levy allocations');
  if (!byProgram.get('us_futa')?.length) throw new PayrollError('Declare FUTA opening wages for each original EIN, including zero when the source confirms none');
}

async function loadOpening(input: { orgId: string; openingBalanceId: string }, lock = false) {
  return (await db.execute<{
    id: string; employeePartyId: string; taxYear: number; wcbAssessableYtd: string; ehtRemunerationYtd: string;
    insurableYtd: string; country: string | null;
  }>(sql`
    select b.id, b.employee_party_id as "employeePartyId", b.tax_year as "taxYear",
      b.wcb_assessable_ytd::text as "wcbAssessableYtd", b.eht_remuneration_ytd::text as "ehtRemunerationYtd",
      b.insurable_ytd::text as "insurableYtd", s.country
      from payroll_opening_balances b
      left join payroll_opening_employer_authorities a on a.org_id=b.org_id and a.opening_balance_id=b.id
      left join subsidiaries s on s.org_id=a.org_id and s.id=a.subsidiary_id
     where b.org_id=${input.orgId} and b.id=${input.openingBalanceId}
     ${lock ? sql`for update of b` : sql``}
  `)).rows[0] ?? null;
}

export async function qualifyOpeningLevySourceAuthority(input: {
  orgId: string; actorId: string; openingBalanceId: string; expectedOpeningSha256: string;
  allocations: readonly OpeningLevySourceAllocationInput[]; reason: string;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
}): Promise<{ id: string; openingBalanceId: string; subsidiaryId: string; allocationSha256: string }> {
  if (![input.orgId, input.actorId, input.openingBalanceId].every(isUuid)
    || input.allowedSubsidiaryIds === undefined || !/^[a-f0-9]{64}$/.test(input.expectedOpeningSha256)) {
    throw new PayrollError('Choose a native opening balance and its exact retained legal-employer qualification');
  }
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 2000) {
    throw new PayrollError('Record why the original statutory levy opening allocations are being qualified');
  }
  const reason = input.reason.trim();
  const allocations = canonicalAllocations(input.allocations);
  return withOrgTransaction(input.orgId, async () => {
    await requirePayrollFeature(db, input.orgId);
    if (!await actorHasPermission(db, input.orgId, input.actorId, 'payroll.run')) {
      throw new PayrollError('Payroll run permission is required to qualify statutory levy opening history');
    }
    const commandAuthority = await lockActorCommandAuthority(db, input.orgId, input.actorId, null, 'payroll.run');
    let opening = await loadOpening(input);
    if (!opening) throw new PayrollError('The native payroll opening record is unavailable');
    await takeEmployeeTaxYearFences(db, [employeeTaxYearFenceKey(input.orgId, opening.employeePartyId, opening.taxYear)]);
    const retainedIdentity = { employeePartyId: opening.employeePartyId, taxYear: opening.taxYear };
    opening = await loadOpening(input, true);
    if (!opening || opening.employeePartyId !== retainedIdentity.employeePartyId || opening.taxYear !== retainedIdentity.taxYear) {
      throw new PayrollError('The native opening identity changed; reload before qualifying its statutory source');
    }
    const employerAuthority = (await db.execute<StoredEmployerAuthority & { matches: boolean }>(sql`
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
    `)).rows[0];
    if (!employerAuthority) throw new PayrollError('Qualify the original opening legal employer and exact source file before allocating statutory history');
    await requireNativeFileReadAuthority({ orgId: input.orgId, actorId: input.actorId, fileId: employerAuthority.sourceFileId }, db);
    if (!employerAuthority.matches) throw new PayrollError('The source-qualified opening changed; reload its retained amounts before allocating statutory history');
    const employer = (await db.execute<{ country: string; id: string }>(sql`
      select id,country from subsidiaries where org_id=${input.orgId} and id=${employerAuthority.subsidiaryId}
        ${payrollSubsidiaryScopeFilter(sql`id`, input.allowedSubsidiaryIds)}
        ${payrollSubsidiaryScopeFilter(sql`id`, commandAuthority)} for share
    `)).rows[0];
    if (!employer) throw new PayrollError('The original opening legal employer is outside your payroll authority');
    requiredAllocations(employer.country, allocations);

    const prior = (await db.execute<{ id: string; sealed: boolean; allocationSha256: string; matches: boolean }>(sql`
      select h.id,h.sealed,h.allocation_sha256 as "allocationSha256",
        (h.employer_authority_id=${employerAuthority.id} and h.change_reason=${reason}
          and h.opening_sha256=${input.expectedOpeningSha256}) as matches
        from payroll_opening_levy_source_authorities h
       where h.org_id=${input.orgId} and h.opening_balance_id=${input.openingBalanceId}
    `)).rows;
    if (prior.length) {
      const storedRows = (await db.execute<{ programKey: string; region: string; subRegion: string; filingAccountId: string | null; amount: string }>(sql`
        select program_key as "programKey",region,sub_region as "subRegion",filing_account_id as "filingAccountId",amount::text
          from payroll_opening_levy_source_allocations where org_id=${input.orgId} and authority_id=${prior[0]!.id}
         order by program_key,region,sub_region,filing_account_id nulls first
      `)).rows;
      const same = prior.length === 1 && prior[0]!.sealed
        && JSON.stringify(storedRows) === JSON.stringify(allocations)
        && prior[0]!.matches;
      if (!same) throw new PayrollError('Statutory levy opening source authority already preserves different allocation evidence');
      return { id: prior[0]!.id, openingBalanceId: input.openingBalanceId,
        subsidiaryId: employerAuthority.subsidiaryId, allocationSha256: prior[0]!.allocationSha256 };
    }

    if (employer.country === 'CA') {
      const wcb = sum(allocations.filter((row) => row.programKey === 'ca_wcb').map((row) => row.amount));
      const eht = sum(allocations.filter((row) => row.programKey === 'ca_eht').map((row) => row.amount));
      if (cmp(wcb, opening.wcbAssessableYtd) !== 0) {
        throw new PayrollError('The province allocations must equal the original workers’ compensation assessable opening amount');
      }
      if (cmp(eht, opening.ehtRemunerationYtd) !== 0) {
        throw new PayrollError('The province allocations must equal the original EHT remuneration opening amount');
      }
    } else {
      const einRows = (await db.execute<{ id: string; isActive: boolean }>(sql`
        select id,is_active as "isActive" from payroll_filing_accounts
         where org_id=${input.orgId} and country='US' and program_type='us_ein'
           and (subsidiary_id=${employerAuthority.subsidiaryId} or subsidiary_id is null)
         order by id
      `)).rows;
      const retainedEins = einRows;
      if (!retainedEins.length) throw new PayrollError('Add or restore the original US EIN in Payroll Setup → Filing accounts before qualifying FUTA/SUI openings');
      const futa = allocations.filter((row) => row.programKey === 'us_futa');
      if (retainedEins.some((ein) => !futa.some((row) => row.filingAccountId === ein.id))) {
        throw new PayrollError('Declare a FUTA opening for every retained EIN in the original employer account set, including explicit zeros');
      }
      const accountBaseRows = (await db.execute<{ programKey: string; region: string | null; filingAccountId: string; amount: string }>(sql`
        select program_key as "programKey",region,filing_account_id as "filingAccountId",insurable_ytd::text as amount
          from payroll_opening_account_bases where org_id=${input.orgId} and employee_party_id=${opening.employeePartyId}
           and tax_year=${opening.taxYear} and program_key in ('us_futa','us_sui')
      `)).rows;
      const futaAccountBases = accountBaseRows.filter((row) => row.programKey === 'us_futa');
      if (futaAccountBases.length) {
        if (cmp(opening.insurableYtd, '0') !== 0) {
          throw new PayrollError('The employee-only insurable opening must be zero when EIN-specific FUTA openings are recorded');
        }
        if (futa.length !== futaAccountBases.length || futaAccountBases.some((stored) =>
          !futa.some((row) => row.filingAccountId === stored.filingAccountId && cmp(row.amount, stored.amount) === 0))) {
          throw new PayrollError('FUTA source allocations must preserve every exact EIN-specific opening wage base already recorded');
        }
      } else if (cmp(sum(futa.map((row) => row.amount)), opening.insurableYtd) !== 0) {
        throw new PayrollError('The EIN-specific FUTA allocations must equal the original employee-only insurable wage opening');
      }
      const stateRows = (await db.execute<{ region: string; amount: string }>(sql`
        select state as region,insurable_ytd::text as amount from payroll_opening_sui_wages sw
          join payroll_opening_balances b on b.org_id=sw.org_id and b.id=sw.opening_balance_id
         where b.org_id=${input.orgId} and b.employee_party_id=${opening.employeePartyId} and b.tax_year=${opening.taxYear}
      `)).rows;
      const suiAccountBases = accountBaseRows.filter((row) => row.programKey === 'us_sui');
      const sui = allocations.filter((row) => row.programKey === 'us_sui');
      if (futa.length > 1 && allocations.some((row) => row.programKey === 'us_sui' || row.programKey === 'us_pa_lst')) {
        throw new PayrollError('Opening SUI and PA LST cannot be attributed across multiple EINs under one legal employer; retain each EIN under its original native legal employer before qualifying its jurisdiction allocations');
      }
      const suiAccounts = (await db.execute<{ id: string; stateCode: string; isActive: boolean }>(sql`
        select id,state_code as "stateCode",is_active as "isActive" from payroll_filing_accounts
         where org_id=${input.orgId} and country='US' and program_type='us_state_sui'
           and state_code is not null and (subsidiary_id=${employerAuthority.subsidiaryId} or subsidiary_id is null)
         order by id
      `)).rows;
      const retainedSuiAccounts = suiAccounts;
      if (retainedSuiAccounts.some((account) => !sui.some((row) =>
        row.filingAccountId === account.id && row.region === account.stateCode))) {
        throw new PayrollError('Declare the original SUI opening for every retained state account, including explicit zeros');
      }
      for (const row of sui) {
        if (row.filingAccountId !== null && !suiAccounts.some((account) =>
          account.id === row.filingAccountId && account.stateCode === row.region)) {
          throw new PayrollError('SUI source allocations must retain a state account for the same original state and legal employer');
        }
        if (row.filingAccountId === null && suiAccounts.some((account) => account.stateCode === row.region)) {
          throw new PayrollError(`Map the original ${row.region} SUI opening to its native state account in Payroll → Filing accounts`);
        }
      }
      for (const stored of suiAccountBases) {
        if (!sui.some((row) => row.filingAccountId === stored.filingAccountId
          && row.region === stored.region && cmp(row.amount, stored.amount) === 0)) {
          throw new PayrollError(`SUI source allocations must preserve the original ${stored.region ?? 'state'} filing-account wage opening`);
        }
      }
      const priorStates = new Map<string, string>();
      for (const row of [...stateRows, ...suiAccountBases.map((base) => ({ region: base.region ?? '', amount: base.amount }))]) {
        if (!row.region) continue;
        priorStates.set(row.region, add(priorStates.get(row.region) ?? '0', row.amount));
      }
      if (cmp(opening.insurableYtd, '0') > 0 && sui.length === 0) {
        throw new PayrollError('Declare the original US SUI jurisdiction allocations for the generic insurable opening, including a state with zero only when the retained source confirms no SUI wages');
      }
      for (const [state, amount] of priorStates) {
        if (cmp(sum(sui.filter((row) => row.region === state).map((row) => row.amount)), amount) !== 0) {
          throw new PayrollError(`SUI source allocations must preserve the original ${state} state opening wages`);
        }
      }
    }

    const id = (await db.execute<{ id: string }>(sql`select public.uuid_generate_v7() as id`)).rows[0]?.id;
    if (!id) throw new PayrollError('The opening levy source authority could not allocate its native identity');
    const inserted = await db.execute<{ id: string }>(sql`
      insert into payroll_opening_levy_source_authorities
        (id,org_id,opening_balance_id,employer_authority_id,employee_party_id,tax_year,subsidiary_id,
         source_file_id,source_version_id,source_sha256,source_reference,change_reason,opening_sha256,
         allocation_sha256,allocation_snapshot,sealed,created_by)
      values (${id},${input.orgId},${input.openingBalanceId},${employerAuthority.id},${opening.employeePartyId},${opening.taxYear},
        ${employerAuthority.subsidiaryId},${employerAuthority.sourceFileId},${employerAuthority.sourceVersionId},
        ${employerAuthority.sourceSha256},${employerAuthority.sourceReference},${reason},${employerAuthority.openingSha256},
        repeat('0',64),'[]'::jsonb,false,${input.actorId}) returning id
    `);
    if (inserted.rows.length !== 1) throw new PayrollError('The opening levy source authority was not saved');
    for (const row of allocations) {
      const saved = await db.execute(sql`
        insert into payroll_opening_levy_source_allocations
          (org_id,authority_id,program_key,region,sub_region,filing_account_id,amount,created_by)
        values (${input.orgId},${id},${row.programKey},${row.region},${row.subRegion},${row.filingAccountId},${row.amount},${input.actorId})
        returning id
      `);
      if (saved.rows.length !== 1) throw new PayrollError(`The ${row.programKey} ${row.region} opening allocation was not saved`);
    }
    const sealed = await db.execute<{ id: string; allocationSha256: string }>(sql`
      update payroll_opening_levy_source_authorities h
         set allocation_snapshot=(select coalesce(jsonb_agg(jsonb_build_object(
           'programKey',a.program_key,'region',a.region,'subRegion',a.sub_region,
           'filingAccountId',a.filing_account_id,'amount',a.amount::text
         ) order by a.program_key,a.region,a.sub_region,a.filing_account_id nulls first),'[]'::jsonb)
           from payroll_opening_levy_source_allocations a where a.org_id=h.org_id and a.authority_id=h.id),
             allocation_sha256=encode(public.digest((select coalesce(jsonb_agg(jsonb_build_object(
               'programKey',a.program_key,'region',a.region,'subRegion',a.sub_region,
               'filingAccountId',a.filing_account_id,'amount',a.amount::text
             ) order by a.program_key,a.region,a.sub_region,a.filing_account_id nulls first),'[]'::jsonb)::text
               from payroll_opening_levy_source_allocations a where a.org_id=h.org_id and a.authority_id=h.id),'sha256'),'hex'),
             sealed=true
       where h.org_id=${input.orgId} and h.id=${id} and not h.sealed
      returning id,allocation_sha256 as "allocationSha256"
    `);
    if (sealed.rows.length !== 1) throw new PayrollError('The exact statutory levy opening allocation could not be sealed');
    const audit = await db.execute(sql`
      insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      select h.org_id,'payroll_opening_levy_source_authorities',h.id,'insert',
        jsonb_build_object('after',to_jsonb(h),'allocations',h.allocation_snapshot,'reason',${reason}::text),${input.actorId}
        from payroll_opening_levy_source_authorities h where h.org_id=${input.orgId} and h.id=${id} returning id
    `);
    if (audit.rows.length !== 1) throw new PayrollError('The statutory levy opening allocation audit was not retained');
    return { id, openingBalanceId: input.openingBalanceId, subsidiaryId: employerAuthority.subsidiaryId,
      allocationSha256: sealed.rows[0]!.allocationSha256 };
  });
}

export async function readOpeningLevySourceContext(input: {
  orgId: string; actorId: string; employeePartyId: string; taxYear: number; allowedSubsidiaryIds: PayrollSubsidiaryScope;
}) {
  if (![input.orgId, input.actorId, input.employeePartyId].every(isUuid) || input.allowedSubsidiaryIds === undefined
    || !Number.isInteger(input.taxYear)) throw new PayrollError('Choose a native employee opening and year');
  const { assertTaxYear } = await import('./opening-balances.ts');
  assertTaxYear(input.taxYear);
  return withOrgTransaction(input.orgId, async () => {
    await requirePayrollFeature(db, input.orgId);
    const commandAuthority = await lockActorCommandAuthority(db, input.orgId, input.actorId, null, 'payroll.read');
    const employers = (await db.execute<{ id: string }>(sql`
      select distinct e.employer_subsidiary_id as id
        from worker_employments e
       where e.org_id=${input.orgId} and e.worker_party_id=${input.employeePartyId}
         ${payrollSubsidiaryScopeFilter(sql`e.employer_subsidiary_id`, input.allowedSubsidiaryIds)}
         ${payrollSubsidiaryScopeFilter(sql`e.employer_subsidiary_id`, commandAuthority)}
    `)).rows;
    if (!employers.length) throw new PayrollError('The employee opening has no native employer in your payroll authority');
    const rows = (await db.execute<{
      openingBalanceId: string; employeePartyId: string; taxYear: number; openingSha256: string;
      employerAuthorityId: string | null; subsidiaryId: string | null; country: string | null;
      sourceFileId: string | null; sourceVersionId: string | null; sourceSha256: string | null; sourceReference: string | null;
      levyAuthorityId: string | null; levyReason: string | null; allocationSha256: string | null; sealed: boolean | null;
      levyMatches: boolean | null;
    }>(sql`
      select b.id as "openingBalanceId",b.employee_party_id as "employeePartyId",b.tax_year as "taxYear",
        encode(public.digest(to_jsonb(b)::text,'sha256'),'hex') as "openingSha256",
        e.id as "employerAuthorityId",e.subsidiary_id as "subsidiaryId",s.country,
        e.source_file_id as "sourceFileId",e.source_version_id as "sourceVersionId",e.source_sha256 as "sourceSha256",
        e.source_reference as "sourceReference",h.id as "levyAuthorityId",h.change_reason as "levyReason",
        h.allocation_sha256 as "allocationSha256",h.sealed,
        (h.sealed and h.employer_authority_id=e.id and h.opening_sha256=e.opening_sha256
          and h.opening_sha256=encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
          and e.opening_snapshot=to_jsonb(b) and e.opening_sha256=encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
          and h.subsidiary_id=e.subsidiary_id and h.source_file_id=e.source_file_id
          and h.source_version_id=e.source_version_id and h.source_sha256=e.source_sha256
          and h.source_reference=e.source_reference
          and h.allocation_snapshot=(select coalesce(jsonb_agg(jsonb_build_object(
            'programKey',x.program_key,'region',x.region,'subRegion',x.sub_region,
            'filingAccountId',x.filing_account_id,'amount',x.amount::text
          ) order by x.program_key,x.region,x.sub_region,x.filing_account_id nulls first),'[]'::jsonb)
            from payroll_opening_levy_source_allocations x where x.org_id=h.org_id and x.authority_id=h.id)
          and h.allocation_sha256=encode(public.digest(h.allocation_snapshot::text,'sha256'),'hex')) as "levyMatches"
       from payroll_opening_balances b
       left join payroll_opening_employer_authorities e on e.org_id=b.org_id and e.opening_balance_id=b.id
       left join subsidiaries s on s.org_id=e.org_id and s.id=e.subsidiary_id
       left join payroll_opening_levy_source_authorities h on h.org_id=b.org_id and h.opening_balance_id=b.id
      where b.org_id=${input.orgId} and b.employee_party_id=${input.employeePartyId} and b.tax_year=${input.taxYear}
    `)).rows;
    if (rows.length > 1) throw new PayrollError('The employee/year opening identity is ambiguous');
    const record = rows[0] ?? null;
    if (record?.sourceFileId) await requireNativeFileReadAuthority({ orgId: input.orgId, actorId: input.actorId, fileId: record.sourceFileId }, db);
    if (record?.levyAuthorityId && !record.levyMatches) {
      throw new PayrollError('The statutory levy opening source no longer matches its immutable legal-employer evidence');
    }
    if (record?.subsidiaryId) {
      if (!employers.some((employer) => employer.id === record.subsidiaryId)) {
        throw new PayrollError('The original opening legal employer is outside your payroll authority');
      }
      const employer = (await db.execute(sql`select id from subsidiaries where org_id=${input.orgId} and id=${record.subsidiaryId}
        ${payrollSubsidiaryScopeFilter(sql`id`, input.allowedSubsidiaryIds)}
        ${payrollSubsidiaryScopeFilter(sql`id`, commandAuthority)}`)).rows;
      if (employer.length !== 1) throw new PayrollError('The original opening legal employer is outside your payroll authority');
    }
    const allocations = record?.levyAuthorityId ? (await db.execute<OpeningLevySourceAllocation>(sql`
      select program_key as "programKey",region,sub_region as "subRegion",filing_account_id as "filingAccountId",amount::text
        from payroll_opening_levy_source_allocations
       where org_id=${input.orgId} and authority_id=${record.levyAuthorityId}
       order by program_key,region,sub_region,filing_account_id nulls first
    `)).rows : [];
    const eins = record?.subsidiaryId ? (await db.execute<{ id: string; name: string; isActive: boolean }>(sql`
      select id,name,is_active as "isActive" from payroll_filing_accounts
       where org_id=${input.orgId} and country='US' and program_type='us_ein'
         and (subsidiary_id=${record.subsidiaryId} or subsidiary_id is null)
       order by name,id
    `)).rows : [];
    const suiAccounts = record?.subsidiaryId ? (await db.execute<{ id: string; name: string; stateCode: string; isActive: boolean }>(sql`
      select id,name,state_code as "stateCode",is_active as "isActive" from payroll_filing_accounts
       where org_id=${input.orgId} and country='US' and program_type='us_state_sui'
         and state_code is not null and (subsidiary_id=${record.subsidiaryId} or subsidiary_id is null)
       order by state_code,name,id
    `)).rows : [];
    const openingSuiStates = record ? (await db.execute<{ region: string }>(sql`
      select state as region from payroll_opening_sui_wages sw
        join payroll_opening_balances b on b.org_id=sw.org_id and b.id=sw.opening_balance_id
       where b.org_id=${input.orgId} and b.id=${record.openingBalanceId}
       order by state
    `)).rows.map((row) => row.region) : [];
    const openingSuiAccountIds = record ? (await db.execute<{ id: string }>(sql`
      select distinct filing_account_id as id from payroll_opening_account_bases
       where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} and tax_year=${input.taxYear}
         and program_key='us_sui'
    `)).rows.map((row) => row.id) : [];
    return { record, allocations, eins, suiAccounts, openingSuiStates, openingSuiAccountIds };
  });
}
