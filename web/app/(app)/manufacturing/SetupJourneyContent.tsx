"use client";
import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, Input, Label, Select } from "@openbooks/ui";
import { Check, CircleAlert } from "lucide-react";
import { OperatingProfileCards } from "@/components/operating-profile-cards";
import { RemoteRecordChoice } from "@/components/remote-record-choice";
import { readApiErrorMessage } from "@/lib/api-error";
import type { OperatingProfileChoice } from "@openbooks/engine/src/organization/operating-profiles.ts";
import type { readOperatingSetupJourney } from "@openbooks/engine/src/manufacturing/setup-journey.ts";

export function SetupJourneyContent({choices,entities,canCreateProject,canCreateProduction}:{choices:OperatingProfileChoice[];entities:{value:string;label:string}[];canCreateProject:boolean;canCreateProduction:boolean}) {
  const t=useTranslations("manufacturing.setupJourney"),o=useTranslations("operatingProfiles"),id=useId();
  const [selected,setSelected]=useState<OperatingProfileChoice|null>(null),[itemId,setItemId]=useState(""),[subsidiaryId,setSubsidiaryId]=useState(entities.length===1?entities[0]!.value:""),[departmentId,setDepartmentId]=useState("");
  const [quantity,setQuantity]=useState('1');
  const [facts,setFacts]=useState<Awaited<ReturnType<typeof readOperatingSetupJourney>>|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{
    if (!selected) {setFacts(null);setError(null);return;}
    if(selected.definition.family==='production'&&!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,4})?$/.test(quantity)){setFacts(null);setError(null);setLoading(false);return;}
    const controller=new AbortController();setLoading(true);setFacts(null);setError(null);
    void fetch("/api/operating-profiles/setup-journey",{method:"POST",headers:{"Content-Type":"application/json"},signal:controller.signal,body:JSON.stringify({family:selected.definition.family,selection:selected.value,...(departmentId?{departmentId}:{}),...(itemId?{itemId}:{}),...(subsidiaryId?{subsidiaryId}:{}),...(selected.definition.family==='production'?{quantity}:{})})})
      .then(async response=>{if(!response.ok)throw new Error(await readApiErrorMessage(response,o("loadFailed")));return response.json();})
      .then(result=>{if(!controller.signal.aborted)setFacts(result);})
      .catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:o("loadFailed"));})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[selected,itemId,subsidiaryId,departmentId,quantity,retry,o]);
  const labels={choose:t("choose"),searchPlaceholder:o("time.search"),loadFailed:o("loadFailed"),retry:o("retry")};
  const canCreate=selected?.definition.family==="project"?canCreateProject:canCreateProduction;
  return <div className="space-y-5"><div><h2 className="text-xl font-semibold">{t("title")}</h2><p className="mt-2 max-w-3xl text-sm text-slate-500">{t("description")}</p></div>
    {!selected?choices.length?<OperatingProfileCards choices={choices} value={null} onChoose={setSelected}/>:<div className="max-w-3xl space-y-3 rounded-xl border p-5"><p className="text-sm text-slate-500">{t("noStyles")}</p><Button variant="outline" asChild><Link href="/admin/setup/features">{t("reviewFeatures")}</Link></Button></div>:<>
      <div className="flex items-center justify-between gap-4 rounded-xl border p-4"><div><h3 className="font-semibold">{!selected.profileId&&o.has("presets."+selected.value+".name")?o("presets."+selected.value+".name"):selected.name}</h3><p className="mt-1 text-sm text-slate-500">{selected.definition.family==="project"?t("projectNote"):t("productionNote")}</p></div><Button variant="outline" onClick={()=>{setSelected(null);setDepartmentId("");}}>{t("changeStyle")}</Button></div>
      <div className="grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-4"><div className="space-y-1"><Label htmlFor={id+"department"}>{o("department")}</Label><RemoteRecordChoice id={id+"department"} value={departmentId} options={[]} clearable endpoint={"/api/operating-profiles/departments?family="+selected.definition.family} onChange={setDepartmentId} labels={{...labels,choose:o("companyDefaults")}}/></div>
        {selected.definition.family==="production"?<><div className="space-y-1"><Label htmlFor={id+"item"}>{t("facts.item")}</Label><RemoteRecordChoice id={id+"item"} value={itemId} options={[]} endpoint="/api/manufacturing/options?kind=items" onChange={setItemId} labels={labels}/></div><div className="space-y-1"><Label htmlFor={id+"entity"}>{t("facts.entity")}</Label><Select id={id+"entity"} value={subsidiaryId} onChange={event=>setSubsidiaryId(event.target.value)}><option value="">{t("choose")}</option>{entities.map(entity=><option key={entity.value} value={entity.value}>{entity.label}</option>)}</Select></div><div className="space-y-1"><Label htmlFor={id+"quantity"}>{t("facts.quantity")}</Label><Input id={id+"quantity"} value={quantity} inputMode="decimal" required onChange={event=>setQuantity(event.target.value)}/></div></>:null}
      </div>
      {loading?<p role="status" className="text-sm text-slate-500">{o("loading")}</p>:error?<div role="alert" className="space-y-2"><p className="text-sm text-red-700">{error}</p><Button variant="outline" onClick={()=>setRetry(r=>r+1)}>{o("retry")}</Button></div>:facts?<>
        {facts.findings.length?<ol className="max-w-4xl divide-y rounded-xl border">{facts.findings.map(finding=><li key={finding.key} className="flex items-start gap-3 p-4">{finding.status==="ready"?<Check className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" aria-hidden/>:<CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden/>}<div className="min-w-0 flex-1"><p className="text-sm font-medium">{t("facts."+finding.key)} <span className="ml-2 text-xs font-normal text-slate-500">{t("states."+finding.status)}</span></p>{finding.message?<p className="mt-1 text-sm text-slate-500">{finding.message}</p>:null}{finding.remedy?<p className="mt-1 text-sm text-slate-500">{finding.remedy}</p>:null}</div>{finding.href&&finding.status!=="ready"?<Link className="shrink-0 text-sm font-medium text-teal-700 hover:underline" href={finding.href as never}>{t("review")}</Link>:null}</li>)}</ol>:null}
        {facts.nextHref&&canCreate?<div className="space-y-2"><p className="max-w-3xl text-sm text-slate-500">{t("next."+facts.readyFor)}</p><Button asChild><Link href={facts.nextHref as never}>{t(facts.readyFor==="project"?"startProject":"startProduction")}</Link></Button></div>:null}
        <p className="max-w-3xl text-xs text-slate-500">{t("diagnosticNote")}</p>
      </>:null}
    </>}
  </div>;
}
