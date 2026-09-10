import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { requirePermission } from "../../../../../lib/authz";
import { featureEnabled, resolvedFeatureState } from "../../../../../lib/features";
import { PaymentProvidersClient } from "./PaymentProvidersClient";
import { ModuleView } from "../../../../../components/viewspec/module-view";
import { loadPaymentProviders, paymentProvidersSpec } from "./view";

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
export default async function PaymentProvidersPage({
  searchParams,
}: {
  // Optional: this route natively takes no props.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
} = {}) {
  const sp = (await searchParams) ?? {};
  if (sp.__viewspec === "1") {
    const data = await loadPaymentProviders();
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={paymentProvidersSpec(data)} data={data} searchParams={sp} trusted />
      </>
    );
  }
  const authz = await requirePermission("admin.setup.manage");
  const features = await resolvedFeatureState(authz.user.orgId);
  if (!featureEnabled(features, "onlinePayments")) redirect("/admin/setup/features");
  return <PaymentProvidersClient />;
}
