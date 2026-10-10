"use client";
import {useTranslations,useLocale} from 'next-intl';
import {Button,EmptyState} from '@openbooks/ui';
import {PagedTable} from '@/components/paged-table';
import {formatDecimal} from '@/lib/money-format';
import {dateLabel,dateTime} from '@/lib/format';
import type {ManufacturingRecordData,ManufacturingRow} from '@openbooks/engine/src/manufacturing/workspace.ts';

/** A scoped run view reads the same posted movements used by inventory and genealogy. */
export function ProcessRunPanel({data,onOpen}:{data:ManufacturingRecordData;onOpen:(tab:string)=>void}) {
 const t=useTranslations('manufacturing'),locale=useLocale(),record=data.record;
 const quantity=(value:unknown)=>formatDecimal(locale,String(value??'0'),{maximumFractionDigits:4});
 return <div className="space-y-5 py-4"><div className="rounded-xl border p-5"><h3 className="font-semibold">{t('process.title')}</h3><p className="mt-2 max-w-3xl text-sm text-slate-500">{t('process.windowNote')}</p>
  <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[
    ['productionMode',t('values.'+record.productionMode)],['campaignReference',String(record.campaignReference??'—')],
    ['plannedStart',record.plannedStart?dateLabel(String(record.plannedStart)):'—'],['plannedEnd',record.plannedEnd?dateLabel(String(record.plannedEnd)):'—'],
    ['startedAt',record.startedAt?dateTime(String(record.startedAt)):'—'],['completedAt',record.completedAt?dateTime(String(record.completedAt)):'—'],
   ].map(([key,value])=><div key={key}><dt className="text-xs text-slate-500">{t('fields.'+key)}</dt><dd className="mt-1 break-words text-sm">{value}</dd></div>)}</dl></div>
  <div className="space-y-3"><h3 className="font-semibold">{t('process.balance')}</h3><p className="max-w-3xl text-sm text-slate-500">{t('process.balanceNote')}</p>
   <PagedTable source="manufacturing_record_rows" rows={data.sections.materialBalance??[]} columns={['unit','inputQuantity','outputQuantity','difference'].map(key=>({key,header:t('fields.'+key),cell:(row:ManufacturingRow)=>key==='unit'?String(row[key]):quantity(row[key]),search:(row:ManufacturingRow)=>String(row[key])}))} rowKey={row=>row.id} empty={<EmptyState title={t('process.empty')} description={t('process.emptyNote')}/>}/>
  </div><div className="rounded-xl border p-4"><h3 className="text-sm font-semibold">{t('process.carryover')}</h3><p className="mt-2 max-w-3xl text-sm text-slate-500">{t('process.carryoverNote')}</p><div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" onClick={()=>onOpen('receipts')}>{t('tabs.receipts')}</Button><Button variant="outline" onClick={()=>onOpen('issues')}>{t('tabs.issues')}</Button></div></div>
 </div>;
}
