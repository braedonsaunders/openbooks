import {resolveMachineRate} from "./conversion.ts";
import {resolveProfile} from "../inventory/profile-policy.ts";
import {cmp,add} from "../money/money.ts";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { listOperatingProfileChoices } from "../organization/operating-profiles.ts";
import type { WorkFamily } from "../organization/operating-profile-model.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { assertStockLocationAdmitsSubsidiary } from "../inventory/profile-policy.ts";
import { subsidiaryCurrency } from "../inventory/position.ts";
import { InventoryError } from "../inventory/contracts.ts";
import { explodeBom } from "./bom-explode.ts";
import { resolveOperationReleaseSnapshots } from "./work-orders.ts";
import { manufacturingControlAccount } from "./journal.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";
import { decimalValue } from './master-support.ts';

export interface SetupFinding { key: string; status: "ready" | "missing" | "choose"; code?: string; message?: string; remedy?: string; href?: string }

/** Readiness is a current diagnostic, never a persisted flag or an authorization to transact. */
export async function readOperatingSetupJourney(tx: SqlExecutor, orgId: string, actorId: string,
  input: {family: WorkFamily; selection: string; departmentId?: string; itemId?: string; subsidiaryId?: string;quantity?:string}) {
  if (!(await tx.execute(sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`)).rows[0]) throw new ManufacturingNotFoundError();
  if (await lockActorCommandAuthority(tx,orgId,actorId,null,"admin.setup.manage") !== null) throw new ManufacturingNotFoundError();
  const choice=(await listOperatingProfileChoices(tx,orgId,actorId,input.family,input.departmentId??null)).find(c=>c.value===input.selection);
  if (!choice) throw new ManufacturingNotFoundError();
  for (const key of [input.family==="project"?"projects":"manufacturing",...(choice.definition.capture==="field_tickets"?["fieldTickets"]:[])]) {
    if (!await lockAndCheckOrgFeature(tx,orgId,key)) throw new ManufacturingNotFoundError();
  }
  if (choice.definition.family === "project") return {choice,findings:[] as SetupFinding[],nextHref:"/projects?"+new URLSearchParams({projectNew:"1",workflow:choice.value,...(input.departmentId?{departmentId:input.departmentId}:{})}),readyFor:"project" as const};
  await lockActorCommandAuthority(tx,orgId,actorId,null,"items.read");
  const quantity=decimalValue(input.quantity??'1','quantity','Choose a positive exact production quantity.');
  if(cmp(quantity,'0')<=0)throw new ManufacturingError('Choose a positive production quantity.',{code:'setup_quantity_required',remedy:'Enter the actual planned output quantity for this order or batch.'});
  const findings: SetupFinding[]=[];
  const today=await businessToday(orgId);
  const check=async (key:string,href:string,work:()=>Promise<unknown>) => {
    try {await work();findings.push({key,status:"ready",href});}
    catch(error) {
      if (error instanceof InventoryError) {
        findings.push({key,status:"missing",href,code:"stock_location_unavailable",message:error.message});
      } else {
        if (!(error instanceof ManufacturingError)) throw error;
        if (error.status===404) throw error;
        const editor = error.code.startsWith("component_") ? "/items"
          : error.code.startsWith("machine_rate") ? "/manufacturing/work-centers"
          : error.code.startsWith("mfg") || error.code.startsWith("laborClearing") ? "/admin/setup/company"
          : error.code.startsWith("work_center") ? "/manufacturing/work-centers"
          : error.code.startsWith("standard_overhead") ? "/admin/setup/overhead"
          : error.code.includes("fx") ? "/admin/setup/fx-provider" : href;
        findings.push({key,status:"missing",href:editor,code:error.code,message:error.message,remedy:error.remedy});
      }
    }
  };
  if (!input.itemId) findings.push({key:"item",status:"choose",href:"/items"});
  if (!input.subsidiaryId) findings.push({key:"entity",status:"choose",href:"/admin/setup/subsidiaries"});
  if (findings.length) return {choice,findings,nextHref:null,readyFor:null};
  if (!isUuid(input.itemId) || !isUuid(input.subsidiaryId)) throw new ManufacturingNotFoundError();
  const entity=(await tx.execute(sql`select id from subsidiaries where org_id=${orgId} and id=${input.subsidiaryId} and is_active and not is_elimination for share`)).rows[0];
  const item=(await tx.execute<{id:string;name:string;base_unit:string|null}>(sql`select i.id,i.name,p.base_unit from items i left join item_inventory_profiles p on p.org_id=i.org_id and p.item_id=i.id where i.org_id=${orgId} and i.id=${input.itemId} and i.is_active for share of i`)).rows[0];
  if (!entity || !item) throw new ManufacturingNotFoundError();
  findings.push({key:"item",status:item.base_unit?"ready":"missing",href:"/items",...(item.base_unit?{}:{code:"item_profile_required"})});
  findings.push({key:"entity",status:"ready"});
  await check("bom","/inventory?inventoryView=bom&bom="+item.id,async()=>{
    const explosion=await explodeBom(tx,orgId,item.id,quantity,today);
    for(const component of explosion.components) {
      const profile=await resolveProfile(orgId,component.itemId,tx,true);
      if(!(await tx.execute(sql`select id from accounts where org_id=${orgId} and id=${profile.assetAccountId} and is_active and type like 'asset_%' for share`)).rows.length)
        throw new ManufacturingError(`Component ${component.itemCode} needs an active inventory asset account.`,{code:'component_asset_account_missing',remedy:'Review the component’s inventory costing profile in Items.'});
    }
  });
  const routes=(await tx.execute<{id:string;version:number;effective_from:string;effective_to:string|null;default_issue_location_id:string|null;default_receipt_location_id:string|null;overheadBasis:string}>(sql`select id,version,effective_from::text,effective_to::text,default_issue_location_id,default_receipt_location_id,overhead_basis as "overheadBasis" from mfg_routings where org_id=${orgId} and produced_item_id=${item.id} and status='active' and effective_from<=${today}::date and (effective_to is null or ${today}::date<effective_to) order by version for share`)).rows;
  const route=routes.length===1?routes[0]:null;
  findings.push({key:"routing",status:route?"ready":"missing",href:route?"/manufacturing/routings?record="+route.id:"/manufacturing/routings"});
  if (route) {
    const operations=(await tx.execute<{sequence:number;work_center_id:string;setup:string;run:string;labor:string|null;kind:string;code:string;absorbs:boolean;laborSource:string}>(sql`select operation.sequence,operation.work_center_id,operation.setup_minutes::text as setup,operation.run_minutes_per_unit::text as run,operation.labor_minutes_per_unit::text as labor,center.kind,center.code,center.absorbs_overhead as absorbs,operation.labor_time_source as "laborSource" from mfg_routing_operations operation join mfg_work_centers center on center.org_id=operation.org_id and center.id=operation.work_center_id where operation.org_id=${orgId} and operation.routing_id=${route.id} order by operation.sequence for share of operation,center`)).rows;
    if (!operations.length) findings.push({key:"operations",status:"missing",href:"/manufacturing/routings?record="+route.id});
    else await check("costing","/admin/setup/labor-costing",async()=>{
      const snapshots=await resolveOperationReleaseSnapshots(tx,orgId,{number:item.name,subsidiaryId:input.subsidiaryId!},operations,route,today,await subsidiaryCurrency(orgId,input.subsidiaryId!,tx));
      for(const [index,operation] of operations.entries()) {
        const elapsed=add(operation.setup,operation.run);
        const machine=['machine','cell'].includes(operation.kind)&&cmp(elapsed,'0')>0;
        const labor=operation.laborSource==='approved_time'||cmp(operation.labor??(['labor','cell'].includes(operation.kind)?elapsed:'0'),'0')>0;
        if(machine) await resolveMachineRate(tx,orgId,operation.work_center_id,today,operation.code);
        if(operation.absorbs&&!snapshots[index]!.overhead.cards.length) throw new ManufacturingError(`Work center ${operation.code} needs an effective standard overhead rate.`,{code:'standard_overhead_rate_missing',remedy:'Configure standard overhead for its department and the routing’s overhead basis.'});
        if(labor) await manufacturingControlAccount(tx,orgId,input.subsidiaryId!,'laborClearing');
        if(machine||operation.absorbs) await manufacturingControlAccount(tx,orgId,input.subsidiaryId!,'mfgOverheadApplied');
      }
    });
    const context=await loadSubsidiaryContext(tx,orgId);
    for (const [key,locationId,direction] of [["issueLocation",route.default_issue_location_id,"outbound"],["receiptLocation",route.default_receipt_location_id,"inbound"]] as const) {
      if (!locationId) findings.push({key,status:"choose",href:"/manufacturing/routings?record="+route.id});
      else await check(key,"/admin/setup/stock-locations",()=>assertStockLocationAdmitsSubsidiary(tx,orgId,context,locationId,input.subsidiaryId!,direction));
    }
  }
  await check("accounts","/admin/setup/company#ctrl-mfgWip",()=>manufacturingControlAccount(tx,orgId,input.subsidiaryId!,"mfgWip"));
  const query=new URLSearchParams({record:"new",workflow:choice.value,producedItemId:input.itemId!,subsidiaryId:input.subsidiaryId!,quantityOrdered:quantity,...(input.departmentId?{departmentId:input.departmentId}:{})});
  return {choice,findings,nextHref:"/manufacturing/work-orders?"+query,readyFor:findings.every(f=>f.status==="ready")?"release" as const:"draft" as const};
}
