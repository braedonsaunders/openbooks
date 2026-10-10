'use client'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { Clock, ListChecks, Package } from 'lucide-react'
import { RecordKindCard } from '@/components/record-kind-cards'
import type { OperatingProfileDefinition } from '@openbooks/engine/src/organization/operating-profile-model.ts'

/** Shortcuts reuse the current project, native timesheet and existing transaction editors. */
export function ProjectWorkJourney({definition,quickTimeHref,hours,onTime,onCharge,onBreakdown}:{
  definition:OperatingProfileDefinition;quickTimeHref:string|null;hours:number;
  onTime?:()=>void;onCharge?:()=>void;onBreakdown?:()=>void;
}) {
  const t=useTranslations('operatingProfiles.workJourney'),locale=useLocale();
  return <section className="space-y-3 rounded-xl border border-teal-200 bg-teal-50/40 p-4 dark:border-teal-900 dark:bg-teal-950/20">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{definition.terminology.singular}</h3><p className="mt-1 max-w-2xl text-sm text-slate-500">{t('description')}</p></div>{quickTimeHref?<Button asChild size="sm"><Link href={quickTimeHref as never}>{t('recordTime')}</Link></Button>:null}</div>
    <div className="grid gap-3 sm:grid-cols-3">
      {onTime?<RecordKindCard compact label={t('time')} description={t('hours',{hours:hours.toLocaleString(locale,{maximumFractionDigits:4})})} icon={<Clock className="h-4 w-4" aria-hidden/>} onChoose={onTime}/>:null}
      {definition.presentation.showMaterials&&onCharge?<RecordKindCard compact label={t('costs')} description={t('costsNote')} icon={<Package className="h-4 w-4" aria-hidden/>} onChoose={onCharge}/>:null}
      {onBreakdown?<RecordKindCard compact label={t('breakdown')} description={t('breakdownNote')} icon={<ListChecks className="h-4 w-4" aria-hidden/>} onChoose={onBreakdown}/>:null}
    </div>
  </section>;
}
