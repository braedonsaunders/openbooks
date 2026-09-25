import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts'
import type { SqlExecutor } from '../platform/db.ts'
import { PayrollError } from './error.ts'

/** Serialize payroll setup writes with disabling Payroll and verify the flag
 * on the same transaction before a service mutates carry-in history. */
export async function requirePayrollFeature(executor: SqlExecutor, orgId: string): Promise<void> {
  await acquireOrgFeatureGateLock(executor, orgId)
  if (!(await lockAndCheckOrgFeature(executor, orgId, 'payroll'))) {
    throw new PayrollError('Payroll feature is disabled')
  }
}
