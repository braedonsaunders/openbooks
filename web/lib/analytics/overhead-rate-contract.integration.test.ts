import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'};
  if (specifier === '../money-server' && context.parentURL?.includes('/analytics/')) return {shortCircuit:true,url:'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}'};
  return next(specifier,context);
} });
const {sql}=await import('drizzle-orm');
const {db}=await import('@openbooks/engine/src/db.ts');
const {createScratchOrg,dropScratchOrg}=await import('@openbooks/engine/src/test-fixtures.ts');
const {trueCostData}=await import('./true-cost-data');
const {computeLiveOverheadRates}=await import('../overhead-publish');

interface SeedOpts {
  expenses: Array<{ number: string; name: string; amount: string; dept: boolean }>;
  hours: string[];
}

/**
 * One burden centre ("Operations"), billable hours on it, and dept-tagged
 * burden-pinned expense. Each expense account gets its own burden group so
 * tests can address per-category settings by group id.
 */
async function seedOverheadOrg(opts: SeedOpts) {
  const org=await createScratchOrg();
  const department=randomUUID(),employee=randomUUID(),project=randomUUID();
  await db.execute(sql`insert into departments(id,org_id,name) values (${department},${org.orgId},'Operations')`);
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'person','Worker',${org.subsidiaryId})`);
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active) values (${project},${org.orgId},${org.subsidiaryId},'OVH','Overhead seed',${org.customerId},'active',true)`);
  const groups: Array<{ account: string; group: string }> = [];
  for (const e of opts.expenses) {
    const account=randomUUID(),group=randomUUID();
    await db.execute(sql`insert into accounts(id,org_id,number,name,type) values (${account},${org.orgId},${e.number},${e.name},'expense')`);
    await db.execute(sql`insert into account_groups(id,org_id,dimension,key,name) values (${group},${org.orgId},'burden',${e.name},${e.name})`);
    await db.execute(sql`insert into account_group_members(org_id,group_id,account_id,dimension) values (${org.orgId},${group},${account},'burden')`);
    const entry=randomUUID();
    await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin) values (${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${entry},${org.date},${org.periodId},'draft','manual')`);
    await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,department_id,amount,currency,txn_amount,fx_rate) values
      (${org.orgId},${entry},1,${account},${org.subsidiaryId},${e.dept ? department : null},${e.amount},'CAD',${e.amount},1),
      (${org.orgId},${entry},2,${org.accounts.bank},${org.subsidiaryId},${e.dept ? department : null},-${e.amount}::numeric,'CAD',-${e.amount}::numeric,1)`);
    await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
    groups.push({ account, group });
  }
  for (const h of opts.hours) {
    await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,project_id,item_id,department_id,is_billable,cost_rate,status) values (${org.orgId},${employee},${org.date},${h},${project},${org.items.service},${department},true,4,'approved')`);
  }
  return { org, department, groups };
}

async function setTrueCostProfile(orgId: string, patch: Record<string, unknown>) {
  const current=(await db.execute<{ s: unknown }>(sql`select settings as s from orgs where id=${orgId}`)).rows[0]?.s as Record<string, unknown>;
  const analytics=((current['analytics'] ?? {}) as Record<string, unknown>);
  const trueCost=((analytics['trueCost'] ?? {}) as Record<string, unknown>);
  const profiles=(trueCost['profiles'] ?? [{ id: 'default' }]) as Array<Record<string, unknown>>;
  const next={ ...current, analytics: { ...analytics, trueCost: { ...trueCost, activeProfileId: 'default', profiles: profiles.map((p) => p.id === 'default' || profiles.length === 1 ? { ...p, id: 'default', ...patch } : p) } } };
  await db.execute(sql`update orgs set settings=${JSON.stringify(next)}::jsonb where id=${orgId}`);
}

test('auto-publish derives a repeating-decimal rate exactly (finding 6.5)',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const {org,department}=await seedOverheadOrg({
    expenses:[{number:'6601',name:'Office rent',amount:'100',dept:true}],
    hours:['1','1','1'],
  });
  try{
    const rates=await computeLiveOverheadRates(org.orgId);
    assert.deepEqual(rates,[{departmentId:department,ratePerHour:'33.33'}]);
  }finally{await dropScratchOrg(org.orgId);}
});

test('auto-publish honors a stepped tier instead of simple division (finding 6.6)',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const seeded=await seedOverheadOrg({
    expenses:[{number:'6601',name:'Office rent',amount:'100',dept:true}],
    hours:['4'],
  });
  try{
    await setTrueCostProfile(seeded.org.orgId,{categorySettings:{[seeded.groups[0]!.group]:{allocationBase:'billed_hours',allocationMethod:'stepped',allocationTiers:[{min:0,max:10,rate:'30.00'}],rateFormat:'per_hour',includeInComposite:true}}});
    const data=await trueCostData(seeded.org.orgId,{from:'2026-07-01',to:'2026-07-31',label:'July 2026'},null);
    assert.equal(data.departments[0]?.composite,30);
    const rates=await computeLiveOverheadRates(seeded.org.orgId);
    assert.deepEqual(rates,[{departmentId:seeded.department,ratePerHour:'30.00'}]);
  }finally{await dropScratchOrg(seeded.org.orgId);}
});

test('auto-publish blends departments by the weighted composite (finding 6.6)',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const seeded=await seedOverheadOrg({
    expenses:[{number:'6601',name:'Office rent',amount:'100',dept:true},{number:'6602',name:'Insurance',amount:'60',dept:true}],
    hours:['4'],
  });
  try{
    await setTrueCostProfile(seeded.org.orgId,{compositeMethod:'weighted'});
    const data=await trueCostData(seeded.org.orgId,{from:'2026-07-01',to:'2026-07-31',label:'July 2026'},null);
    // (25x100 + 15x60)/160 = 21.25 — the plain sum (40.00) must not govern.
    assert.equal(data.departments[0]?.composite,21.25);
    assert.equal(data.totals.byDept[seeded.department],21.25);
    const rates=await computeLiveOverheadRates(seeded.org.orgId);
    assert.deepEqual(rates,[{departmentId:seeded.department,ratePerHour:'21.25'}]);
  }finally{await dropScratchOrg(seeded.org.orgId);}
});

test('auto-publish runs the cascading composite over untagged expense exactly',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const seeded=await seedOverheadOrg({
    expenses:[
      {number:'6601',name:'Office rent',amount:'100',dept:true},
      {number:'6603',name:'Shop supplies',amount:'40',dept:false},
    ],
    hours:['4'],
  });
  try{
    await setTrueCostProfile(seeded.org.orgId,{compositeMethod:'cascading',baseLaborRate:50});
    const data=await trueCostData(seeded.org.orgId,{from:'2026-07-01',to:'2026-07-31',label:'July 2026'},null);
    // Untagged supplies land wholly on the single burden centre (40/4 = 10);
    // cascading over absolute rates: 4 + 25 + 10 - 4 = 35.
    assert.equal(data.departments[0]?.composite,35);
    assert.equal(data.ratePublication.supported,true);
    const rates=await computeLiveOverheadRates(seeded.org.orgId);
    assert.deepEqual(rates,[{departmentId:seeded.department,ratePerHour:'35.00'}]);
  }finally{await dropScratchOrg(seeded.org.orgId);}
});

test('auto-publish refuses a non-hourly included format while preview still renders (finding 6.6)',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const seeded=await seedOverheadOrg({
    expenses:[
      {number:'6601',name:'Office rent',amount:'100',dept:true},
      {number:'6602',name:'Wages',amount:'200',dept:true},
    ],
    hours:['4'],
  });
  try{
    // Wages is its own burden category and also feeds the labor base (the base
    // query matches the name); the rent category reports as % of labor —
    // unpublishable to a $/hr card.
    await setTrueCostProfile(seeded.org.orgId,{categorySettings:{[seeded.groups[0]!.group]:{allocationBase:'labor_dollars',rateFormat:'percent_labor',includeInComposite:true}}});
    const data=await trueCostData(seeded.org.orgId,{from:'2026-07-01',to:'2026-07-31',label:'July 2026'},null);
    assert.equal(data.ratePublication.supported,false);
    assert.equal(data.ratePublication.blockers.length,1);
    assert.match(data.ratePublication.blockers[0]?.reason ?? '',/percent_labor/);
    await assert.rejects(computeLiveOverheadRates(seeded.org.orgId),/percent_labor/);
  }finally{await dropScratchOrg(seeded.org.orgId);}
});
