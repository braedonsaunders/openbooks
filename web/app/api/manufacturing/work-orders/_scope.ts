import { getWorkOrder } from "@openbooks/engine/manufacturing/work-orders";
import { db } from "@openbooks/engine/platform/db";
import { guardSubsidiaryScope, type Authz } from "@/lib/authz";
import { notFound } from "@/lib/api/responses";

export async function loadScopedWorkOrder(authz: Authz, id: string, lock = false) {
  const order = await getWorkOrder(db, authz.user.orgId, id, lock);
  if (!order) return { ok: false as const, response: notFound("work order") };
  const denied = guardSubsidiaryScope(authz, order.subsidiaryId);
  return denied ? { ok: false as const, response: denied } : { ok: true as const, order };
}
