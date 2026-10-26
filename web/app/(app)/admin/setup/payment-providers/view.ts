import "server-only";

import { page, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { requirePermission } from "../../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../../lib/feature-gates";
import { withOrgTransaction } from "@openbooks/engine/platform/db";
import { readPaymentProviderSetupData } from "../../../../../lib/setup/payment-providers-data";
import type { PaymentProviderSetupData } from "../../../../../lib/setup/payment-providers-types";

/**
 * Company Settings → Payment Providers, split into a loader and a spec.
 *
 * Provider configuration and account choices are loaded in the organization
 * context and passed to the workspace. Mutations continue through the native
 * authorized API routes.
 *
 * Both gates run here, so a spec render redirects exactly as the native one
 * does. A gate that only guarded the native path would be a hole, not a
 * difference in rendering.
 */

export interface PaymentProvidersData extends PaymentProviderSetupData {
  view: "checkout" | "settlement" | "surcharge" | "processor_receipts";
}

export async function loadPaymentProviders(
  sp?: Record<string, string | string[] | undefined>,
): Promise<PaymentProvidersData> {
  const authz = await requirePermission("admin.setup.manage");
  await requireFeatureEnabled(
    authz.user.orgId,
    sp?.view === "processor_receipts" ? "banking" : "onlinePayments",
  );
  const view =
    sp?.view === "settlement" || sp?.view === "surcharge" || sp?.view === "processor_receipts"
      ? sp.view
      : "checkout";
  const data = await withOrgTransaction(authz.user.orgId, () =>
    readPaymentProviderSetupData(authz),
  );
  return { ...data, view };
}

export function paymentProvidersSpec(data: PaymentProvidersData): PageSpec {
  return page({
    route: "/admin/setup/payment-providers",
    // The setup workspace renders its own shell around every setup page, so a
    // page layout here would nest the chrome — and the island owns whatever
    // container it wants inside that.
    layout: "bare",
    header: [],
    body: [
      widgetBlock("payment-providers-workspace", {
        initialData: data,
      }),
    ],
  });
}
