import 'server-only'
import type { SqlExecutor } from '@openbooks/engine/platform/db'
import { equityAccountPolicyRefusal } from '@openbooks/engine/equity'
import type { SetupEntity } from './registry'
import { INTEGRITY_CONTINUES, type SetupIntegrityVerdict } from './write-shared'

/**
 * Equity account policy versions are validated by the equity engine, the
 * same rule the posting path relies on: account kinds per role, active
 * posting accounts, and an effective date after the legal entity's latest
 * equity posting so posted history keeps its accounts.
 */
export async function validateEquityIntegrity(
  entity: SetupEntity,
  body: Record<string, unknown>,
  orgId: string,
  _rowId: string | undefined,
  executor: SqlExecutor,
): Promise<SetupIntegrityVerdict> {
  if (entity.key === 'equity-account-policies') return (await equityAccountPolicyRefusal(executor, orgId, body)) ?? INTEGRITY_CONTINUES
  return INTEGRITY_CONTINUES
}
