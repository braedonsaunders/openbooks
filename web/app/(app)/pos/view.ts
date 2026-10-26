import "server-only";

import { getTranslations } from "next-intl/server";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { db } from "@openbooks/engine/platform/db";
import { listUsableRegisters } from "@openbooks/engine/pos";
import type { RegisterPickerEntry } from "../../../components/pos/register-picker";
import { can, requirePermission } from "../../../lib/authz";
import { requireFeatureEnabled } from "../../../lib/feature-gates";

/**
 * Register picker: the active registers in the operator's legal entities,
 * each showing whether its drawer is open. Selling, drawer history and
 * register setup are separate permissions, so each action appears only to
 * operators who hold it; the register APIs enforce the same gates.
 */
export interface PosRegistersData {
  title: string;
  description: string;
  sessionsLabel: string;
  configureLabel: string;
  canManage: boolean;
  canViewSessions: boolean;
  registers: RegisterPickerEntry[];
}

export async function loadPosRegisters(): Promise<PosRegistersData> {
  const authz = await requirePermission("pos.sell");
  await requireFeatureEnabled(authz.user.orgId, "posRegister");
  const [t, registers] = await Promise.all([
    getTranslations("pos"),
    listUsableRegisters(db, authz.user.orgId, authz.allowedSubsidiaryIds ?? null),
  ]);
  return {
    title: t("picker.title"),
    description: t("picker.description"),
    sessionsLabel: t("session.history"),
    configureLabel: t("picker.configure"),
    canManage: can(authz, "pos.manage"),
    canViewSessions: can(authz, "pos.drawer"),
    registers: registers.map((register) => ({
      id: register.id,
      code: register.code,
      name: register.name,
      openSessionId: register.openSessionId,
      openedBy: register.openedBy,
    })),
  };
}

const f = ref<PosRegistersData>();

export function posRegistersSpec(data: PosRegistersData): PageSpec {
  return page({
    route: "/pos",
    layout: "list",
    header: [
      pageHeader({
        title: data.title,
        description: data.description,
        actionsClassName: "flex flex-wrap items-center justify-end gap-2",
        actions: [
          widget(
            "link-button",
            { href: "/pos/sessions", label: data.sessionsLabel, variant: "outline" },
            f("canViewSessions"),
          ),
          widget(
            "link-button",
            { href: "/admin/setup/pos-registers", label: data.configureLabel, variant: "outline" },
            f("canManage"),
          ),
        ],
      }),
    ],
    body: [
      widgetBlock("pos-register-picker", { registers: f("registers"), canManage: f("canManage") }),
    ],
  });
}
