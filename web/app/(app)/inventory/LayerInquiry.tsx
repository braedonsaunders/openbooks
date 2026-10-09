"use client";
import { useTranslations } from "next-intl";
import { AsyncUrlDrawer } from "@/components/async-url-drawer";
import { StockControls } from "./StockControls";
export function LayerInquiry({
  itemId,
  stockLocationId,
}: {
  itemId: string;
  stockLocationId?: string;
}) {
  const t = useTranslations("inventory.controls");
  return (
    <AsyncUrlDrawer
      open
      openKey={itemId}
      closeHref="/inventory"
      title={t("layers")}
      pending={false}
      size="xl"
    >
      <StockControls
        key={itemId}
        view="layers"
        itemId={itemId}
        stockLocationId={stockLocationId}
      />
    </AsyncUrlDrawer>
  );
}
