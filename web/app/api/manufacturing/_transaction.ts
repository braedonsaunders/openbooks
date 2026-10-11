import { withOrgTransaction } from "@openbooks/engine/platform/db";

export function manufacturingTransaction<T>(orgId: string, work: () => Promise<T>): Promise<T> {
  return withOrgTransaction(orgId, work);
}
