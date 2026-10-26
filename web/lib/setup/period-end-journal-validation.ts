import "server-only";
import { periodEndPolicyWriteRefusal } from "@openbooks/engine/close/period-end-journals";
import type { SetupEntityValidationHook } from "./types";

/**
 * Period-end journal policy versions: the engine owns the rules (equity
 * accounts, method and account pairing, no reach-back into a year closed by
 * journal); the hook adapts its refusal to the Setup write contract.
 */
export const validatePeriodEndPolicyWrite: SetupEntityValidationHook = async ({
  orgId,
  body,
  executor,
}) => periodEndPolicyWriteRefusal(executor, orgId, body);
