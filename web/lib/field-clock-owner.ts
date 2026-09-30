import { createHash } from "node:crypto";

/** A session fence, not authorization: the server still resolves the employee. */
export function fieldClockOwnerKey(
  orgId: string,
  userId: string,
  employeePartyId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([orgId, userId, employeePartyId]))
    .digest("hex");
}
