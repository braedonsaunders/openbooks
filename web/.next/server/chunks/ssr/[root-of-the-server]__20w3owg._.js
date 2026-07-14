module.exports=[2157,(a,b,c)=>{b.exports=a.x("node:fs",()=>require("node:fs"))},50227,(a,b,c)=>{b.exports=a.x("node:path",()=>require("node:path"))},57764,(a,b,c)=>{b.exports=a.x("node:url",()=>require("node:url"))},23862,a=>a.a(async(b,c)=>{try{let b=await a.y("pg-587764f78a6c7a9c");a.n(b),c()}catch(a){c(a)}},!0),66680,(a,b,c)=>{b.exports=a.x("node:crypto",()=>require("node:crypto"))},24969,a=>a.a(async(b,c)=>{try{var d=a.i(51674),e=a.i(35520),f=b([e]);async function g(){return(await e.db.execute(d.sql`
    select o.name, o.base_currency,
           (select b.name from accounting_books b where b.is_primary limit 1) as book
      from orgs o limit 1
  `)).rows[0]}async function h(){let a=await e.db.execute(d.sql`
    select
      (select count(*) from journal_entries) as entries,
      (select count(*) from journal_lines) as lines,
      (select count(*) from accounts where is_active) as accounts,
      (select count(*) from parties) as parties,
      (select coalesce(sum(amount), 0) from journal_lines) as ledger_sum
  `),b=await e.db.execute(d.sql`
    select id, source, status, started_at, finished_at, stats, error_message, triggered_by
      from sync_runs order by started_at desc limit 8
  `);return{totals:a.rows[0],runs:b.rows}}async function i(){return(await e.db.execute(d.sql`
    select a.id, a.parent_id, a.number, a.name, a.type, a.is_summary, a.is_active,
           coalesce(b.balance, 0) as balance
      from accounts a
      left join (select account_id, sum(amount) as balance from journal_lines group by 1) b
        on b.account_id = a.id
     order by a.number nulls last, a.name
  `)).rows}async function j(a,b=50){let c=await e.db.execute(d.sql`
    select e.id, e.entry_number, e.posting_date, e.memo, e.status, e.origin,
           count(l.id) as line_count,
           sum(case when l.amount > 0 then l.amount else 0 end) as total_debits
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
     group by e.id
     order by e.posting_date desc, e.entry_number desc
     limit ${b} offset ${a}
  `),f=await e.db.execute(d.sql`select count(*) as n from journal_entries`);return{entries:c.rows,total:Number(f.rows[0].n)}}async function k(a){let b=await e.db.execute(d.sql`
    select e.*, re.entry_number as reverses_number
      from journal_entries e
      left join journal_entries re on re.id = e.reverses_entry_id
     where e.id = ${a}
  `),c=await e.db.execute(d.sql`
    select l.line_number, l.amount, l.memo, l.is_open_item,
           a.number as account_number, a.name as account_name,
           p.display_name as party, d.name as department
      from journal_lines l
      join accounts a on a.id = l.account_id
      left join parties p on p.id = l.party_id
      left join departments d on d.id = l.department_id
     where l.entry_id = ${a}
     order by l.line_number
  `);return{entry:b.rows[0]??null,lines:c.rows}}[e]=f.then?(await f)():f,a.s(["accountsWithBalances",0,i,"dashboardData",0,h,"entryDetail",0,k,"journalPage",0,j,"orgInfo",0,g]),c()}catch(a){c(a)}},!1)];

//# sourceMappingURL=%5Broot-of-the-server%5D__20w3owg._.js.map