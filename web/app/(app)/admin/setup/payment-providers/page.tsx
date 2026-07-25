import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { requirePermission } from "../../../../../lib/authz";
import { featureEnabled, resolvedFeatureState } from "../../../../../lib/features";
import { PaymentProvidersClient } from "./PaymentProvidersClient";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("admin.setup.paymentProviders");
  return { title: t("title") };
}

/**
 * Company Settings → Payment Providers. Customer payment acceptance: hosted
 * checkout providers (Stripe / Adyen / GoCardless bank debit), their receipt
 * bank accounts, and the effective-dated surcharge rules applied at checkout.
 * Settlement/payout reconciliation stays under Banking → PSP settlements.
 */
export default async function PaymentProvidersPage() {
  const authz = await requirePermission("admin.setup.manage");
  const features = await resolvedFeatureState(authz.user.orgId);
  if (!featureEnabled(features, "onlinePayments")) redirect("/admin/setup/features");
  return <PaymentProvidersClient />;
}
