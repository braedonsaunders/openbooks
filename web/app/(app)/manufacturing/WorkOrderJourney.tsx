"use client";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { Badge, Button } from "@openbooks/ui";
import { Check, Circle, Package, Play, ShieldCheck } from "lucide-react";
import { RecordKindCard } from "@/components/record-kind-cards";
import { formatDecimal } from "@/lib/money-format";
import type { ManufacturingRecordData, ManufacturingRow } from "@openbooks/engine/src/manufacturing/workspace.ts";
import { productionJourney } from "@openbooks/engine/src/manufacturing/journey.ts";
import type { Command } from "./commands";

export function WorkOrderJourney({ data, next, onCommand, onOpen, busy,canReadQuality=false }: {
  data: ManufacturingRecordData; next: Command | null; onCommand: (command: Command)=>void;
  onOpen: (tab: string, row?: ManufacturingRow)=>void; busy: boolean;canReadQuality?:boolean;
}) {
  const t=useTranslations("manufacturing"),locale=useLocale(),r=data.record;
  const operations=data.sections.operations??[],materials=data.sections.materials??[];
  const active=operations.find(operation=>operation.status!=="done");
  const definition=r.operatingProfile as {terminology?:{singular:string};capture?:string}|null;
  const label=(value:unknown)=>t.has("values."+value)?t("values."+value):String(value??"—");
  const quantity=(value:unknown)=>formatDecimal(locale,String(value??"0"),{maximumFractionDigits:4});
  const progress=productionJourney({status:String(r.status),routingVersion:r.routingVersion===null?null:Number(r.routingVersion),quantityOrdered:String(r.quantityOrdered),quantityCompleted:String(r.quantityCompleted),quantityScrapped:String(r.quantityScrapped),operations:operations.map(o=>({status:String(o.status)}))});
  const steps=[{key:"plan",done:progress.planned},{key:"make",done:progress.made},{key:"receive",done:progress.received},{key:"finish",done:progress.finished}];
  return <div className="space-y-5 py-4">
    <div className="rounded-2xl border border-teal-200 bg-teal-50/50 p-5 dark:border-teal-900 dark:bg-teal-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-medium uppercase tracking-wide text-teal-700 dark:text-teal-300">{definition?.terminology?.singular??t("journey.production")}</p><h2 className="mt-1 text-lg font-semibold">{String(r.itemName??r.number)}</h2><p className="mt-1 text-sm text-slate-500">{t("journey.output",{completed:quantity(r.quantityCompleted),ordered:quantity(r.quantityOrdered),unit:String(r.unit??"")})}</p></div>{next?<Button disabled={busy} onClick={()=>onCommand(next)}>{t("actions."+next.key)}</Button>:null}</div>
      <ol className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">{steps.map(step=><li key={step.key} className="flex items-center gap-2 text-sm">{step.done?<Check className="h-4 w-4 text-teal-600" aria-hidden/>:<Circle className="h-4 w-4 text-slate-400" aria-hidden/>}<span>{t("journey."+step.key)}</span></li>)}</ol>
      {r.status==="cancelled"?<p role="status" className="mt-4 text-sm text-slate-600">{t(r.lossChangeId?"journey.disposedLoss":"journey.cancelled")} {String(r.cancelReason??"")}</p>:null}
      {progress.allLoss&&!['done','closed'].includes(String(r.status))?<p role="status" className="mt-4 text-sm text-amber-700">{t('journey.allLoss')}</p>:null}
      {progress.receipt==="partial"?<p role="status" className="mt-4 text-sm text-teal-700">{t("journey.remaining",{remaining:quantity(progress.remaining),unit:String(r.unit??"")})}</p>:null}
      {progress.receipt==="shortClosed"?<p role="status" className="mt-4 text-sm text-amber-700">{t("journey.shortClosed",{remaining:quantity(progress.remaining),unit:String(r.unit??"")})} {String(r.shortCloseReason??"")}</p>:null}
      {r.pendingApproval?<p role="status" className="mt-4 text-sm text-amber-700">{t("approvalPending")}</p>:null}
      {r.status==="on_hold"?<p role="status" className="mt-4 text-sm text-amber-700">{String(r.holdReason??"")}</p>:null}
      <p className="mt-4 max-w-3xl text-sm text-slate-600 dark:text-slate-400">{t("journey."+(r.status==="draft"?"draft":r.status==="released"?"released":r.status==="in_progress"?active?"working":"readyToReceive":["done","closed"].includes(String(r.status))?"finished":"review"))}</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      <RecordKindCard compact label={t("journey.materials")} description={t("journey.materialsNote",{count:materials.length})} icon={<Package className="h-4 w-4" aria-hidden/>} onChoose={()=>onOpen("materials")} />
      <RecordKindCard compact label={active?String(active.sequence)+" · "+active.name:t("journey.operations")} description={active?String(active.centerName)+" · "+label(active.status):t("journey.operationsNote",{count:operations.length})} icon={<Play className="h-4 w-4" aria-hidden/>} onChoose={()=>onOpen("operations",active)} />
      <RecordKindCard compact label={t("journey.outputTitle")} description={t("journey.outputNote",{received:quantity(r.quantityCompleted),scrapped:quantity(r.quantityScrapped)})} icon={<ShieldCheck className="h-4 w-4" aria-hidden/>} onChoose={()=>onOpen("receipts")} />
    </div>
    {canReadQuality?<Button variant="outline" asChild><Link href={('/manufacturing/quality?status=all&workOrderId='+r.id) as never}>{t('quality.title')}</Link></Button>:null}
    {active?.laborTimeSource==="approved_time"?<p className="text-sm text-slate-500"><Badge>{t("values.approved_time")}</Badge> {t("journey.employeeTime")}</p>:null}
  </div>;
}
