import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { PageHeader, Button } from '@openbooks/ui';
import { ListPageLayout } from '@/components/page-layout';
import { RegisteredListTable } from '@/components/registered-list-table';
import { ModuleHomeTabs } from '@/components/module-home/tabs';
import { SearchInput } from '@/components/search-input';
import { can, requirePermission } from '@/lib/authz';
import { requireFeatureEnabled } from '@/lib/feature-gates';
import { db } from '@openbooks/engine/platform/db';
import { businessToday } from '@openbooks/engine/platform/business-date/module';
import { subsidiaryVisibleFilter } from '@/lib/subsidiaries';
import { isUuid, parseListParams, pickString } from '@/lib/list-params';
import { RebateDrawer } from './RebateDrawer';
import type { RebateAgreement, RebateClaim } from '@openbooks/engine/revenue/rebates';
export const dynamic='force-dynamic';
type RegisterRow={id:string;label:string;party:string;side:'customer'|'vendor';status:string;currency:string;amount:string|null};
export default async function RebatesPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 const sp=await searchParams,authz=await requirePermission('documents.read'),orgId=authz.user.orgId;
 await requireFeatureEnabled(orgId,'rebateManagement');
 const view=sp.view==='claims'?'claims':'agreements';
 const params=parseListParams(sp,{sort:'code',allowedSorts:['code']}),page=params.page,perPage=params.perPage;
 const side=sql`and ((a.side='customer' and ${can(authz,'ar.read')}) or (a.side='vendor' and ${can(authz,'ap.read')}))`;
 const scope=subsidiaryVisibleFilter(sql`a.subsidiary_id`,authz.allowedSubsidiaryIds);
 const q=params.q?sql`and (a.code ilike ${`%${params.q}%`} or a.name ilike ${`%${params.q}%`} or p.display_name ilike ${`%${params.q}%`})`:sql``;
 const from=view==='claims'?sql`rebate_claims c join rebate_agreements a on a.org_id=c.org_id and a.id=c.agreement_id left join parties p on p.org_id=c.org_id and p.id=c.party_id`:sql`rebate_agreements a left join parties p on p.org_id=a.org_id and p.id=a.party_id`;
 const where=sql`where a.org_id=${orgId} ${scope} ${side} ${q}`;
 const count=(await db.execute<{total:number}>(sql`select count(*)::int as total from ${from} ${where}`)).rows[0]?.total??0;
 const rows=(await db.execute<RegisterRow>(sql`select ${view==='claims'?sql`c.id`:sql`a.id`} as id,a.code || ' · ' || a.name as label,coalesce(p.display_name,'Class agreement') as party,a.side,${view==='claims'?sql`c.status`:sql`a.status`} as status,a.currency,${view==='claims'?sql`c.amount::text`:sql`null::text`} as amount from ${from} ${where} order by a.code,${view==='claims'?sql`c.created_at desc,c.id`:sql`a.id`} limit ${perPage} offset ${(page-1)*perPage}`)).rows;
 const recordId=pickString(sp.record);
 let selected: {agreement:RebateAgreement;claim:RebateClaim|null;parties:{id:string;name:string}[];banks:{id:string;name:string}[];canPost:boolean;today:string;baseCurrency:string;sources:{lineId:string;documentId:string;label:string}[]}|null=null;
 if(recordId&&isUuid(recordId)) {
  const a=(await db.execute<RebateAgreement>(sql`select a.* from rebate_agreements a ${view==='claims'?sql`join rebate_claims c on c.org_id=a.org_id and c.agreement_id=a.id`:sql``}
   where a.org_id=${orgId} and ${view==='claims'?sql`c.id`:sql`a.id`}=${recordId} ${scope} ${side}`)).rows[0];
  if(a) {
   const claim=view==='claims'?(await db.execute<RebateClaim>(sql`select * from rebate_claims where org_id=${orgId} and id=${recordId}`)).rows[0]??null:null;
   const parties=(await db.execute<{id:string;name:string}>(sql`select distinct p.id,p.display_name as name from rebate_accruals f join parties p on p.org_id=f.org_id and p.id=f.party_id where f.org_id=${orgId} and f.agreement_id=${a.id} order by p.display_name,p.id`)).rows;
   const banks=(await db.execute<{id:string;name:string}>(sql`select id,name from accounts where org_id=${orgId} and type='asset_bank' and is_active and not is_summary ${subsidiaryVisibleFilter(sql`subsidiary_id`,authz.allowedSubsidiaryIds,{orgWideNull:true})} order by number,name`)).rows;
   const baseCurrency=(await db.execute<{base_currency:string}>(sql`select base_currency from subsidiaries where org_id=${orgId} and id=${a.subsidiary_id}`)).rows[0]?.base_currency;
   const sources=(await db.execute<{lineId:string;documentId:string;label:string}>(sql`select dl.id as "lineId",d.id as "documentId",d.document_number || ' · ' || coalesce(dl.description,'Line ' || dl.line_number::text) as label from document_lines dl join documents d on d.org_id=dl.org_id and d.id=dl.document_id where d.org_id=${orgId} and d.status in ('draft','approved','posted') and d.currency=${a.currency} and d.subsidiary_id=${a.subsidiary_id} and d.document_date between ${a.effective_from} and ${a.effective_to} and d.kind in ${a.activity==='purchase'?['vendor_bill','vendor_credit']:['customer_invoice','cash_sale','customer_credit','cash_refund']} ${a.party_id&&a.activity!=='downstream_sale'?sql`and d.party_id=${a.party_id}`:sql``} ${a.item_id?sql`and dl.item_id=${a.item_id}`:sql``} ${a.class_id?sql`and coalesce(dl.class_id,d.class_id)=${a.class_id}`:sql``} order by d.document_date desc,d.document_number,dl.line_number`)).rows;
   if(baseCurrency)selected={agreement:a,claim,parties,banks,canPost:can(authz,a.side==='customer'?'ar.post':'ap.post'),today:await businessToday(orgId),baseCurrency,sources};
  }
 }
 return <ListPageLayout header={<PageHeader title="Rebates" description="Customer and vendor agreements, earned accruals and governed settlement." actions={can(authz,'admin.setup.manage')&&can(authz,'documents.manage')?<Button asChild><Link href="/admin/setup/rebate-agreements?row=new">New agreement</Link></Button>:undefined}/> }>
  <ModuleHomeTabs tabs={[{href:'/rebates',label:'Agreements',active:view==='agreements'},{href:'/rebates?view=claims',label:'Claims',active:view==='claims'}]} placement="local"/>
  <div className="flex flex-wrap items-center gap-3"><SearchInput/><Link className="text-sm underline" href="/admin/setup/rebate-agreements">Agreement settings</Link><Link className="text-sm underline" href="/reports?category=orders">Rebate reports</Link></div>
  <RegisteredListTable source={view==='claims'?'rebate_claims':'rebate_agreements'} rows={rows} rowKey={r=>r.id} empty="No rebate records in this view." basePath="/rebates" currentParams={sp} state={{total:count,page,perPage}}
   columns={[{key:'agreement',label:'Agreement',cell:r=><Link className="underline" href={`/rebates?view=${view}&record=${r.id}`}>{r.label}</Link>},{key:'party',label:'Counterparty',cell:r=>r.party},{key:'side',label:'Side',cell:r=>r.side},{key:'status',label:'Status',cell:r=>r.status},...(view==='claims'?[{key:'amount',label:'Claim amount',cell:(r:RegisterRow)=>`${r.amount} ${r.currency}`}]:[])]}/>
  {selected?<RebateDrawer data={selected} closeHref={view==='claims'?'/rebates?view=claims':'/rebates'}/>:null}
 </ListPageLayout>;
}
