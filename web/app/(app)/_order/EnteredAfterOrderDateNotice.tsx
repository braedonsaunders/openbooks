"use client";

import { useTranslations } from "next-intl";
import { Alert, AlertDescription } from "@openbooks/ui";

/**
 * Informational notice that a purchase order was entered well after its order
 * date. The loader decides whether the gap is notable (see
 * `enteredAfterOrderDays`); this renders the days it reports and nothing else,
 * and it blocks nothing.
 */
export function EnteredAfterOrderDateNotice({ days }: { days: number | null | undefined }) {
  const t = useTranslations("purchaseOrders.shared");
  if (days === null || days === undefined) return null;
  return (
    <Alert>
      <AlertDescription>{t("enteredAfterOrderDate", { days })}</AlertDescription>
    </Alert>
  );
}
