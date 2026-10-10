"use client";
import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, Input, Label, Select, Textarea } from "@openbooks/ui";
import { useBusinessToday } from "@/components/business-date-provider";
import { useMoney } from "@/components/money-provider";
import { readApiErrorMessage } from "@/lib/api-error";
import { PagedTable } from "@/components/paged-table";
import { formatDecimal } from "@/lib/money-format";
import { useLocale } from "next-intl";
import type { ManufacturingOptions } from "@openbooks/engine/src/manufacturing/workspace.ts";
import type { previewStandardRollup } from "@openbooks/engine/src/manufacturing/standard-rollup.ts";
type Preview=Awaited<ReturnType<typeof previewStandardRollup>>;

/** Measurement and application remain in the native cost/revaluation services. */
export function StandardRollupPanel({itemId,options,onDirty,onSaved}:{itemId:string;options:ManufacturingOptions;onDirty:()=>void;onSaved:()=>void}) {
  const t=useTranslations("manufacturing.rollup"),fields=useTranslations('manufacturing.fields'),mfg=useTranslations('manufacturing'),locale=useLocale(),id=useId(),today=useBusinessToday(),{money}=useMoney();
  const [subsidiaryId,setSubsidiaryId]=useState(options.subsidiaries.length===1?options.subsidiaries[0]!.value:""),[onDate,setOnDate]=useState(today),[batchQuantity,setBatchQuantity]=useState("1"),[reason,setReason]=useState(""),[preview,setPreview]=useState<Preview|null>(null),[changeId,setChangeId]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const requestKey=useRef<string|null>(null),lock=useRef(false);
  function changed(){onDirty();setPreview(null);setChangeId(null);requestKey.current=null;}
  async function act(action:"preview"|"propose") {
    if(lock.current)return;lock.current=true;setBusy(true);setError(null);
    try {
      requestKey.current??=crypto.randomUUID();
      const response=await fetch("/api/manufacturing/standard-rollup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,itemId,subsidiaryId,onDate,batchQuantity,...(action==="propose"?{reason,idempotencyKey:requestKey.current,expectedDigest:preview?.digest}:{})})});
      if(!response.ok)throw new Error(await readApiErrorMessage(response,t("failed")));
      const result=await response.json();
      if(action==="preview")setPreview(result as Preview);else{setPreview(result.preview);setChangeId(result.changeId);onSaved();}
    }catch(cause){setError(cause instanceof Error?cause.message:t("failed"));}finally{lock.current=false;setBusy(false);}
  }
  return <div className="space-y-5 py-4"><div><h2 className="text-lg font-semibold">{t("title")}</h2><p className="mt-1 max-w-3xl text-sm text-slate-500">{t("description")}</p></div><form onSubmit={event=>{event.preventDefault();void act("preview")}} className="grid gap-3 sm:grid-cols-3"><div className="space-y-1"><Label htmlFor={id+"entity"}>{t("entity")}</Label><Select id={id+"entity"} value={subsidiaryId} required disabled={busy||!!changeId} onChange={event=>{changed();setSubsidiaryId(event.target.value)}}><option value="">{t("choose")}</option>{options.subsidiaries.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</Select></div><div className="space-y-1"><Label htmlFor={id+"date"}>{t("date")}</Label><Input id={id+"date"} type="date" value={onDate} required disabled={busy||!!changeId} onChange={event=>{changed();setOnDate(event.target.value)}}/></div><div className="space-y-1"><Label htmlFor={id+"batch"}>{t("batch")}</Label><Input id={id+"batch"} inputMode="decimal" value={batchQuantity} required pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,4})?" disabled={busy||!!changeId} onChange={event=>{changed();setBatchQuantity(event.target.value)}}/></div><Button type="submit" variant="outline" disabled={busy||!!changeId}>{t("preview")}</Button></form>
    {error?<p role="alert" className="text-sm text-red-700">{error}</p>:null}
    {preview?.jointOutputCosts.length?<div className="space-y-2"><p className="text-sm text-slate-500">{mfg('jointOutputNote')}</p><PagedTable source="manufacturing_record_rows" rows={preview.jointOutputCosts} rowKey={row=>row.itemId} pageSize={5} searchable empty={null} columns={[
      {key:'name',header:fields('itemName'),cell:row=>row.name,search:row=>row.name},
      {key:'quantity',header:fields('quantity'),cell:row=>formatDecimal(locale,row.quantity,{maximumFractionDigits:4})},
      {key:'costWeight',header:fields('outputCostWeight'),cell:row=>formatDecimal(locale,row.costWeight,{maximumFractionDigits:4})},
      {key:'amount',header:fields('totalValue'),cell:row=>money(row.amount,{currency:preview.currency,currencyDisplay:'code'})},
      {key:'unitCost',header:fields('unitCost'),cell:row=>money(row.unitCost,{currency:preview.currency,currencyDisplay:'code'})},
    ]}/></div>:null}
    {preview?<div className="space-y-4"><dl className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2 lg:grid-cols-5">{(["material","labor","overhead","byproductCredit","standardCost"] as const).map(key=><div key={key}><dt className="text-xs text-slate-500">{t(key)}</dt><dd className="mt-1 font-semibold">{money(preview[key],{currency:preview.currency,currencyDisplay:"code"})}</dd></div>)}</dl><p className="text-xs text-slate-500">{t("batchNote")}</p>{changeId?<div className="space-y-2"><p className="text-sm">{t("proposed")}</p><Button asChild><Link href={("/accounting/changes?change="+changeId) as never}>{t("review")}</Link></Button></div>:<div className="space-y-2"><Label htmlFor={id+"reason"}>{t("reason")}</Label><Textarea id={id+"reason"} minLength={8} maxLength={1000} value={reason} disabled={busy} onChange={event=>{onDirty();requestKey.current=null;setReason(event.target.value)}}/><Button disabled={busy||reason.trim().length<8} onClick={()=>void act("propose")}>{t("propose")}</Button></div>}</div>:null}
  </div>;
}
