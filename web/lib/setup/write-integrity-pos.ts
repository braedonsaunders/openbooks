import "server-only";
import type { SqlExecutor } from "@openbooks/engine/platform/db";
import { cashReasonSetupRefusal, registerSetupRefusal } from "@openbooks/engine/pos";
import type { SetupEntity } from "./registry";
import { INTEGRITY_CONTINUES, type SetupIntegrityVerdict } from "./write-shared";

/**
 * Register and drawer-reason writes are validated by the point-of-sale
 * engine, the same rules the register re-checks when it uses them: tenders
 * settle only into bank or clearing accounts, the walk-in customer is an
 * active customer, and a cash reason never posts to a control account.
 */
export async function validatePosIntegrity(
  entity: SetupEntity,
  body: Record<string, unknown>,
  orgId: string,
  rowId: string | undefined,
  executor: SqlExecutor,
): Promise<SetupIntegrityVerdict> {
  if (entity.key === "pos-registers")
    return (await registerSetupRefusal(executor, orgId, body, rowId)) ?? INTEGRITY_CONTINUES;
  if (entity.key === "pos-cash-reasons")
    return (await cashReasonSetupRefusal(executor, orgId, body, rowId)) ?? INTEGRITY_CONTINUES;
  return INTEGRITY_CONTINUES;
}
