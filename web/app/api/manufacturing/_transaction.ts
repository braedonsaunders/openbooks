import { withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";

export function manufacturingTransaction<T>(orgId: string, work: () => Promise<T>): Promise<T> {
  return withOrgTransaction(orgId, work);
}
