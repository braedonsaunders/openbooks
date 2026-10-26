"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { UrlDrawer } from "@openbooks/ui";

export interface ReceivablePurchaseOrder {
  id: string;
  number: string | null;
  vendor: string | null;
  openLines: number;
}

/**
 * Standalone goods-receipt entry from the inventory ledger. Lists approved
 * purchase orders that still have quantities to receive; choosing one opens
 * the order's drawer with the receipt form already raised, so the receipt
 * posts through the native receive path instead of a blind full-quantity
 * movement. Nothing posts from this list itself.
 */
export function ReceiveAgainstPoDrawer({
  orders,
  closeHref,
}: {
  orders: ReceivablePurchaseOrder[];
  closeHref: string;
}) {
  const t = useTranslations("inventory");
  return (
    <UrlDrawer open closeHref={closeHref} title={t("receive.title")}>
      {orders.length === 0 ? (
        <p className="px-1 py-6 text-sm text-muted-foreground">{t("receive.empty")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                href={`/purchase-orders?order=${order.id}&receive=1`}
                className="flex items-baseline justify-between gap-3 px-1 py-3 hover:bg-muted/50"
              >
                <span className="font-medium">
                  {order.number ?? order.id}
                  {order.vendor ? (
                    <span className="ml-2 font-normal text-muted-foreground">{order.vendor}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-sm text-muted-foreground">
                  {t("receive.openLines", { count: order.openLines })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </UrlDrawer>
  );
}
