"use client";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { EmptyState } from "@openbooks/ui";
import { PagedTable } from "@/components/paged-table";
import { formatDecimal } from "@/lib/money-format";
import type { GenealogyEdge } from "@openbooks/engine/manufacturing/genealogy";

export function GenealogyTable({ edges }: { edges: GenealogyEdge[] }) {
  const t = useTranslations("manufacturing.genealogy"), locale = useLocale();
  const trace = (kind: "lot" | "serial", id: string, label: string, direction: "forward" | "backward") => <Link className="text-teal-700 hover:underline" href={("/manufacturing/genealogy?kind="+kind+"&id="+id+"&direction="+direction) as never}>{label}</Link>;
  return <PagedTable source="manufacturing_genealogy" rows={edges} rowKey={row=>row.id} searchable empty={<EmptyState title={t("empty")} description={t("emptyNote")} />} columns={[
    { key:"allocationBasis",header:t("evidence"),cell:row=>t("basis."+row.allocationBasis) },
    { key:"depth",header:t("depth"),cell:row=>row.depth },
    { key:"orderNumber",header:t("order"),cell:row=><Link className="text-teal-700 hover:underline" href={("/manufacturing/work-orders?record="+row.orderId) as never}>{row.orderNumber}</Link> },
    { key:"componentItem",header:t("component"),cell:row=><div>{row.componentItem}<div className="text-xs">{row.componentLotId ? trace("lot",row.componentLotId,row.componentLotNumber??"—","backward") : null} {row.componentSerialId ? trace("serial",row.componentSerialId,row.componentSerialNumber??"—","backward") : null}</div></div> },
    { key:"componentQuantity",header:t("issued"),cell:row=>formatDecimal(locale,row.componentQuantity,{maximumFractionDigits:4}) },
    { key:"outputItem",header:t("output"),cell:row=><div>{row.outputItem}<div className="text-xs">{row.outputLotId ? trace("lot",row.outputLotId,row.outputLotNumber??"—","forward") : null} {row.outputSerialId ? trace("serial",row.outputSerialId,row.outputSerialNumber??"—","forward") : null}</div></div> },
    { key:"outputQuantity",header:t("received"),cell:row=>formatDecimal(locale,row.outputQuantity,{maximumFractionDigits:4}) },
  ]} />;
}
