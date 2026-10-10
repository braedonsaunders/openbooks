import { readWorkListFilters } from "@openbooks/engine/src/organization/work-list-filters.ts";
import { readWorkListPresentation } from "@openbooks/engine/src/organization/list-presentation.ts";
import { WorkListPresentation } from "@/components/work-list-presentation";
import { manufacturingFeatureEnabled } from "@openbooks/engine/src/manufacturing/gate.ts";
import Link from "next/link";
import { z } from "zod";
import { getTranslations, getLocale } from "next-intl/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { withScopeSnapshot } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { listOperatingProfileChoices } from "@openbooks/engine/src/organization/operating-profiles.ts";
import { lockManufacturingReadAuthority } from "@openbooks/engine/src/manufacturing/authority.ts";
import { listManufacturingRecords, manufacturingOptions } from "@openbooks/engine/src/manufacturing/workspace.ts";
import { requirePermission, can } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { PageHeader, Button, EmptyState, Select, Input, Label } from "@openbooks/ui";
import { ListPageLayout } from "@/components/page-layout";
import { ModuleHomeTabs } from "@/components/module-home/ui";
import { RecordBoard } from "@/components/record-board";
import { ServerPagedTable } from "@/components/server-paged-table";
import { formatDecimal } from "@/lib/money-format";
import { WorkflowStart } from "./WorkflowStart";
import { ManufacturingSetupJourney } from "./SetupJourney";
import { ManufacturingRecordHost } from "./RecordHost";
export const dynamic = "force-dynamic";
export async function generateMetadata() {const t=await getTranslations("manufacturing");return {title:t("title")};}
export default async function ManufacturingHome({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const authz=await requirePermission("manufacturing.read");
  await requireFeatureEnabled(authz.user.orgId,"manufacturing");
  const sp=await searchParams,t=await getTranslations("manufacturing"),op=await getTranslations("operatingProfiles"),locale=await getLocale();
  const scalar=(value:string|string[]|undefined)=>Array.isArray(value)?value[0]:value;
  const canSetup=can(authz,"admin.setup.manage")&&authz.allowedSubsidiaryIds===null;
  const data=await withScopeSnapshot(authz.user.orgId,async()=>{
    const scope=await lockManufacturingReadAuthority(db,authz.user.orgId,authz.user.id,authz.allowedSubsidiaryIds);
    return ({
    filters:await readWorkListFilters(db,authz.user.orgId,authz.user.id,"production"),
    presentation:await readWorkListPresentation(db,authz.user.orgId,authz.user.id,"manufacturing_work_order"),
    orders:await listManufacturingRecords(db,authz.user.orgId,scope,"work-orders",{page:Number.parseInt(scalar(sp.page)??"1",10)||1,perPage:25,activeOnly:!scalar(sp.status)||scalar(sp.status)==="open",status:["open","all"].includes(scalar(sp.status)??"")?undefined:scalar(sp.status),q:scalar(sp.q),workflow:scalar(sp.workflowFilter),department:scalar(sp.department)}),
    choices:await listOperatingProfileChoices(db,authz.user.orgId,authz.user.id,"production"),
    options:await manufacturingOptions(db,authz.user.orgId,scope),
  });});
  const requested=scalar(sp.view),hasWorkFilter=['page','status','q','presentation','workflowFilter','department'].some(key=>scalar(sp[key])!==undefined),view=requested==="setup"&&canSetup?"setup":requested==="start"&&can(authz,"manufacturing.manage")?"start":requested==="work"||hasWorkFilter?"work":data.orders.total?"work":can(authz,"manufacturing.manage")?"start":"work";
  const closeParams=new URLSearchParams();for(const key of ["view","page","status","q","presentation","workflowFilter","department"])if(scalar(sp[key]))closeParams.set(key,scalar(sp[key])!);
  const closeHref="/manufacturing"+(closeParams.size?"?"+closeParams:"");
  const viewHref=(next:"work"|"start"|"setup")=>{const params=new URLSearchParams(closeParams);params.set("view",next);return "/manufacturing?"+params;};
  const tabs=[{href:viewHref("work"),label:t("cockpit.work"),active:view==="work"},...(can(authz,"manufacturing.manage")?[{href:viewHref("start"),label:t("cockpit.start"),active:view==="start"}]:[]),...(canSetup?[{href:viewHref("setup"),label:t("cockpit.setup"),active:view==="setup"}]:[])];
  if(can(authz,"items.read"))tabs.push({href:"/manufacturing/quality",label:t("quality.title"),active:false});
  const presentation=(scalar(sp.presentation)??data.presentation??"board")==="list"?"list":"board";

  const record=scalar(sp.record),parsedRecord=z.string().uuid().safeParse(record),recordId=record==="new"?record:parsedRecord.success?parsedRecord.data:undefined;
  return <ListPageLayout header={<PageHeader title={t("title")} description={t("cockpit.description")} actions={view!=="start"&&can(authz,"manufacturing.manage")?<Button asChild><Link href="/manufacturing?view=start">{t("cockpit.new")}</Link></Button>:undefined}/>}>
    <div className="space-y-5"><ModuleHomeTabs tabs={tabs}/>{view==="setup"?<ManufacturingSetupJourney/>:view==="start"?<div className="space-y-5">{canSetup?<p className="text-sm text-slate-500">{t("cockpit.firstTime")} <Link className="font-medium text-teal-700 hover:underline" href="/admin/setup/manufacturing">{t("cockpit.setup")}</Link></p>:null}<WorkflowStart choices={data.choices}/><p className="max-w-3xl text-sm text-slate-500">{t("cockpit.projectNote")}</p></div>:<ServerPagedTable source="manufacturing_home_queue" rows={data.orders.rows} columns={[
      {key:"number",header:t("fields.number"),cell:row=><Link className="font-medium text-teal-700" href={(closeHref+(closeHref.includes("?")?"&":"?")+"record="+row.id) as never}>{String(row.number)}</Link>},
      {key:"itemName",header:t("fields.itemName"),cell:row=>String(row.itemName)},
      {key:"status",header:t("fields.status"),cell:row=>t("values."+row.status)},
      {key:"quantityCompleted",header:t("fields.quantityCompleted"),cell:row=>formatDecimal(locale,String(row.quantityCompleted),{maximumFractionDigits:4})},
      {key:"quantityOrdered",header:t("fields.quantityOrdered"),cell:row=>formatDecimal(locale,String(row.quantityOrdered),{maximumFractionDigits:4})},
    ]} rowKey={row=>row.id} basePath="/manufacturing" currentParams={{...sp,view:"work"}} page={data.orders.page} perPage={data.orders.perPage} total={data.orders.total} showPerPage={false} toolbar={<form action="/manufacturing" className="flex flex-wrap items-end gap-2"><input type="hidden" name="view" value="work"/><input type="hidden" name="presentation" value={presentation}/><div className="space-y-1"><Label htmlFor="production-search">{t("search")}</Label><Input id="production-search" name="q" defaultValue={scalar(sp.q)} placeholder={t("searchPlaceholder")} className="w-60"/></div><div className="space-y-1"><Label htmlFor="production-status">{t("fields.status")}</Label><Select id="production-status" name="status" defaultValue={scalar(sp.status)??"open"}><option value="open">{t("cockpit.open")}</option><option value="all">{t("allStatuses")}</option>{["draft","released","in_progress","on_hold","done","closed","cancelled"].map(status=><option key={status} value={status}>{t("values."+status)}</option>)}</Select></div><div className="space-y-1"><Label htmlFor="production-workflow">{op('filters.workflow')}</Label><Select id="production-workflow" name="workflowFilter" defaultValue={scalar(sp.workflowFilter)??'all'}><option value="all">{op('filters.allWorkflows')}</option><option value="legacy">{op('filters.legacy')}</option>{data.filters.profiles.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</Select></div><div className="space-y-1"><Label htmlFor="production-department">{op('filters.department')}</Label><Select id="production-department" name="department" defaultValue={scalar(sp.department)??'all'}><option value="all">{op('filters.allDepartments')}</option><option value="unassigned">{op('filters.unassigned')}</option>{data.filters.departments.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</Select></div><Button type="submit" variant="outline">{t("filter")}</Button><div className="ml-auto"><WorkListPresentation context="manufacturing_work_order" value={presentation} basePath="/manufacturing" currentParams={{...sp,view:"work"}}/></div></form>} empty={<EmptyState title={t("empty.work-orders")} description={t("cockpit.empty")}/>} presentationBody={presentation==="board"?<RecordBoard lanes={(scalar(sp.status)==="all"?["draft","released","in_progress","on_hold","done","closed","cancelled"]:scalar(sp.status)&&scalar(sp.status)!=="open"?[scalar(sp.status)!]:["draft","released","in_progress","on_hold"]).map(value=>({value,label:t.has("values."+value)?t("values."+value):value}))} cards={data.orders.rows.map(row=>({id:row.id,lane:String(row.status),title:<Link className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500" href={(closeHref+(closeHref.includes("?")?"&":"?")+"record="+row.id) as never}>{String(row.number)}</Link>,subtitle:String(row.itemName),detail:<span>{formatDecimal(locale,String(row.quantityCompleted),{maximumFractionDigits:4})} / {formatDecimal(locale,String(row.quantityOrdered),{maximumFractionDigits:4})} {String(row.unit)}</span>}))} emptyLabel={op("views.emptyLane")} pageLabel={op("views.pageScope")}/>:undefined} />}</div>
    <ManufacturingRecordHost view="work-orders" recordId={recordId} closeHref={closeHref} options={data.options} canManage={can(authz,"manufacturing.manage")} canPost={can(authz,"items.post")} canBuy={can(authz,"ap.create")} canSubcontract={await manufacturingFeatureEnabled(authz.user.orgId,"manufacturingSubcontract")} canReadQuality={can(authz,"items.read")} canReadJournal={can(authz,"gl.read")} canGovernRevisions={can(authz,"manufacturing.manage")&&authz.allowedSubsidiaryIds===null}/>
  </ListPageLayout>;
}
