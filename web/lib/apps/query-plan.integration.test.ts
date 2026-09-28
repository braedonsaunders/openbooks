import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { compileCustomQuery, customRecordEntities, runCustomQuery, shapeSummarizedRows, summarizeRows, REPORT_ENTITY_MAP, type SummarizeRowsPlan } from '@openbooks/reports'
import { reportResultToCsv } from '@openbooks/office'
import { compileAppQuery, type AppQuerySource } from './query-plan'

const root = pathToFileURL(process.cwd() + '/').href

/** Session-local fixtures only: no tenant, persistent table, migration, or app record writes. */
test('native joined queries and custom reports preserve tenant scope, left joins, typed order and decimal totals', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const client = new pg.Client({connectionString:process.env.OPENBOOKS_DB_URL,connectionTimeoutMillis:5000})
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL search_path = pg_temp; SET LOCAL statement_timeout = '10s'")
    await client.query(`CREATE TEMP TABLE custom_records(id uuid,org_id text,type_id uuid,type_key text,record_number text,status text,data jsonb,created_at timestamptz,updated_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE parties(id uuid,org_id text,display_name text,subsidiary_id text) ON COMMIT DROP`)
    const type='00000000-0000-4000-8000-000000000001', party='00000000-0000-4000-8000-000000000002', missing='00000000-0000-4000-8000-000000000003'
    await client.query('INSERT INTO parties VALUES ($1, $2, $3, $4), ($5,$6,$7,$8)',[party,'A','Allowed person','visible',missing,'B','Foreign person','hidden'])
    for(const [n,org,hours,assigned] of [[1,'A','100',party],[2,'A','20',missing],[3,'B','999',party]] as const) {
      await client.query('INSERT INTO custom_records VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())',[
        `00000000-0000-4000-8000-${String(n+10).padStart(12,'0')}`,org,type,'work-order',`WO-${n}`,'active',JSON.stringify({hours,assignee:assigned,materials:[{quantity:'0.1'},{quantity:'0.2'}]})])
    }
    const sources=new Map<string,AppQuerySource>([
      ['work-order',{from:'custom_records r',orgColumn:'r.org_id',predicates:["r.type_key='work-order'"],columns:[{key:'hours',kind:'number',label:'Hours',expr:"(r.data->>'hours')::numeric"},{key:'assignee',kind:'uuid',label:'Assignee',expr:"(r.data->>'assignee')::uuid"}]}],
      ['parties',{from:'parties r',orgColumn:'r.org_id',predicates:["r.subsidiary_id='visible'"],columns:[{key:'id',kind:'uuid',label:'ID',expr:'r.id'},{key:'name',kind:'text',label:'Name',expr:'r.display_name'}]}],
    ])
    const plan={from:{type:'work-order',as:'w'},joins:[{type:'parties',as:'p',kind:'left',on:{left:{source:'w',field:'assignee'},right:{source:'p',field:'id'}}}],select:[{source:'w',field:'hours'},{source:'p',field:'name'}],sorts:[{column:'w.hours',direction:'asc'}],limit:10}
    const compiled=compileAppQuery(plan,sources,'A')
    const result=await client.query(compiled.text,compiled.values)
    assert.deepEqual(result.rows,[{'w.hours':'20','p.name':null},{'w.hours':'100','p.name':'Allowed person'}])
    const inner=compileAppQuery({...plan,joins:[{...plan.joins[0],kind:'inner'}]},sources,'A')
    assert.equal((await client.query(inner.text,inner.values)).rowCount,1)
    const [entity,lines]=customRecordEntities({id:type,key:'work-order',name:'Work orders',description:null,fields:[{id:'header',fields:[{id:'hours',label:'Hours',type:'number'}]},{id:'materials',repeating:true,fields:[{id:'quantity',type:'number'}]}]})
    assert.ok(entity&&lines)
    const query={entity:entity.key,mode:'summarize' as const,columns:[],measures:[{fn:'sum' as const,column:'field_hours'}]}
    const report=compileCustomQuery(entity,query,'A')
    assert.equal((await client.query(report.text,report.values)).rows[0].m0,'120')
    const output=await runCustomQuery(client,query,{entityMap:{[entity.key]:entity},orgId:'A'})
    assert.equal(String(output.groups[0]!.rows[0]![0]), '120')
    const detail=compileCustomQuery(lines,{entity:lines.key,mode:'summarize',columns:[],measures:[{fn:'sum',column:'line_quantity'}]},'A')
    assert.equal((await client.query(detail.text,detail.values)).rows[0].m0,'0.6')
  } finally { await client.query('ROLLBACK').catch(()=>{}); await client.end() }
})

type FixtureDocument = { kind: 'customer_invoice' | 'customer_payment'; posting_date: string; currency: 'CAD'; total: string }

/** Filtered hidden component measures, monthly formula 20.00%, undefined divide-by-zero label, grand 30.00%. */
test('filtered formula totals, undefined labels and CSV match the in-memory producer', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { db, pool, withBypassContext, withOrgContext } = await import(root + 'engine/src/platform/db.ts') as typeof import('@openbooks/engine/src/platform/db.ts')
  const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
  const { createScratchOrg, dropScratchOrg } = await import(root + 'engine/src/testing/fixtures.ts') as typeof import('@openbooks/engine/src/testing/fixtures.ts')
  const org = await withBypassContext(() => createScratchOrg())
  const documents: FixtureDocument[] = [
    { kind: 'customer_invoice', posting_date: '2026-01-12', currency: 'CAD', total: '100.0000' },
    { kind: 'customer_payment', posting_date: '2026-01-20', currency: 'CAD', total: '20.0000' },
    { kind: 'customer_payment', posting_date: '2026-02-10', currency: 'CAD', total: '10.0000' },
  ]
  const measures = [
    {
      fn: 'sum', key: 'collected', label: 'Collected', column: 'total', hidden: true,
      filter: { combinator: 'and', rules: [{ field: 'kind', op: 'eq', value: 'customer_payment' }] },
    },
    {
      fn: 'sum', key: 'billed', label: 'Billed', column: 'total', hidden: true,
      filter: { combinator: 'and', rules: [{ field: 'kind', op: 'eq', value: 'customer_invoice' }] },
    },
    {
      fn: 'formula', key: 'collection_rate', label: 'Collection rate', format: 'percent',
      expr: { op: '/', left: { ref: 'collected' }, right: { ref: 'billed' } },
    },
  ] as const
  const query = {
    entity: 'documents', mode: 'summarize', columns: [],
    breakouts: [{ column: 'posting_date', bin: 'month' }],
    groupBy: 'posting_date', totals: { grand: true },
    sorts: [{ column: 'collection_rate', direction: 'asc' }],
    filters: { combinator: 'and', rules: [{ field: 'currency', op: 'eq', value: 'CAD' }] },
    measures,
  }
  try {
    await withBypassContext(async () => {
      for (const [index, document] of documents.entries()) {
        const id = randomUUID()
        await db.execute(sql`
          insert into documents
            (id, org_id, subsidiary_id, kind, status, document_number, document_date, posting_date,
             currency, subtotal, tax_total, total)
          values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${document.kind}, 'draft',
                  ${`FORMULA-${index}-${id.slice(0, 8)}`}, ${document.posting_date}, ${document.posting_date},
                  ${document.currency}, ${document.total}, '0.0000', ${document.total})`)
      }
    })
    const sqlResult = await withOrgContext(org.orgId, () => runCustomQuery(pool, query, {
      orgId: org.orgId,
      entityMap: REPORT_ENTITY_MAP,
      allowedSubsidiaryIds: [org.subsidiaryId],
    }))
    const jan = sqlResult.groups.find((group) => group.title.endsWith('2026-01'))
    const feb = sqlResult.groups.find((group) => group.title.endsWith('2026-02'))
    const grand = sqlResult.groups.find((group) => group.title === 'Grand totals')
    assert.deepEqual(jan?.rows[0], ['20.00%'])
    assert.deepEqual(feb?.rows[0], ['Undefined — divides by zero'])
    assert.deepEqual(grand?.rows[0], ['30.00%'])
    assert.equal(feb?.undefinedCells?.[0]?.[0], 'Undefined — divides by zero')

    const inMemoryPlan: SummarizeRowsPlan = {
      entity: REPORT_ENTITY_MAP.documents!,
      breakouts: [{ column: 'posting_date', bin: 'month' as const }],
      groupBy: 'posting_date',
      totals: { grand: true },
      measures: [
        { fn: 'sum', key: 'collected', label: 'Collected', column: 'total', hidden: true, filter: (row: Readonly<Record<string, unknown>>) => row.kind === 'customer_payment' },
        { fn: 'sum', key: 'billed', label: 'Billed', column: 'total', hidden: true, filter: (row: Readonly<Record<string, unknown>>) => row.kind === 'customer_invoice' },
        { fn: 'formula', key: 'collection_rate', label: 'Collection rate', format: 'percent', expr: { op: '/', left: { ref: 'collected' }, right: { ref: 'billed' } } },
      ],
    }
    const shapedInMemory = shapeSummarizedRows(summarizeRows(documents, inMemoryPlan), inMemoryPlan, documents)
    assert.deepEqual(shapedInMemory, sqlResult)
    assert.equal(reportResultToCsv(sqlResult), reportResultToCsv(shapedInMemory))
    assert.match(reportResultToCsv(sqlResult), /Undefined — divides by zero/)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
