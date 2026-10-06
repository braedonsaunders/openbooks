import { sql } from 'drizzle-orm';
import { db, inExecutorTransaction, withOrgTransaction, type SqlExecutor } from '../platform/db.ts';
import { addCalendarDays, isIsoCalendarDate } from '../platform/civil-date.ts';
import { businessTodayInTx } from '../platform/business-date.ts';
import { isUuid } from '../platform/uuid.ts';
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts';
import { lockScopeRows } from '../organization/subsidiary-scope.ts';
import { canonicalDecimal } from '../money/exact-decimal.ts';
import { decimalNullRefusal } from '../money/decimal-refusal.ts';
import { normalizeDecimal } from '../money/money.ts';
import { certificateAnswersProblem, packCertificates, payrollCertificate, resolveCertificate, type StoredCertificate } from './certificates.ts';
import { employeeTaxYearFenceKey, takeEmployeeTaxYearFences } from './fences.ts';
import { requirePayrollFeature } from './feature-gate.ts';
import { PAYROLL_COUNTRY_PACKS } from './packs.ts';
import { PayrollError } from './error.ts';
import type { PayrollSubsidiaryScope } from './scope.ts';

/** Restore known withholding inputs only within their documented historical window.
 * Current profile settings remain authoritative outside that window. */
export async function recordHistoricalWithholding(input: {
  orgId: string; actorId: string; employeePartyId: string; country: string;
  certificateKey: string; answers: Record<string, string>; expectedCurrent: Record<string, string>;
  effectiveFrom: string; effectiveTo: string; reason: string;
  allowedSubsidiaryIds: PayrollSubsidiaryScope; dryRun: boolean;
}, executor?: SqlExecutor): Promise<{ changed: boolean; id: string | null }> {
  if (!isUuid(input.employeePartyId) || input.allowedSubsidiaryIds === undefined || typeof input.dryRun !== 'boolean') {
    throw new PayrollError('Choose a saved employee and an explicit legal-entity scope before importing historical withholding inputs.');
  }
  if (!isIsoCalendarDate(input.effectiveFrom) || !isIsoCalendarDate(input.effectiveTo) ||
      input.effectiveTo < input.effectiveFrom || input.effectiveFrom.slice(0, 4) !== input.effectiveTo.slice(0, 4)) {
    throw new PayrollError('Enter a bounded historical withholding window within one tax year.');
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 2000) throw new PayrollError('Provide a dated source reference and reason of 1–2000 characters.');
  if (!Object.hasOwn(PAYROLL_COUNTRY_PACKS, input.country)) throw new PayrollError('Choose a declared payroll country before importing historical withholding.');
  const certificate = payrollCertificate(input.country, input.certificateKey);
  if (certificate.storage !== 'profile_columns') throw new PayrollError('Use the native certificate filing workflow for this form; historical profile inputs apply only to profile-backed withholding fields.');
  const fields = Object.keys(input.answers);
  if (!fields.length || fields.some(key => typeof input.answers[key] !== 'string' || !input.answers[key]?.trim() ||
      !certificate.fields.some(field => field.key === key && field.storage?.kind === 'column'))) {
    throw new PayrollError('Supply nonempty historical answers for this form’s declared profile fields.');
  }
  for (const key of fields) {
    const field = certificate.fields.find(field => field.key === key)!;
    if (field.kind === 'amount' && field.decimals != null) {
      for (const value of [input.answers[key], input.expectedCurrent[key]]) {
        if (value === '' || value === undefined) continue;
        if (canonicalDecimal(value, field.decimals) === null) {
          throw new PayrollError(decimalNullRefusal(field.label, 'a withholding amount', value, field.decimals));
        }
      }
    }
  }
  const problem = certificateAnswersProblem(certificate, input.answers);
  if (problem) throw new PayrollError(problem);
  const answers = Object.fromEntries(fields.map(key => {
    const field = certificate.fields.find(field => field.key === key)!;
    return [key, field.kind === 'amount' && field.decimals != null
      ? normalizeDecimal(input.answers[key]!, field.decimals) : input.answers[key]!.trim()];
  }));
  const apply = async (tx: SqlExecutor) => {
    const authority = await lockActorCommandAuthority(tx, input.orgId, input.actorId, null, 'payroll.manage');
    await requirePayrollFeature(tx, input.orgId);
    await takeEmployeeTaxYearFences(tx, [employeeTaxYearFenceKey(input.orgId, input.employeePartyId, input.effectiveFrom.slice(0, 4))]);
    await lockScopeRows(tx, input.orgId, [{ kind: 'party', id: input.employeePartyId }], input.allowedSubsidiaryIds, 'share');
    await lockScopeRows(tx, input.orgId, [{ kind: 'party', id: input.employeePartyId }], authority, 'share');
    if (input.effectiveTo >= await businessTodayInTx(tx, input.orgId)) throw new PayrollError('Historical inputs must end before today; edit the payroll profile for current or future withholding.');
    const profile = (await tx.execute<Record<string, unknown>>(sql`select * from employee_payroll_profiles
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} for update`)).rows[0];
    if (!profile || profile.country !== input.country) throw new PayrollError('Select this employee’s own payroll country and saved profile before importing historical withholding.');
    const region = certificate.scope.region ?? null;
    const subRegion = certificate.scope.subRegion ?? null;
    if (region !== null && profile.province !== region) throw new PayrollError('Use the withholding form declared for the employee’s own region.');
    const current = resolveCertificate({ certificate, profile }).answers;
    for (const key of fields) {
      const expected = input.expectedCurrent[key];
      const field = certificate.fields.find(field => field.key === key)!;
      const reviewed = expected === undefined ? undefined : expected === '' ? null
        : field.kind === 'amount' && field.decimals != null ? normalizeDecimal(expected, field.decimals) : expected;
      if (reviewed === undefined || reviewed !== current[key]) {
        throw new PayrollError(`The current ${field.label} differs from the reviewed value — export the profile and preview the historical input again.`);
      }
    }
    const endExclusive = addCalendarDays(input.effectiveTo, 1);
    const overlap = (await tx.execute<{ id: string; effective_from: string; superseded_on: string; answers: Record<string, string> }>(sql`
      select id, effective_from::text, superseded_on::text, answers from employee_tax_certificates
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} and country=${input.country}
        and certificate_key=${certificate.key} and region is not distinct from ${region}
        and sub_region is not distinct from ${subRegion}
        and (effective_from is null or effective_from<=${input.effectiveTo}::date)
        and (superseded_on is null or superseded_on>${input.effectiveFrom}::date) for update`)).rows;
    if (overlap.length) {
      const same = overlap.length === 1 && overlap[0]!.effective_from === input.effectiveFrom &&
        overlap[0]!.superseded_on === endExclusive && JSON.stringify(Object.entries(overlap[0]!.answers).sort()) === JSON.stringify(Object.entries(answers).sort());
      if (same && (await tx.execute(sql`select id from audit_log where org_id=${input.orgId}
        and table_name='employee_tax_certificates' and row_id=${overlap[0]!.id}
        and changes->>'kind'='historical_withholding_input' limit 1`)).rows.length === 1) {
        return { changed: false, id: overlap[0]!.id };
      }
      throw new PayrollError('A withholding record already covers these dates — review its history; this import never overwrites overlapping evidence.');
    }
    const posted = (await tx.execute<{ pay_date: string }>(sql`select r.pay_date::text from pay_runs r
      join pay_stubs s on s.org_id=r.org_id and s.pay_run_document_id=r.document_id
      join documents d on d.org_id=r.org_id and d.id=r.document_id
      where r.org_id=${input.orgId} and s.employee_party_id=${input.employeePartyId}
        and r.run_status='committed' and d.status<>'voided'
        and r.pay_date between ${input.effectiveFrom}::date and ${input.effectiveTo}::date limit 1`)).rows[0];
    if (posted) throw new PayrollError(`Payroll dated ${posted.pay_date} is committed — preserve its withholding evidence and use a controlled correction run.`);
    if (input.dryRun) return { changed: true, id: null };
    const saved = (await tx.execute<{ id: string }>(sql`insert into employee_tax_certificates
      (org_id,employee_party_id,country,certificate_key,region,sub_region,answers,effective_from,superseded_on,created_by,updated_by)
      values (${input.orgId},${input.employeePartyId},${input.country},${certificate.key},${region},${subRegion},
        ${JSON.stringify(answers)}::jsonb,${input.effectiveFrom}::date,${endExclusive}::date,${input.actorId},${input.actorId}) returning id`)).rows[0];
    if (!saved) throw new PayrollError('The historical withholding input was not saved — reload the employee and preview again.');
    await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values (${input.orgId},'employee_tax_certificates',${saved.id},'insert',
        ${JSON.stringify({ before: null, after: { country: input.country, certificateKey: certificate.key, answers,
          effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo }, kind: 'historical_withholding_input',
          currentProfileAnswers: Object.fromEntries(fields.map(key => [key, current[key]])), reason })}::jsonb,${input.actorId})`);
    return { changed: true, id: saved.id };
  };
  return executor ? inExecutorTransaction(executor, apply) : withOrgTransaction(input.orgId, () => apply(db));
}

/** Apply only recorded, in-force answers to their existing profile columns. */
export function historicalWithholdingProfile(input: {
  country: string; profile: Record<string, string | null>; stored: readonly StoredCertificate[]; payDate: string;
}): Record<string, string | null> {
  const profile = { ...input.profile };
  for (const certificate of packCertificates(input.country).certificates) {
    if (certificate.storage !== 'profile_columns') continue;
    const resolved = resolveCertificate({ certificate, stored: input.stored, profile: input.profile, asOf: input.payDate });
    if (!resolved.storedAnswers) continue;
    for (const field of certificate.fields) {
      if (field.storage?.kind === 'column' && resolved.storedAnswers[field.key] !== undefined) {
        profile[field.storage.column] = resolved.storedAnswers[field.key]!;
      }
    }
  }
  return profile;
}
