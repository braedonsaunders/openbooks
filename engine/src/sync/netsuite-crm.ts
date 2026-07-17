import { sql } from 'drizzle-orm'
import { db } from '../db.ts'
import { unsealJson } from '../secrets.ts'
import { netsuiteRecord, netsuiteRecords, suiteql, type NetSuiteCreds } from '../netsuite.ts'
import { ensureCrmDefaults } from '../crm.ts'

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

async function credentials(orgId: string, connectionId?: string): Promise<NetSuiteCreds> {
  const row = (await db.execute(sql`
    select config, secrets from connections where org_id=${orgId} and source='netsuite'
      ${connectionId ? sql`and id=${connectionId}` : sql``}
    order by status='active' desc, created_at desc limit 1`)) as unknown as { rows: { config: Record<string, unknown>; secrets: string }[] }
  const connection = row.rows[0]
  if (!connection) throw new Error('No tenant NetSuite connection exists')
  const secret = unsealJson<Partial<NetSuiteCreds>>(connection.secrets)
  if (!secret?.consumerKey || !secret.consumerSecret || !secret.tokenKey || !secret.tokenSecret || !connection.config.account || !connection.config.host) {
    throw new Error('The tenant NetSuite connection is missing credentials')
  }
  return { account: String(connection.config.account), host: String(connection.config.host), consumerKey: secret.consumerKey, consumerSecret: secret.consumerSecret, tokenKey: secret.tokenKey, tokenSecret: secret.tokenSecret }
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

async function importNativeActivities(orgId: string, actorId: string, creds: NetSuiteCreds, report: CrmImportReport) {
  const kinds = [{ type: 'task', kind: 'task' }, { type: 'phoneCall', kind: 'call' }, { type: 'calendarEvent', kind: 'event' }, { type: 'note', kind: 'note' }] as const
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
        const party = accountNsId ? (await db.execute(sql`select id from parties where org_id=${orgId} and custom->>'nsId'=${accountNsId} limit 1`) as unknown as { rows: { id: string }[] }).rows[0] : null
        const statusText = String((record.status as NsRef)?.refName ?? record.status ?? '').toLowerCase()
        const status = statusText.includes('complete') ? 'completed' : statusText.includes('cancel') ? 'cancelled' : 'planned'
        const existing = (await db.execute(sql`select id from crm_activities where org_id=${orgId} and custom->'netsuite'->>'id'=${nsId} and custom->'netsuite'->>'recordType'=${source.type}`)) as unknown as { rows: { id: string }[] }
        const result = existing.rows[0]
          ? await db.execute(sql`update crm_activities set kind=${source.kind},status=${status},subject=${subject || body!.slice(0,120)},body=${body},starts_at=${date(record.startDate ?? record.start)},ends_at=${date(record.endDate ?? record.end)},due_at=${date(record.dueDate)},completed_at=${status === 'completed' ? date(record.completedDate ?? record.endDate) : null},updated_at=now(),updated_by=${actorId} where id=${existing.rows[0].id} returning id`)
          : await db.execute(sql`insert into crm_activities(org_id,kind,status,subject,body,starts_at,ends_at,due_at,completed_at,custom,created_by,updated_by) values(${orgId},${source.kind},${status},${subject || body!.slice(0,120)},${body},${date(record.startDate ?? record.start)},${date(record.endDate ?? record.end)},${date(record.dueDate)},${status === 'completed' ? date(record.completedDate ?? record.endDate) : null},${JSON.stringify({ netsuite: { id: nsId, recordType: source.type } })}::jsonb,${actorId},${actorId}) returning id`)
        const activityId = (result as unknown as { rows: { id: string }[] }).rows[0]!.id
        if (party) await db.execute(sql`insert into crm_activity_links(org_id,activity_id,subject_kind,subject_id,created_by,updated_by) values(${orgId},${activityId},'account',${party.id},${actorId},${actorId}) on conflict(activity_id,subject_kind,subject_id) do nothing`)
        imported++
      }
      report.activities[source.type] = imported
    } catch (error) {
      report.activities[source.type] = 0
      report.warnings.push(`${source.type}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Idempotent CRM import from the tenant's stored NetSuite connection. */
export async function importNetSuiteCrm(orgId: string, connectionId?: string): Promise<CrmImportReport> {
  const creds = await credentials(orgId, connectionId)
  const actor = (await db.execute(sql`select id from users where org_id=${orgId} and is_active order by role='controller' desc, created_at limit 1`)) as unknown as { rows: { id: string }[] }
  const actorId = actor.rows[0]?.id
  if (!actorId) throw new Error('The tenant needs an active user before CRM data can be imported')
  await ensureCrmDefaults(orgId, actorId)
  const report: CrmImportReport = { accountStatuses: 0, accounts: 0, missingParties: 0, opportunities: 0, opportunityLines: 0, activities: {}, sourceNoteLinks: 0, warnings: [] }

  const statuses = await suiteql<{ key: string; name: string; entitytype: string; probability?: string; inactive?: string }>(`select key,name,entitytype,probability,inactive from entitystatus where entitytype in ('LEAD','PROSPECT','CUSTOMER')`, creds)
  const statusIds = new Map<string, string>()
  for (const source of statuses) {
    const lifecycle = stage(source.entitytype)
    const saved = (await db.execute(sql`insert into crm_account_statuses(org_id,lifecycle_stage,key,name,sequence,is_qualified,is_active,created_by,updated_by) values(${orgId},${lifecycle},${`netsuite_${source.key}`},${source.name},100,${lifecycle !== 'lead'},${source.inactive !== 'T'},${actorId},${actorId}) on conflict(org_id,lifecycle_stage,key) do update set name=excluded.name,is_qualified=excluded.is_qualified,is_active=excluded.is_active,updated_at=now(),updated_by=${actorId} returning id`)) as unknown as { rows: { id: string }[] }
    statusIds.set(`${lifecycle}:${source.key}`, saved.rows[0]!.id)
    report.accountStatuses++
  }

  const customers = await suiteql<{ id:string; stage:string; entitystatus?:string; probability?:string; custentity_atlas_customer_probability?:string; dateprospect?:string; dateclosed?:string; datecreated?:string }>(`select id,stage,entitystatus,probability,custentity_atlas_customer_probability,dateprospect,dateclosed,datecreated from customer`, creds)
  for (const customer of customers) {
    const lifecycle = stage(customer.stage)
    const party = (await db.execute(sql`select id from parties where org_id=${orgId} and custom->>'nsId'=${customer.id} limit 1`)) as unknown as { rows: { id: string }[] }
    if (!party.rows[0]) { report.missingParties++; continue }
    const scoreText = customer.custentity_atlas_customer_probability ?? customer.probability
    const score = scoreText == null || scoreText === '' ? null : Math.max(0, Math.min(100, Math.round(Number(scoreText))))
    const statusId = customer.entitystatus ? statusIds.get(`${lifecycle}:${customer.entitystatus}`) ?? null : null
    const saved = (await db.execute(sql`insert into crm_account_profiles(org_id,party_id,lifecycle_stage,status_id,qualification_score,qualified_at,converted_at,acquired_on,is_active,custom,created_by,updated_by) values(${orgId},${party.rows[0].id},${lifecycle},${statusId},${score},${lifecycle !== 'lead' ? date(customer.dateprospect ?? customer.datecreated) : null},${lifecycle === 'customer' ? date(customer.dateclosed ?? customer.datecreated) : null},${lifecycle === 'customer' ? date(customer.dateclosed ?? customer.datecreated) : null},true,${JSON.stringify({ netsuite: { id: customer.id, stage: customer.stage, statusId: customer.entitystatus } })}::jsonb,${actorId},${actorId}) on conflict(party_id) do update set lifecycle_stage=excluded.lifecycle_stage,status_id=excluded.status_id,qualification_score=excluded.qualification_score,qualified_at=coalesce(crm_account_profiles.qualified_at,excluded.qualified_at),converted_at=coalesce(crm_account_profiles.converted_at,excluded.converted_at),acquired_on=coalesce(crm_account_profiles.acquired_on,excluded.acquired_on),is_active=true,custom=crm_account_profiles.custom||excluded.custom,updated_at=now(),updated_by=${actorId} returning id`)) as unknown as { rows: { id: string }[] }
    await db.execute(sql`insert into crm_account_stage_events(org_id,account_profile_id,to_stage,source_kind,reason,occurred_at,created_by,updated_by) select ${orgId},${saved.rows[0]!.id},${lifecycle},'import','Imported lifecycle from source',coalesce(${date(customer.dateclosed ?? customer.dateprospect ?? customer.datecreated)}::timestamptz,now()),${actorId},${actorId} where not exists(select 1 from crm_account_stage_events where account_profile_id=${saved.rows[0]!.id} and source_kind='import')`)
    report.accounts++
  }

  const noteLinks = await suiteql<{ id:string; entity:string }>('select id,entity from note', creds)
  report.sourceNoteLinks = noteLinks.length
  if (noteLinks.length) report.warnings.push(`${noteLinks.length} source note links were found, but this SuiteTalk role exposes neither note text nor author/date fields; no empty or fabricated notes were created.`)

  const opportunities = await suiteql<{ id:string; tranid:string; entity?:string; trandate?:string; duedate?:string; status?:string; currency?:string; foreigntotal?:string; memo?:string }>(`select id,tranid,entity,trandate,duedate,status,currency,foreigntotal,memo from transaction where type='Opprtnty'`, creds)
  const defaultStatus = (await db.execute(sql`select id from crm_opportunity_statuses where org_id=${orgId} and is_default order by sequence limit 1`)) as unknown as { rows: { id: string }[] }
  for (const opportunity of opportunities) {
    const party = opportunity.entity ? (await db.execute(sql`select id from parties where org_id=${orgId} and custom->>'nsId'=${opportunity.entity} limit 1`) as unknown as { rows: { id: string }[] }).rows[0] : null
    if (!party || !defaultStatus.rows[0]) continue
    await db.execute(sql`insert into crm_opportunities(org_id,opportunity_number,title,party_id,status_id,expected_close_date,currency,projected_amount,weighted_amount,description,is_active,custom,created_by,updated_by) values(${orgId},${opportunity.tranid || `NS-${opportunity.id}`},${opportunity.memo || opportunity.tranid || `NS-${opportunity.id}`},${party.id},${defaultStatus.rows[0].id},${date(opportunity.duedate)},${opportunity.currency || 'CAD'},${opportunity.foreigntotal || '0'},0,${opportunity.memo ?? null},true,${JSON.stringify({ netsuite: { id: opportunity.id } })}::jsonb,${actorId},${actorId}) on conflict(org_id,opportunity_number) do update set title=excluded.title,party_id=excluded.party_id,expected_close_date=excluded.expected_close_date,currency=excluded.currency,projected_amount=excluded.projected_amount,description=excluded.description,custom=crm_opportunities.custom||excluded.custom,updated_at=now(),updated_by=${actorId}`)
    report.opportunities++
  }
  await importNativeActivities(orgId, actorId, creds, report)
  return report
}
