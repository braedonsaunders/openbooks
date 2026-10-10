import Link from 'next/link';
import { z } from 'zod';
import { getTranslations,getLocale } from 'next-intl/server';
import { db } from '@openbooks/engine/src/platform/db.ts';
import { withScopeSnapshot } from '@openbooks/engine/src/organization/subsidiary-scope.ts';
import { listManufacturingInspections } from '@openbooks/engine/src/manufacturing/quality-workspace.ts';
import { manufacturingOptions } from '@openbooks/engine/src/manufacturing/workspace.ts';
import { lockManufacturingReadAuthority } from '@openbooks/engine/src/manufacturing/authority.ts';
import { requirePermission,can } from '@/lib/authz';
import { requireFeatureEnabled } from '@/lib/feature-gates';
import { PageHeader,Button,EmptyState,Select,Label,Badge } from '@openbooks/ui';
import { ListPageLayout } from '@/components/page-layout';
import { ModuleHomeTabs } from '@/components/module-home/ui';
import { ServerPagedTable } from '@/components/server-paged-table';
import { formatDecimal } from '@/lib/money-format';
import { InspectionHost } from './InspectionHost';
export const dynamic='force-dynamic';
export default async function Quality({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const authz=await requirePermission('manufacturing.read');await requireFeatureEnabled(authz.user.orgId,'manufacturing');
  const sp=await searchParams,t=await getTranslations('manufacturing.quality'),m=await getTranslations('manufacturing'),locale=await getLocale();
  const scalar=(value:string|string[]|undefined)=>Array.isArray(value)?value[0]:value;
  const status=z.enum(['pending','pass','fail']).safeParse(scalar(sp.status)??'pending');
  const work=z.string().uuid().safeParse(scalar(sp.workOrderId));
  const data=await withScopeSnapshot(authz.user.orgId,async()=>{
    const scope=await lockManufacturingReadAuthority(db,authz.user.orgId,authz.user.id,authz.allowedSubsidiaryIds,['manufacturing.read','items.read']);
    return {queue:await listManufacturingInspections(db,authz.user.orgId,authz.user.id,{status:status.success?status.data:undefined,workOrderId:work.success?work.data:undefined,page:Number.parseInt(scalar(sp.page)??'1',10)||1}),options:await manufacturingOptions(db,authz.user.orgId,scope)};
  });
  const params=new URLSearchParams();for(const key of ['status','workOrderId','page'])if(scalar(sp[key]))params.set(key,scalar(sp[key])!);
  const closeHref='/manufacturing/quality'+(params.size?'?'+params:'');
  const selected=z.string().uuid().safeParse(scalar(sp.inspection));
  return <ListPageLayout header={<PageHeader title={t('title')} description={t('description')} actions={can(authz,'admin.setup.manage')&&authz.allowedSubsidiaryIds===null?<Button variant="outline" asChild><Link href="/admin/setup/manufacturing?tab=inspection-plans">{t('plans')}</Link></Button>:undefined}/>}><div className="space-y-5"><ModuleHomeTabs tabs={[{href:'/manufacturing?view=work',label:m('cockpit.work'),active:false},{href:'/manufacturing/quality',label:t('title'),active:true}]}/><ServerPagedTable source="manufacturing_quality" rows={data.queue.rows} columns={[
    {key:'name',header:t('plan'),cell:row=><Link className="font-medium text-teal-700 hover:underline" href={(closeHref+(closeHref.includes('?')?'&':'?')+'inspection='+row.id) as never}>{row.name}</Link>},
    {key:'itemName',header:t('item'),cell:row=>row.itemName},
    {key:'status',header:t('outcome'),cell:row=><Badge>{row.sourceActive?t('status.'+row.status):t('sourceReversed')}</Badge>},
    {key:'quantity',header:t('quantity'),cell:row=>formatDecimal(locale,row.quantity,{maximumFractionDigits:4})},
    {key:'lotNumber',header:t('lot'),cell:row=>row.lotNumber??'—'},
    {key:'serialNumber',header:t('serial'),cell:row=>row.serialNumber??'—'},
    {key:'disposition',header:t('disposition'),cell:row=>row.disposition?t('dispositions.'+row.disposition):'—'},
  ]} rowKey={row=>row.id} basePath="/manufacturing/quality" currentParams={sp} page={data.queue.page} perPage={25} total={data.queue.total} showPerPage={false} empty={<EmptyState title={t('empty')} description={t('emptyNote')}/>} toolbar={<form action="/manufacturing/quality" className="flex items-end gap-2">{work.success?<input type="hidden" name="workOrderId" value={work.data}/>:null}<div className="space-y-1"><Label htmlFor="inspection-status">{t('outcome')}</Label><Select id="inspection-status" name="status" defaultValue={scalar(sp.status)??'pending'}><option value="all">{m('allStatuses')}</option>{(['pending','pass','fail'] as const).map(value=><option key={value} value={value}>{t('status.'+value)}</option>)}</Select></div><Button type="submit" variant="outline">{m('filter')}</Button></form>}/></div><InspectionHost recordId={selected.success?selected.data:undefined} closeHref={closeHref} canInspect={can(authz,'manufacturing.manage')&&can(authz,'items.manage')} canPost={can(authz,'items.post')} scrapReasons={data.options.reasons.filter(option=>option.parentId==='normal')}/></ListPageLayout>;
}
