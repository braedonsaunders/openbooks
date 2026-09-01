import { notFound } from "next/navigation";
import { publicPaymentPage } from "@openbooks/engine/src/payment-acceptance.ts";
import { createMoneyFormatter } from "@/lib/money-format";
import { decimalCmp } from "@/lib/statement-format";
import { PayButton } from "./PayButton";

export const dynamic = "force-dynamic";

function format(amount: string, currency: string): string {
  return createMoneyFormatter("en", currency).money(amount);
}

/**
 * Hosted payment page for an invoice payment link. Token-authenticated (the
 * 192-bit random token in the URL is the credential); no session required.
 */
export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await publicPaymentPage(token);
  if (!view) notFound();

  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-b from-white to-slate-100 p-4 dark:from-slate-950 dark:to-slate-900">
      <div className="w-full max-w-md rounded-3xl border border-slate-200/80 bg-white p-8 shadow-xl shadow-slate-900/5 dark:border-slate-800 dark:bg-slate-900 dark:shadow-black/30">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
            {view.orgName}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Invoice {view.documentNumber} · {view.partyName}
          </p>
        </div>

        {view.status === "paid" ? (
          <div className="rounded-xl bg-teal-50 p-4 text-center text-sm font-medium text-teal-800 dark:bg-teal-950/40 dark:text-teal-300">
            This invoice has been paid. Thank you.
          </div>
        ) : (
          <>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500 dark:text-slate-400">Invoice amount</dt>
                <dd className="tabular-nums text-slate-900 dark:text-white">{format(view.invoiceAmount, view.currency)}</dd>
              </div>
              {decimalCmp(view.surchargeAmount, "0") > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-slate-500 dark:text-slate-400">Processing fee</dt>
                  <dd className="tabular-nums text-slate-900 dark:text-white">{format(view.surchargeAmount, view.currency)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold dark:border-slate-700">
                <dt className="text-slate-900 dark:text-white">Total due</dt>
                <dd className="tabular-nums text-slate-900 dark:text-white">{format(view.totalAmount, view.currency)}</dd>
              </div>
            </dl>
            <PayButton token={token} provider={view.provider} />
            <p className="mt-4 text-center text-xs text-slate-400 dark:text-slate-500">
              Secure checkout via {view.provider === "gocardless" ? "GoCardless" : view.provider === "adyen" ? "Adyen" : "Stripe"}.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
