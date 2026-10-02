import { type SQL } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { HrmProcessError, openProcess } from '../hrm/processes.ts';

type ChecklistSubject = { org: { orgId: string }; managerId: string; employmentId: string };
export const checklistActor = (h: ChecklistSubject) => ({ orgId: h.org.orgId, actorId: h.managerId });
export function openChecklist(h: ChecklistSubject, overrides: Partial<Parameters<typeof openProcess>[0]> = {}) {
  return openProcess({ ...checklistActor(h), employmentId: h.employmentId, kind: 'onboarding', effectiveDate: '2026-09-01', ...overrides });
}
/** Preserve both the refusal classification and the operator's remedy. */
export function checklistRefusal(code: HrmProcessError['code'], message?: RegExp) {
  return (error: unknown) => error instanceof HrmProcessError && error.code === code && (!message || message.test(error.message));
}
export async function checklistRow<T extends Record<string, unknown>>(query: SQL) {
  return (await db.execute<T>(query)).rows[0];
}

export async function setupChecklistHarness(withApprover = false) {
  const { setupHarness, mkParty, mkEmployment, mkVersion } = await import('./hrm-harness.ts');
  const users = [
    { key: 'managerId' as const, name: withApprover ? 'Checklist manager' : 'HRM Process Manager', handle: 'checklist_manager', permissions: ['hrm.process.read', 'hrm.process.manage', 'hrm.employment.manage'], link: true },
    ...(withApprover ? [{ key: 'approverId' as const, name: 'Checklist approver', handle: 'checklist_approver', permissions: ['hrm.process.read', 'hrm.process.manage'], link: true }] : []),
  ];
  return setupHarness({ users }, async base => {
    const worker = await mkParty(base.org.orgId, withApprover ? 'New colleague' : 'Process Worker');
    const employmentId = await mkEmployment(base.org.orgId, worker, base.org.subsidiaryId);
    await mkVersion(base.org.orgId, employmentId, { from: '2020-01-01' });
    return { worker, workerPartyId: worker, employmentId };
  });
}
