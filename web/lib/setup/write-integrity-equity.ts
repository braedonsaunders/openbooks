import "server-only";
import type { SqlExecutor } from "@openbooks/engine/platform/db";
import { equityAccountPolicyRefusal } from "@openbooks/engine/equity";
import { readerRefusal } from "../reader-refusal";
import { joinRefusal } from "../refusal-sentence";
import type { SetupEntity } from "./registry";
import { INTEGRITY_CONTINUES, type SetupIntegrityVerdict } from "./write-shared";

/**
 * Equity account policy versions are validated by the equity engine, the
 * same rule the posting path relies on: account kinds per role, active
 * posting accounts, and an effective date after the legal entity's latest
 * equity posting so posted history keeps its accounts. The refusal reads in
 * the operator's language.
 */
export async function validateEquityIntegrity(
  entity: SetupEntity,
  body: Record<string, unknown>,
  orgId: string,
  _rowId: string | undefined,
  executor: SqlExecutor,
): Promise<SetupIntegrityVerdict> {
  if (entity.key !== "equity-account-policies") return INTEGRITY_CONTINUES;
  const refusal = await equityAccountPolicyRefusal(executor, orgId, body);
  if (!refusal) return INTEGRITY_CONTINUES;
  const reader = await readerRefusal(refusal);
  return joinRefusal(reader.message, reader.remedy);
}
