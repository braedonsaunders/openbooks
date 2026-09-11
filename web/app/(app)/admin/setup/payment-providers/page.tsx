import { getTranslations } from "next-intl/server"
import { ModuleView } from "../../../../../components/viewspec/module-view"
import { loadPaymentProviders, paymentProvidersSpec } from "./view"

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
  const data = await loadPaymentProviders();
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={paymentProvidersSpec(data)} data={data} searchParams={sp} trusted />
    </>
  );
}
