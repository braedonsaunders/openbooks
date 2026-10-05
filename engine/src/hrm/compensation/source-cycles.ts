import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db, withOrgTransaction } from '../../platform/db.ts';
import { requireAggregateCompensationRead, requireCompensationManageForEmployer } from '../authorization.ts';
import { requireActorId, requireCivilDate, requireId, requireOrgId, requireReason } from '../recruiting/input.ts';
import { canonicalDecimal } from '../../money/exact-decimal.ts';
import { CompensationError } from './errors.ts';
import { getCycle, type CompCycleDTO } from './cycles.ts';
import { organizationCurrencyAvailable } from '../../organization/currency-options.ts';
import { lockAndCheckOrgFeature, orgFeatureEnabled } from '../../organization/org-feature-lock.ts';

export interface SourceCompensationRow {
  id: string;
  sourceRow: number;
  employeeKey: string;
  employeeName: string;
  division: string | null;
  jobTitle: string | null;
  sourceStatus: string | null;
  currentRate: string | null;
  proposedRate: string | null;
  notes: string | null;
}
export interface CompensationCycleEvidence {
  version: 1;
  sourcePath: string;
  sha256: string;
  sheet: string;
  recordedOn: string | null;
  effectiveDateEvidence: string | null;
  currency: string;
  basis: 'hour' | 'year';
  rows: SourceCompensationRow[];
  cells: { cell: string; value: unknown; cached: unknown; format: string }[];
}

function validateEvidence(evidence: CompensationCycleEvidence): void {
  if (!evidence || evidence.version !== 1 || !/^[a-f0-9]{64}$/.test(evidence.sha256)
    || !evidence.sourcePath?.trim() || !evidence.sheet?.trim()
    || !/^[A-Z]{3}$/.test(evidence.currency) || !['hour', 'year'].includes(evidence.basis)
    || !Array.isArray(evidence.rows) || evidence.rows.length === 0 || evidence.rows.length > 1000
    || !Array.isArray(evidence.cells) || evidence.cells.length > 30000
    || Buffer.byteLength(JSON.stringify(evidence), 'utf8') > 4 * 1024 * 1024) {
    throw new CompensationError('INVALID_INPUT', 'Supply a bounded source workbook snapshot with its hash, sheet, currency and employee rows');
  }
  if (evidence.recordedOn !== null) requireCivilDate(evidence.recordedOn, 'source recorded date');
  const keys = new Set<string>();
  for (const row of evidence.rows) {
    if (!row.id || keys.has(row.id) || !row.employeeKey?.trim() || !row.employeeName?.trim()
      || !Number.isSafeInteger(row.sourceRow) || row.sourceRow < 1) {
      throw new CompensationError('INVALID_INPUT', 'Every source employee row needs a unique source identity, original row number and name');
    }
    keys.add(row.id);
    for (const rate of [row.currentRate, row.proposedRate]) {
      if (rate !== null && canonicalDecimal(rate, 4) === null) {
        throw new CompensationError('INVALID_INPUT', 'Source wage values must be exact decimals with at most four places; retain unreadable source cells and correct the extraction before importing');
      }
    }
  }
}

/** Adopt immutable review evidence without opening, approving or pushing native payroll. */
export async function adoptSourceCompensationCycle(query: {
  orgId: string; actorId: string; name: string; effectiveOn: string | null;
  evidence: CompensationCycleEvidence; reason: string;
}): Promise<CompCycleDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const reason = requireReason(query.reason);
  validateEvidence(query.evidence);
  if (!query.name?.trim() || query.name.length > 160) throw new CompensationError('INVALID_INPUT', 'A source review name of at most 160 characters is required');
  if (query.effectiveOn !== null) {
    requireCivilDate(query.effectiveOn, 'source effective date');
    if (!query.evidence.effectiveDateEvidence?.trim()) throw new CompensationError('INVALID_INPUT', 'Name the source evidence establishing the effective date');
  }
  const sourceKey = createHash('sha256').update(`${query.evidence.sha256}:${query.evidence.sheet}`).digest('hex');
  return withOrgTransaction(orgId, async () => {
    await requireCompensationManageForEmployer(db, orgId, actorId, null, 'Historical compensation source');
    if (!await lockAndCheckOrgFeature(db, orgId, 'hrmCompensation')) throw new CompensationError('REFUSED', 'Enable Compensation in Company Settings → Features before importing source reviews');
    await lockAndCheckOrgFeature(db, orgId, 'multiCurrency');
    if (!await organizationCurrencyAvailable(db, orgId, query.evidence.currency, null)) {
      throw new CompensationError('REFUSED', 'Enable the source currency in Company Settings before importing the compensation review');
    }
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:compensation-source:${sourceKey}`}, 0))`);
    const existing = (await db.execute<{ id: string; name: string; effective_on: string | null; source_evidence: CompensationCycleEvidence }>(sql`
      select id, name, effective_on::text, source_evidence from hrm_comp_cycles where org_id = ${orgId} and source_key = ${sourceKey}`)).rows[0];
    if (existing) {
      const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
      if (existing.name !== query.name.trim() || existing.effective_on !== query.effectiveOn || canonical(existing.source_evidence) !== canonical(query.evidence)) {
        throw new CompensationError('REFUSED', 'This source workbook version is already imported with different evidence; import a new source version to preserve the original record');
      }
      return getCycle({ orgId, actorId, cycleId: existing.id });
    }
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into hrm_comp_cycles (org_id, name, kind, status, effective_on, currency, guideline_kind,
        guideline, scope, source_key, source_evidence, created_by, updated_by)
      values (${orgId}, ${query.name.trim()}, 'adjustment', 'historical', ${query.effectiveOn}, ${query.evidence.currency},
        'matrix', '{}'::jsonb, '{}'::jsonb, ${sourceKey}, ${JSON.stringify(query.evidence)}::jsonb, ${actorId}, ${actorId}) returning id`)).rows[0];
    if (!inserted) throw new CompensationError('REFUSED', 'The historical compensation source was not saved; retry the import');
    await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, actor_id, changes)
      values (${orgId}, 'hrm_comp_cycles', ${inserted.id}, 'insert', ${actorId},
        ${JSON.stringify({ before: null, after: { name: query.name.trim(), status: 'historical', effectiveOn: query.effectiveOn, sourceKey, evidence: query.evidence }, reason })}::jsonb)`);
    return getCycle({ orgId, actorId, cycleId: inserted.id });
  });
}

export async function sourceCompensationCycleEvidence(query: { orgId: string; actorId: string; cycleId: string }): Promise<CompensationCycleEvidence> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const cycleId = requireId(query.cycleId, 'cycleId');
  if (!await orgFeatureEnabled(orgId, 'hrmCompensation', db)) throw new CompensationError('REFUSED', 'Enable Compensation in Company Settings → Features to read source reviews');
  const allowed = await requireAggregateCompensationRead(db, orgId, actorId);
  // Original source identities are not mapped to native employer assignments.
  if (allowed !== null) throw new CompensationError('REFUSED', 'Organization-wide compensation access is required to read historical source employee rows; ask your administrator for an unrestricted compensation reader role');
  const row = (await db.execute<{ source_evidence: CompensationCycleEvidence }>(sql`
    select source_evidence from hrm_comp_cycles where org_id = ${orgId} and id = ${cycleId} and status = 'historical'`)).rows[0];
  if (!row) throw new CompensationError('NOT_FOUND', 'Historical compensation source is not visible in this organization');
  validateEvidence(row.source_evidence);
  return row.source_evidence;
}
