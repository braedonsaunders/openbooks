"use client";

import { useTranslations } from "next-intl";
import { useMoney } from "./money-provider";

export type AppliedPayment = {
  id: string;
  number: string;
  kind: string;
  date: string | null;
  amount: string;
  appliedOn: string | null;
};

/** Active open-item applications into this document (receipts, credits). */
export function AppliedPaymentsPanel({ payments, currency }: { payments: AppliedPayment[]; currency: string }) {
  const t = useTranslations("ar.appliedPayments");
  const { money } = useMoney();
  if (payments.length === 0) return null;
  return (
    <section className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {t("title")}
      </h3>
      <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <th className="px-3 py-2 font-medium">{t("document")}</th>
              <th className="px-3 py-2 font-medium">{t("date")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("amount")}</th>
              <th className="px-3 py-2 text-right font-medium">{t("appliedOn")}</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((payment) => (
              <tr key={payment.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                <td className="px-3 py-2 font-medium tabular-nums">{payment.number}</td>
                <td className="px-3 py-2 text-slate-500 tabular-nums dark:text-slate-400">{payment.date ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(payment.amount, { currency })}</td>
                <td className="px-3 py-2 text-right text-slate-500 tabular-nums dark:text-slate-400">{payment.appliedOn ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
