import { withOrgTransaction } from "@openbooks/engine/platform/database";

export function planningTransaction<T>(orgId: string, work: () => Promise<T>): Promise<T> {
  return withOrgTransaction(orgId, work);
}
