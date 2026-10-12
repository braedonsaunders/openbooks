import { db } from '@openbooks/engine/platform/db'
import { sql } from 'drizzle-orm'
import { subsidiaryVisibleFilter } from '@openbooks/engine/organization/scope'
import { can } from '../authz-core'
import 'server-only'
import { page,pageHeader,filterBar,ref,widget,widgetBlock,type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../authz'
import { parseReportQuery } from '../report-filters'
import { resolvePeriod } from '../periods'
import { reportBookSelection } from '../report-books'
import { orgBranding } from '../report-pdf'
import { journalMeasurementExportData } from '../journal-measurement-reports'
import { getTranslations } from 'next-intl/server'

export async function loadJournalMeasurementReport(kind: 'statistical-journal' | 'gl-audit-numbers',sp: Record<string,string|undefined>) {
  const authz = await requirePermission('gl.read')
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period,{customFrom:q.from,customTo:q.to,orgId:authz.user.orgId})
  const { books, selectedBook } = await reportBookSelection(authz.user.orgId,sp.book)
  const [paper,branding,t] = await Promise.all([
    journalMeasurementExportData(kind,{orgId:authz.user.orgId,allowedSubsidiaryIds:authz.allowedSubsidiaryIds,from:period.from,to:period.to,label:period.label,bookId:selectedBook.id}),
    orgBranding(authz.user.orgId),getTranslations('reports'),
  ])
  const periods = (await db.execute<{value:string;label:string}>(sql`select id as value,name as label from accounting_periods where org_id=${authz.user.orgId} and starts_on<=${period.to}::date and ends_on>=${period.from}::date order by starts_on desc,period_number`)).rows
  const entities = (await db.execute<{value:string;label:string}>(sql`select id as value,name as label from subsidiaries where org_id=${authz.user.orgId} and is_active ${subsidiaryVisibleFilter(sql`id`,authz.allowedSubsidiaryIds)} order by name`)).rows
  return {periods,entities,canAllocate:kind==='gl-audit-numbers' && can(authz,'close.run'),bookLabel:t('journalMeasurements.book'),kind,paper,branding,title:paper.title,back:t('hub.title'),empty:t('journalMeasurements.empty'),sp,books,selectedBook,
    primaryFilter:{paramKey:'book',label:t('journalMeasurements.book'),value:selectedBook.id,options:books.map(book=>({value:book.id,label:book.name}))}}
}
const f = ref<Awaited<ReturnType<typeof loadJournalMeasurementReport>>>()
export function journalMeasurementReportSpec(data: Awaited<ReturnType<typeof loadJournalMeasurementReport>>): PageSpec {
  return page({route:`/reports/${data.kind}`,layout:'list',header:[
    pageHeader({title:data.title,back:{href:'/reports',label:data.back}}),
    filterBar({period:true},{actions:[widget('save-view'),widget('export-menu',{kind:data.kind,params:data.sp})],
      primaryFilter:f('primaryFilter')}),
    ...(data.canAllocate ? [widgetBlock('gl-audit-number-command',{bookId:data.selectedBook.id,periods:data.periods,entities:data.entities})] : []),
  ],body:[widgetBlock('paper-view',{company:data.branding.orgName,currency:data.branding.baseCurrency,emptyLabel:data.empty,data:{...data.paper,periodPhrase:data.paper.dateRangeLabel}})]})
}
