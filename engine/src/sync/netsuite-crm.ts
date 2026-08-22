import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '../db.ts'
import { unsealJson } from '../secrets.ts'
import { netsuiteRecord, netsuiteRecords, suiteql, type NetSuiteCreds } from '../netsuite.ts'
import { ensureCrmDefaults } from '../crm.ts'
import { canonicalDecimal } from '../../../web/lib/exact-decimal.ts'
import { normalizeMoney } from '../money.ts'

export interface CrmImportReport {
  accountStatuses: number
  accounts: number
  missingParties: number
  opportunities: number
  opportunityLines: number
  activities: Record<string, number>
  sourceNoteLinks: number
  warnings: string[]
}

type NsRef = { id?: string | number; refName?: string }
type NsRecord = Record<string, unknown> & { id?: string | number }

export interface NetSuiteRecentActivityNoteRow {
  id: string
  entity?: string
  type?: string
  typecode?: string
  createddate?: string
  lastmodifieddate?: string
  details?: string
  subdetails?: string
}

export interface NormalizedNetSuiteRecentActivityNote {
  sourceId: string
  kind: 'call' | 'event' | 'note'
  subject: string
  body: string | null
  occurredAt: string | null
  accountSourceId: string | null
  metadata: Record<string, unknown>
}

const sourceText = (value: unknown): string | null => {
  const valueText = value == null ? '' : String(value).trim()
  return valueText || null
}

/** Persist a NetSuite CRM opportunity amount through exact decimal then ledger money. Fail closed. */
function persistSyncLineMoney(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4)
  if (exact === null) throw new Error(`${label} must be an exact decimal`)
  try {
    return normalizeMoney(exact)
  } catch {
    throw new Error(`${label} must be an exact decimal`)
  }
}

function sourceTimestamp(dateValue: unknown, timeValue?: unknown): string | null {
  const day = date(dateValue)
  if (!day) return null
  const timeText = sourceText(timeValue)
  if (!timeText) return day
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(timeText)
  if (!match) return day
  let hour = Number(match[1])
  const suffix = match[4]?.toLowerCase()
  if (suffix === 'pm' && hour < 12) hour += 12
  if (suffix === 'am' && hour === 12) hour = 0
  if (hour > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59) return day
  return `${day}T${String(hour).padStart(2, '0')}:${match[2]}:${match[3] ?? '00'}Z`
}

function recentActivityKind(row: NetSuiteRecentActivityNoteRow): NormalizedNetSuiteRecentActivityNote['kind'] | 'email' {
  const sourceType = sourceText(row.typecode) ?? sourceText(row.type) ?? 'Note'
  const searchable = `${sourceType} ${row.details ?? ''} ${row.subdetails ?? ''}`.toLowerCase()
  if (sourceType === 'Note : 9' || /\b(meet|meeting|visit|site tour|plant tour|delivered|delivery|parking lot)\b/.test(searchable)) return 'event'
  if (/\b(call|called|phone|voicemail|voice mail|vm)\b/.test(searchable)) return 'call'
  if (/\b(email|emailed|e-mail)\b/.test(searchable)) return 'email'
  return 'note'
}

export function isNetSuiteRecentActivityEmail(row: NetSuiteRecentActivityNoteRow): boolean {
  return recentActivityKind(row) === 'email'
}

/** RecentActivity is the only analytics surface that exposes source note text and note type. */
export function normalizeNetSuiteRecentActivityNote(row: NetSuiteRecentActivityNoteRow): NormalizedNetSuiteRecentActivityNote | null {
  const sourceId = sourceText(row.id)
  const body = sourceText(row.subdetails)
  const rawSubject = sourceText(row.details)
  if (!sourceId || (!body && !rawSubject) || isNetSuiteRecentActivityEmail(row)) return null
  const sourceType = sourceText(row.typecode) ?? sourceText(row.type) ?? 'Note'
  const kind = recentActivityKind(row) as NormalizedNetSuiteRecentActivityNote['kind']
  const generatedSubject = rawSubject && /^Note\s*-\s*\d{4}-\d{2}-\d{2}/i.test(rawSubject) ? null : rawSubject
  return {
    sourceId,
    kind,
    subject: generatedSubject ?? body?.slice(0, 120) ?? 'Note',
    body,
    occurredAt: sourceTimestamp(row.createddate),
    accountSourceId: sourceText(row.entity),
    metadata: {
      id: sourceId,
      recordType: 'recentActivityNote',
      sourceType,
      lastModifiedAt: sourceText(row.lastmodifieddate),
    },
  }
}

/** Resolve a source currency reference only to an ISO currency configured by the application. */
export function resolveNetSuiteCrmCurrency(
  sourceValue: unknown,
  baseCurrency: string,
  sourceCurrencyById: ReadonlyMap<string, string>,
  configuredCurrencies: ReadonlySet<string>,
): string | null {
  const sourceId = sourceText(sourceValue)
  const code = sourceId ? sourceCurrencyById.get(sourceId) ?? sourceId.toUpperCase() : baseCurrency.toUpperCase()
  return /^[A-Z]{3}$/.test(code) && configuredCurrencies.has(code) ? code : null
}

async function credentials(orgId: string, connectionId?: string): Promise<NetSuiteCreds & { probabilityField?: string }> {
  const row = (await db.execute<{ config: Record<string, unknown>; secrets: string }>(sql`
    select config, secrets from connections where org_id=${orgId} and source='netsuite'
      ${connectionId ? sql`and id=${connectionId}` : sql``}
    order by status='active' desc, created_at desc limit 1`))
  const connection = row.rows[0]
  if (!connection) throw new Error('No tenant NetSuite connection exists')
  const secret = unsealJson<Partial<NetSuiteCreds>>(connection.secrets)
  if (!secret?.consumerKey || !secret.consumerSecret || !secret.tokenKey || !secret.tokenSecret || !connection.config.account || !connection.config.host) {
    throw new Error('The tenant NetSuite connection is missing credentials')
  }
  const mappings = (connection.config.mappingJson ?? {}) as Record<string, unknown>
  return { account: String(connection.config.account), host: String(connection.config.host), consumerKey: secret.consumerKey, consumerSecret: secret.consumerSecret, tokenKey: secret.tokenKey, tokenSecret: secret.tokenSecret,
    probabilityField: typeof mappings.crmProbabilityField === "string" ? mappings.crmProbabilityField : undefined }
}

function date(value: unknown): string | null {
  if (!value) return null
  const text = String(value)
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text)
  return us ? `${us[3]}-${us[1]}-${us[2]}` : text
}

function stage(value: unknown): 'lead' | 'prospect' | 'customer' {
  const normalized = String(value ?? '').toLowerCase()
  return normalized === 'lead' ? 'lead' : normalized === 'prospect' ? 'prospect' : 'customer'
}

function refId(value: unknown): string | null {
  if (value && typeof value === 'object' && 'id' in value) return String((value as NsRef).id ?? '') || null
  return value == null || value === '' ? null : String(value)
}

async function activityPartyBySourceId(orgId: string): Promise<Map<string, string>> {
  const parties = (await db.execute<{ id: string; source_id: string }>(sql`
    select id,custom->>'nsId' source_id
      from parties
     where org_id=${orgId} and custom->>'nsId' is not null`))
  return new Map(parties.rows.map((row) => [row.source_id, row.id]))
}

function batches<T>(rows: T[], size = 500): T[][] {
  const result: T[][] = []
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size))
  return result
}

async function importRecentActivityNotes(orgId: string, actorId: string, creds: NetSuiteCreds, report: CrmImportReport) {
  const rows = await suiteql<NetSuiteRecentActivityNoteRow>(`
    select ra.id,ra.entity,ra.type,ra.typecode,ra.createddate,ra.lastmodifieddate,ra.details,ra.subdetails
      from recentactivity ra
     where ra.type like 'Note :%'`, creds)
  const partyBySourceId = await activityPartyBySourceId(orgId)
  const existingRows = (await db.execute<{ id: string; source_id: string }>(sql`
    select id,custom->'netsuite'->>'id' source_id
      from crm_activities
     where org_id=${orgId} and custom->'netsuite'->>'recordType'='recentActivityNote'`))
  const existingBySourceId = new Map(existingRows.rows.map((row) => [row.source_id, row.id]))
  const activities: Array<{
    id: string; kind: NormalizedNetSuiteRecentActivityNote['kind']; subject: string; body: string | null;
    occurredAt: string | null; custom: Record<string, unknown>
  }> = []
  const links: Array<{ activityId: string; subjectKind: 'account'; subjectId: string }> = []
  let salesVisits = 0
  let skippedEmails = 0
  for (const row of rows) {
    if (isNetSuiteRecentActivityEmail(row)) {
      skippedEmails++
      continue
    }
    const activity = normalizeNetSuiteRecentActivityNote(row)
    if (!activity) continue
    const activityId = existingBySourceId.get(activity.sourceId) ?? randomUUID()
    existingBySourceId.set(activity.sourceId, activityId)
    activities.push({ id: activityId, kind: activity.kind, subject: activity.subject, body: activity.body, occurredAt: activity.occurredAt, custom: { netsuite: activity.metadata } })
    const partyId = activity.accountSourceId ? partyBySourceId.get(activity.accountSourceId) : null
    if (partyId) links.push({ activityId, subjectKind: 'account', subjectId: partyId })
    if (activity.metadata.sourceType === 'Note : 9') salesVisits++
  }
  for (const batch of batches(activities)) {
    await db.execute(sql`
      insert into crm_activities(id,org_id,kind,status,subject,body,starts_at,completed_at,custom,created_by,updated_by)
      select x.id,${orgId},x.kind,'completed',x.subject,x.body,x."occurredAt",x."occurredAt",x.custom,${actorId},${actorId}
        from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
          as x(id uuid,kind text,subject text,body text,"occurredAt" timestamptz,custom jsonb)
      on conflict(id) do update set
        kind=excluded.kind,status='completed',subject=excluded.subject,body=excluded.body,
        starts_at=excluded.starts_at,completed_at=excluded.completed_at,
        custom=crm_activities.custom||excluded.custom,updated_at=now(),updated_by=${actorId}
      where crm_activities.org_id=${orgId}`)
  }
  for (const batch of batches(links, 1000)) {
    await db.execute(sql`
      insert into crm_activity_links(org_id,activity_id,subject_kind,subject_id,created_by,updated_by)
      select ${orgId},x."activityId",x."subjectKind",x."subjectId",${actorId},${actorId}
        from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
          as x("activityId" uuid,"subjectKind" text,"subjectId" uuid)
      on conflict(activity_id,subject_kind,subject_id) do nothing`)
  }
  await db.execute(sql`
    update crm_account_profiles cp
       set last_activity_at=greatest(coalesce(cp.last_activity_at,'-infinity'::timestamptz),recent.latest),
           updated_at=now(),updated_by=${actorId}
      from (
        select l.subject_id party_id,max(a.starts_at) latest
          from crm_activity_links l join crm_activities a on a.id=l.activity_id and a.org_id=l.org_id
         where l.org_id=${orgId} and l.subject_kind='account'
           and a.custom->'netsuite'->>'recordType'='recentActivityNote' and a.starts_at is not null
         group by l.subject_id
      ) recent
     where cp.org_id=${orgId} and cp.party_id=recent.party_id`)
  report.activities.recentActivityNote = activities.length
  report.activities.recentActivityNoteSource = rows.length
  report.activities.skippedEmail = skippedEmails
  report.activities.salesVisit = salesVisits
}

async function importNativeActivities(orgId: string, actorId: string, creds: NetSuiteCreds, report: CrmImportReport) {
  const kinds = [{ type: 'task', kind: 'task', reportKey: 'task' }, { type: 'phoneCall', kind: 'call', reportKey: 'phoneCall' }, { type: 'calendarEvent', kind: 'event', reportKey: 'calendarEvent' }, { type: 'note', kind: 'note', reportKey: 'nativeNote' }] as const
  for (const source of kinds) {
    try {
      const collection = await netsuiteRecords<NsRecord>(source.type, creds)
      let imported = 0
      for (const summary of collection) {
        if (summary.id == null) continue
        const record = await netsuiteRecord<NsRecord>(source.type, summary.id, creds)
        const subject = String(record.title ?? record.subject ?? record.memo ?? '').trim()
        const body = String(record.message ?? record.note ?? record.comments ?? '').trim() || null
        if (!subject && !body) continue
        const nsId = String(summary.id)
        const accountNsId = refId(record.company ?? record.entity ?? record.customer)
        const party = accountNsId ? (await db.execute<{ id: string }>(sql`select id from parties where org_id=${orgId} and custom->>'nsId'=${accountNsId} limit 1`)).rows[0] : null
        const statusText = String((record.status as NsRef)?.refName ?? record.status ?? '').toLowerCase()
        const status = statusText.includes('complete') ? 'completed' : statusText.includes('cancel') ? 'cancelled' : 'planned'
        const existing = (await db.execute<{ id: string }>(sql`select id from crm_activities where org_id=${orgId} and custom->'netsuite'->>'id'=${nsId} and custom->'netsuite'->>'recordType'=${source.type}`))
        const result = existing.rows[0]
          ? await db.execute(sql`update crm_activities set kind=${source.kind},status=${status},subject=${subject || body!.slice(0,120)},body=${body},starts_at=${date(record.startDate ?? record.start)},ends_at=${date(record.endDate ?? record.end)},due_at=${date(record.dueDate)},completed_at=${status === 'completed' ? date(record.completedDate ?? record.endDate) : null},updated_at=now(),updated_by=${actorId} where id=${existing.rows[0].id} and org_id=${orgId} returning id`)
          : await db.execute(sql`insert into crm_activities(org_id,kind,status,subject,body,starts_at,ends_at,due_at,completed_at,custom,created_by,updated_by) values(${orgId},${source.kind},${status},${subject || body!.slice(0,120)},${body},${date(record.startDate ?? record.start)},${date(record.endDate ?? record.end)},${date(record.dueDate)},${status === 'completed' ? date(record.completedDate ?? record.endDate) : null},${JSON.stringify({ netsuite: { id: nsId, recordType: source.type } })}::jsonb,${actorId},${actorId}) returning id`)
        const activityId = (result as unknown as { rows: { id: string }[] }).rows[0]!.id
        if (party) await db.execute(sql`insert into crm_activity_links(org_id,activity_id,subject_kind,subject_id,created_by,updated_by) values(${orgId},${activityId},'account',${party.id},${actorId},${actorId}) on conflict(activity_id,subject_kind,subject_id) do nothing`)
        imported++
      }
      report.activities[source.reportKey] = imported
    } catch (error) {
      report.activities[source.reportKey] = 0
      report.warnings.push(`${source.type}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Idempotent CRM import from the tenant's stored NetSuite connection. */
export async function importNetSuiteCrm(orgId: string, connectionId?: string): Promise<CrmImportReport> {
  const enabled = (await db.execute<{ enabled: boolean }>(sql`
    select coalesce((settings->'features'->>'crm')::boolean, true) as enabled
      from orgs where id = ${orgId}`))
  if (enabled.rows[0]?.enabled !== true) throw new Error('CRM feature is disabled')
  const creds = await credentials(orgId, connectionId)
  const actor = (await db.execute<{ id: string }>(sql`select id from users where org_id=${orgId} and is_active order by role='controller' desc, created_at limit 1`))
  const actorId = actor.rows[0]?.id
  if (!actorId) throw new Error('The tenant needs an active user before CRM data can be imported')
  await ensureCrmDefaults(orgId, actorId)
  const report: CrmImportReport = { accountStatuses: 0, accounts: 0, missingParties: 0, opportunities: 0, opportunityLines: 0, activities: {}, sourceNoteLinks: 0, warnings: [] }

  const statuses = await suiteql<{ key: string; name: string; entitytype: string; probability?: string; inactive?: string }>(`select key,name,entitytype,probability,inactive from entitystatus where entitytype in ('LEAD','PROSPECT','CUSTOMER')`, creds)
  const statusIds = new Map<string, string>()
  for (const source of statuses) {
    const lifecycle = stage(source.entitytype)
    const saved = (await db.execute<{ id: string }>(sql`insert into crm_account_statuses(org_id,lifecycle_stage,key,name,sequence,is_qualified,is_active,created_by,updated_by) values(${orgId},${lifecycle},${`netsuite_${source.key}`},${source.name},100,${lifecycle !== 'lead'},${source.inactive !== 'T'},${actorId},${actorId}) on conflict(org_id,lifecycle_stage,key) do update set name=excluded.name,is_qualified=excluded.is_qualified,is_active=excluded.is_active,updated_at=now(),updated_by=${actorId} where crm_account_statuses.org_id=${orgId} returning id`))
    statusIds.set(`${lifecycle}:${source.key}`, saved.rows[0]!.id)
    report.accountStatuses++
  }

  // An account may expose a custom qualification-probability field; a stock
  // NetSuite has none. SuiteQL errors on an unknown identifier, so only select
  // it when the connection maps one, and fall back to the standard `probability`.
  const probField = typeof (creds as { probabilityField?: string }).probabilityField === "string"
    && /^[a-z0-9_]+$/i.test((creds as { probabilityField?: string }).probabilityField!)
      ? (creds as { probabilityField?: string }).probabilityField!
      : undefined
  const probCol = probField ? `,${probField}` : ""
  const customers = await suiteql<{ id:string; stage:string; entitystatus?:string; probability?:string; dateprospect?:string; dateclosed?:string; datecreated?:string }>(`select id,stage,entitystatus,probability${probCol}, dateprospect,dateclosed,datecreated from customer`, creds)
  for (const customer of customers) {
    const lifecycle = stage(customer.stage)
    const party = (await db.execute<{ id: string }>(sql`select id from parties where org_id=${orgId} and custom->>'nsId'=${customer.id} limit 1`))
    if (!party.rows[0]) { report.missingParties++; continue }
    const scoreText = (probField ? (customer as Record<string, string | undefined>)[probField] : undefined) ?? customer.probability
    const score = scoreText == null || scoreText === '' ? null : Math.max(0, Math.min(100, Math.round(Number(scoreText))))
    const statusId = customer.entitystatus ? statusIds.get(`${lifecycle}:${customer.entitystatus}`) ?? null : null
    const saved = (await db.execute<{ id: string }>(sql`insert into crm_account_profiles(org_id,party_id,lifecycle_stage,status_id,qualification_score,qualified_at,converted_at,acquired_on,is_active,custom,created_by,updated_by) values(${orgId},${party.rows[0].id},${lifecycle},${statusId},${score},${lifecycle !== 'lead' ? date(customer.dateprospect ?? customer.datecreated) : null},${lifecycle === 'customer' ? date(customer.dateclosed ?? customer.datecreated) : null},${lifecycle === 'customer' ? date(customer.dateclosed ?? customer.datecreated) : null},true,${JSON.stringify({ netsuite: { id: customer.id, stage: customer.stage, statusId: customer.entitystatus } })}::jsonb,${actorId},${actorId}) on conflict(party_id) do update set lifecycle_stage=excluded.lifecycle_stage,status_id=excluded.status_id,qualification_score=excluded.qualification_score,qualified_at=coalesce(crm_account_profiles.qualified_at,excluded.qualified_at),converted_at=coalesce(crm_account_profiles.converted_at,excluded.converted_at),acquired_on=coalesce(crm_account_profiles.acquired_on,excluded.acquired_on),is_active=true,custom=crm_account_profiles.custom||excluded.custom,updated_at=now(),updated_by=${actorId} where crm_account_profiles.org_id=${orgId} returning id`))
    await db.execute(sql`insert into crm_account_stage_events(org_id,account_profile_id,to_stage,source_kind,reason,occurred_at,created_by,updated_by) select ${orgId},${saved.rows[0]!.id},${lifecycle},'import','Imported lifecycle from source',coalesce(${date(customer.dateclosed ?? customer.dateprospect ?? customer.datecreated)}::timestamptz,now()),${actorId},${actorId} where not exists(select 1 from crm_account_stage_events where org_id=${orgId} and account_profile_id=${saved.rows[0]!.id} and source_kind='import')`)
    report.accounts++
  }

  const noteLinks = await suiteql<{ id:string; entity:string }>('select id,entity from note', creds)
  report.sourceNoteLinks = noteLinks.length

  const opportunities = await suiteql<{ id:string; tranid:string; entity?:string; trandate?:string; duedate?:string; status?:string; currency?:string; foreigntotal?:string; memo?:string }>(`select id,tranid,entity,trandate,duedate,status,currency,foreigntotal,memo from transaction where type='Opprtnty'`, creds)
  const [defaultStatusResult, orgResult, configuredCurrencyResult] = await Promise.all([
    db.execute<{ id: string }>(sql`select id from crm_opportunity_statuses where org_id=${orgId} and is_default order by sequence limit 1`),
    db.execute<{ base_currency: string }>(sql`select base_currency from orgs where id=${orgId}`),
    db.execute<{ code: string }>(sql`select code from currencies`),
  ])
  const defaultStatus = defaultStatusResult.rows[0]
  const baseCurrency = orgResult.rows[0]?.base_currency
  if (!baseCurrency) throw new Error('The tenant must have a configured base currency before CRM opportunities can be imported')
  const configuredCurrencies = new Set(configuredCurrencyResult.rows.map((row) => row.code.toUpperCase()))
  const sourceCurrencyById = new Map<string, string>()
  try {
    const sourceCurrencies = await suiteql<{ id: string; symbol?: string }>('select id,symbol from currency', creds)
    for (const currency of sourceCurrencies) {
      const code = sourceText(currency.symbol)?.toUpperCase()
      if (code && /^[A-Z]{3}$/.test(code)) sourceCurrencyById.set(String(currency.id), code)
    }
  } catch {
    // Single-currency source accounts do not expose this record; null transaction
    // currencies resolve to the tenant's configured base currency below.
  }
  for (const opportunity of opportunities) {
    const party = opportunity.entity ? (await db.execute<{ id: string }>(sql`select id from parties where org_id=${orgId} and custom->>'nsId'=${opportunity.entity} limit 1`)).rows[0] : null
    if (!party || !defaultStatus) continue
    const currency = resolveNetSuiteCrmCurrency(opportunity.currency, baseCurrency, sourceCurrencyById, configuredCurrencies)
    if (!currency) {
      report.warnings.push(`Opportunity ${opportunity.tranid || opportunity.id} was skipped because source currency ${opportunity.currency ?? '(blank)'} does not resolve to a configured ISO currency.`)
      continue
    }
    await db.execute(sql`insert into crm_opportunities(org_id,opportunity_number,title,party_id,status_id,expected_close_date,currency,projected_amount,weighted_amount,description,is_active,custom,created_by,updated_by) values(${orgId},${opportunity.tranid || `NS-${opportunity.id}`},${opportunity.memo || opportunity.tranid || `NS-${opportunity.id}`},${party.id},${defaultStatus.id},${date(opportunity.duedate)},${currency},${persistSyncLineMoney(opportunity.foreigntotal || '0', 'projected_amount')},${normalizeMoney(0)},${opportunity.memo ?? null},true,${JSON.stringify({ netsuite: { id: opportunity.id } })}::jsonb,${actorId},${actorId}) on conflict(org_id,opportunity_number) do update set title=excluded.title,party_id=excluded.party_id,expected_close_date=excluded.expected_close_date,currency=excluded.currency,projected_amount=excluded.projected_amount,description=excluded.description,custom=crm_opportunities.custom||excluded.custom,updated_at=now(),updated_by=${actorId} where crm_opportunities.org_id=${orgId}`)
    report.opportunities++
  }
  await importRecentActivityNotes(orgId, actorId, creds, report)
  if (report.activities.recentActivityNoteSource !== report.sourceNoteLinks) {
    report.warnings.push(`Source note coverage: the note-link table contains ${report.sourceNoteLinks} rows, while RecentActivity exposes ${report.activities.recentActivityNoteSource ?? 0} typed notes with activity content. Link-only rows without activity content were not fabricated as CRM activities.`)
  }
  await importNativeActivities(orgId, actorId, creds, report)
  return report
}
