import "server-only";

import { notFound } from "next/navigation";
import { page, ref, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { db } from "@openbooks/engine/platform/db";
import { isUuid } from "@openbooks/engine/platform/identifiers";
import { listUsableRegisters } from "@openbooks/engine/pos";
import { can, requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";

/**
 * The selling surface for one register. It covers the viewport so the cart,
 * keypad and tenders get the whole screen, and keeps an Exit back to the
 * picker. What the cashier may do beyond selling — refunds, price and
 * discount overrides, drawer handling — comes from the operator's own
 * permissions here, and every register API re-checks the same permission.
 */
export interface PosRegisterData {
  registerId: string;
  canRefund: boolean;
  canOverride: boolean;
  canManageDrawer: boolean;
  canViewSessions: boolean;
}

export async function loadPosRegister(registerId: string): Promise<PosRegisterData> {
  const authz = await requirePermission("pos.sell");
  await requireFeatureEnabled(authz.user.orgId, "posRegister");
  if (!isUuid(registerId)) notFound();
  // A register outside the operator's legal entities, inactive or unknown
  // answers not found, exactly like the register API.
  const usable = await listUsableRegisters(
    db,
    authz.user.orgId,
    authz.allowedSubsidiaryIds ?? null,
  );
  if (!usable.some((register) => register.id === registerId)) notFound();
  return {
    registerId,
    canRefund: can(authz, "pos.refund"),
    canOverride: can(authz, "pos.override"),
    canManageDrawer: can(authz, "pos.drawer"),
    canViewSessions: can(authz, "pos.drawer"),
  };
}

const f = ref<PosRegisterData>();

export function posRegisterSpec(_data: PosRegisterData): PageSpec {
  return page({
    route: "/pos/[registerId]",
    layout: "bare",
    header: [],
    body: [
      widgetBlock("pos-register-screen", {
        registerId: f("registerId"),
        canRefund: f("canRefund"),
        canOverride: f("canOverride"),
        canManageDrawer: f("canManageDrawer"),
        canViewSessions: f("canViewSessions"),
      }),
    ],
  });
}
