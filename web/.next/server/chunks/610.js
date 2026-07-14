exports.id=610,exports.ids=[610],exports.modules={4609:(a,b,c)=>{"use strict";c.d(b,{t:()=>n,K:()=>o});var d=c(73024),e=c(76760),f=c(73136),g=c(77598);let h=(0,e.join)((0,e.dirname)((0,f.fileURLToPath)("file:///Users/braedonsaunders/Documents/openbooks/engine/src/netsuite.ts")),"..",".."),i=a=>encodeURIComponent(String(a)).replace(/[!'()*]/g,a=>"%"+a.charCodeAt(0).toString(16).toUpperCase());async function j(a,b=1e3){let c=function(){let a={};for(let b of(0,d.readFileSync)((0,e.join)(h,".env.netsuite"),"utf8").split("\n")){let c=b.match(/^([A-Z0-9_]+)=(.*)$/);c&&(a[c[1]]=c[2])}return a}(),f=`${c.NETSUITE_HOST}/services/rest/query/v1/suiteql`,k=[],l=0;for(;;){let d={limit:b,offset:l},e=await fetch(`${f}?limit=${b}&offset=${l}`,{method:"POST",headers:{Authorization:function(a,b,c,d){let e={oauth_consumer_key:a.NETSUITE_CONSUMER_KEY,oauth_token:a.NETSUITE_TOKEN_KEY,oauth_signature_method:"HMAC-SHA256",oauth_timestamp:String(Math.floor(Date.now()/1e3)),oauth_nonce:(0,g.randomBytes)(16).toString("hex"),oauth_version:"1.0"},f=Object.entries({...d,...e}).map(([a,b])=>[i(a),i(b)]).sort(([a,b],[c,d])=>a===c?b<d?-1:1:a<c?-1:1).map(([a,b])=>`${a}=${b}`).join("&"),h=[b.toUpperCase(),i(c),i(f)].join("&"),j=`${i(a.NETSUITE_CONSUMER_SECRET)}&${i(a.NETSUITE_TOKEN_SECRET)}`;return e.oauth_signature=(0,g.createHmac)("sha256",j).update(h).digest("base64"),`OAuth realm="${a.NETSUITE_ACCOUNT}", `+Object.entries(e).sort().map(([a,b])=>`${a}="${i(b)}"`).join(", ")}(c,"POST",f,d),"Content-Type":"application/json",Prefer:"transient"},body:JSON.stringify({q:a})});if(!e.ok){let a=await e.text();throw Error(`SuiteQL HTTP ${e.status}: ${a.slice(0,500)}`)}let h=await e.json();for(let a of h.items)delete a.links,k.push(a);if(!h.hasMore)return k;l+=b}}var k=c(79489);class l{async changesSince(a){let b=new Date((await j("SELECT TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') AS now FROM DUAL"))[0].now.replace(" ","T")+"Z"),c=a?`AND t.lastmodifieddate >= TO_DATE('${a.toISOString().slice(0,19).replace("T"," ")}', 'YYYY-MM-DD HH24:MI:SS')`:"",d=await j(`
      SELECT t.id AS tid, t.type AS ttype, t.trandate, t.tranid,
             t.entity AS entity, tl.department AS dept,
             tal.account AS acct, tal.debit, tal.credit,
             TO_CHAR(t.lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') AS modified
        FROM transactionaccountingline tal
        JOIN transaction t ON t.id = tal.transaction
        LEFT JOIN transactionline tl
               ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
       WHERE tal.posting = 'T' ${c}
    `),e=new Map;for(let a of d){let b=e.get(a.tid);b?b.push(a):e.set(a.tid,[a])}let f=[];for(let[a,b]of e){let c=b[0],d=b.filter(a=>a.acct).map(a=>({accountRef:String(a.acct),amount:(0,k.Uj)((0,k.J1)(a.debit??"0")-(0,k.J1)(a.credit??"0")),departmentRef:a.dept?String(a.dept):null,partyRef:c.entity?String(c.entity):null})).filter(a=>0n!==(0,k.J1)(a.amount));f.push({sourceRef:a,type:c.ttype,number:c.tranid??null,date:function(a){let b=a.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(!b)throw Error(`bad NetSuite date: ${a}`);return`${b[3]}-${b[1].padStart(2,"0")}-${b[2].padStart(2,"0")}`}(c.trandate),memo:`NetSuite ${c.ttype} ${c.tranid??""}`.trim(),lines:d})}return{transactions:f,syncedThrough:b}}async trialBalance(){return(await j(`
      SELECT tal.account AS acct, SUM(COALESCE(tal.debit,0)) AS d, SUM(COALESCE(tal.credit,0)) AS c
        FROM transactionaccountingline tal
       WHERE tal.posting = 'T'
       GROUP BY tal.account
    `)).filter(a=>a.acct).map(a=>({accountRef:String(a.acct),balance:(0,k.Uj)((0,k.J1)(a.d)-(0,k.J1)(a.c))}))}constructor(){this.name="netsuite"}}let m=(0,e.join)((0,e.dirname)((0,f.fileURLToPath)("file:///Users/braedonsaunders/Documents/openbooks/engine/src/sync/registry.ts")),"..","..","..");function n(){let a=[];return(0,d.existsSync)((0,e.join)(m,".env.netsuite"))&&a.push({name:"netsuite",displayName:"NetSuite",make:()=>new l}),a}function o(a){return n().find(b=>b.name===a)}},13930:(a,b,c)=>{"use strict";c.d(b,{SignOut:()=>d});let d=(0,c(19706).registerClientReference)(function(){throw Error("Attempted to call SignOut() from the server but SignOut is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.")},"/Users/braedonsaunders/Documents/openbooks/web/app/SignOut.tsx","SignOut")},17796:(a,b,c)=>{Promise.resolve().then(c.t.bind(c,46698,23)),Promise.resolve().then(c.t.bind(c,71189,23)),Promise.resolve().then(c.t.bind(c,31285,23)),Promise.resolve().then(c.t.bind(c,45692,23)),Promise.resolve().then(c.t.bind(c,82628,23)),Promise.resolve().then(c.t.bind(c,97176,23)),Promise.resolve().then(c.t.bind(c,86032,23)),Promise.resolve().then(c.t.bind(c,10553,23)),Promise.resolve().then(c.t.bind(c,75472,23))},22862:(a,b,c)=>{"use strict";c.d(b,{SyncButton:()=>d});let d=(0,c(19706).registerClientReference)(function(){throw Error("Attempted to call SyncButton() from the server but SyncButton is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.")},"/Users/braedonsaunders/Documents/openbooks/web/app/sync/SyncButton.tsx","SyncButton")},32292:(a,b,c)=>{"use strict";c.d(b,{SyncButton:()=>g});var d=c(55016),e=c(43161),f=c(60230);function g({source:a,label:b}){let[c,g]=(0,e.useState)(!1),[h,i]=(0,e.useState)(null),j=(0,f.useRouter)();async function k(){g(!0),i(null);try{let c=await fetch("/api/sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({source:a})}),d=await c.json();if(!c.ok)throw Error(d.error??`HTTP ${c.status}`);let e=d.tb;i(`Synced in ${(d.durationMs/1e3).toFixed(1)}s — ${d.newEntries} new, ${d.reversedEntries} reversed, ${d.unchanged} unchanged. Trial balance: ${e.matches}/${e.accounts} accounts match ${b}`+(e.mismatches.length?` (${e.mismatches.length} MISMATCHES)`:" — exact.")),j.refresh()}catch(a){i(`Sync failed: ${a.message}`)}finally{g(!1)}}return(0,d.jsxs)("div",{children:[(0,d.jsx)("button",{className:"btn",onClick:k,disabled:c,children:c?`Syncing from ${b}…`:`Sync from ${b}`}),h&&(0,d.jsx)("p",{className:"query-meta",children:h})]})}},33205:(a,b,c)=>{Promise.resolve().then(c.t.bind(c,7443,23)),Promise.resolve().then(c.bind(c,40264))},36226:(a,b,c)=>{"use strict";function d(a){if(null==a)return"";let b=Number(a);return Number.isNaN(b)?String(a):b.toLocaleString("en-CA",{minimumFractionDigits:2,maximumFractionDigits:2})}function e(a){return a?new Date(a).toLocaleString("en-CA",{dateStyle:"medium",timeStyle:"short"}):""}c.d(b,{K:()=>e,T:()=>d})},40264:(a,b,c)=>{"use strict";c.d(b,{SignOut:()=>f});var d=c(55016),e=c(60230);function f(){let a=(0,e.useRouter)();return(0,d.jsx)("button",{className:"nav-item",style:{background:"none",border:"none",cursor:"pointer",width:"100%",textAlign:"left",font:"inherit",fontWeight:500},onClick:async()=>{await fetch("/api/login",{method:"DELETE"}),a.push("/login"),a.refresh()},children:"Sign out"})}},57749:(a,b,c)=>{"use strict";c.r(b),c.d(b,{default:()=>j,metadata:()=>h});var d=c(7586),e=c(57737),f=c.n(e),g=c(13930);c(77190);let h={title:"openbooks",description:"The open business suite. Run on open books."},i=[{href:"/",label:"Dashboard"},{href:"/reports",label:"Reports"},{href:"/accounts",label:"Chart of Accounts"},{href:"/journal",label:"Journal"},{href:"/query",label:"SQL"},{href:"/sync",label:"Sync"}];function j({children:a}){return(0,d.jsx)("html",{lang:"en",children:(0,d.jsx)("body",{children:(0,d.jsxs)("div",{className:"shell",children:[(0,d.jsxs)("aside",{className:"sidebar",children:[(0,d.jsxs)("div",{className:"brand",children:["open",(0,d.jsx)("span",{children:"books"}),(0,d.jsx)("small",{children:"run on open books"})]}),i.map(a=>(0,d.jsx)(f(),{href:a.href,className:"nav-item",children:a.label},a.href)),(0,d.jsx)("div",{style:{marginTop:"auto"},children:(0,d.jsx)(g.SignOut,{})})]}),(0,d.jsx)("main",{className:"main",children:a})]})})})}},77190:()=>{},79489:(a,b,c)=>{"use strict";function d(a){let b=String(a).trim();if(!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(b))throw Error(`not a decimal number: "${a}"`);let c=b.startsWith("-");b=b.replace(/^[-+]/,"");let d=0,e=b.match(/[eE]([-+]?\d+)$/);e&&(d=parseInt(e[1],10),b=b.slice(0,e.index));let[f,g=""]=b.split(".");if(d>0?(f+=(g=g.padEnd(d,"0")).slice(0,d),g=g.slice(d)):d<0&&(g=(f=f.padStart(-d,"0")).slice(d)+g,f=f.slice(0,d)||"0"),g.length>4&&/[1-9]/.test(g.slice(4)))throw Error(`loses precision beyond 4 decimal places: "${a}"`);let h=(g+"0000").slice(0,4),i=10000n*BigInt(f||"0")+BigInt(h);return c?-i:i}function e(a){let b=a<0n,c=b?-a:a,d=(c%10000n).toString().padStart(4,"0");return`${b?"-":""}${c/10000n}.${d}`}c.d(b,{J1:()=>d,Uj:()=>e})},82884:(a,b,c)=>{Promise.resolve().then(c.t.bind(c,82220,23)),Promise.resolve().then(c.t.bind(c,90415,23)),Promise.resolve().then(c.t.bind(c,70099,23)),Promise.resolve().then(c.t.bind(c,92086,23)),Promise.resolve().then(c.t.bind(c,20946,23)),Promise.resolve().then(c.t.bind(c,68118,23)),Promise.resolve().then(c.t.bind(c,34166,23)),Promise.resolve().then(c.t.bind(c,58499,23)),Promise.resolve().then(c.bind(c,47094))},87493:(a,b,c)=>{"use strict";c.a(a,async(a,d)=>{try{c.d(b,{$f:()=>h,IR:()=>j,Jj:()=>k,eB:()=>l,lD:()=>i});var e=c(15950),f=c(18683),g=a([f]);async function h(){return(await f.db.execute((0,e.ll)`
    select o.name, o.base_currency,
           (select b.name from accounting_books b where b.is_primary limit 1) as book
      from orgs o limit 1
  `)).rows[0]}async function i(){let a=await f.db.execute((0,e.ll)`
    select
      (select count(*) from journal_entries) as entries,
      (select count(*) from journal_lines) as lines,
      (select count(*) from accounts where is_active) as accounts,
      (select count(*) from parties) as parties,
      (select coalesce(sum(amount), 0) from journal_lines) as ledger_sum
  `),b=await f.db.execute((0,e.ll)`
    select id, source, status, started_at, finished_at, stats, error_message, triggered_by
      from sync_runs order by started_at desc limit 8
  `);return{totals:a.rows[0],runs:b.rows}}async function j(){return(await f.db.execute((0,e.ll)`
    select a.id, a.parent_id, a.number, a.name, a.type, a.is_summary, a.is_active,
           coalesce(b.balance, 0) as balance
      from accounts a
      left join (select account_id, sum(amount) as balance from journal_lines group by 1) b
        on b.account_id = a.id
     order by a.number nulls last, a.name
  `)).rows}async function k(a,b=50){let c=await f.db.execute((0,e.ll)`
    select e.id, e.entry_number, e.posting_date, e.memo, e.status, e.origin,
           count(l.id) as line_count,
           sum(case when l.amount > 0 then l.amount else 0 end) as total_debits
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
     group by e.id
     order by e.posting_date desc, e.entry_number desc
     limit ${b} offset ${a}
  `),d=await f.db.execute((0,e.ll)`select count(*) as n from journal_entries`);return{entries:c.rows,total:Number(d.rows[0].n)}}async function l(a){let b=await f.db.execute((0,e.ll)`
    select e.*, re.entry_number as reverses_number
      from journal_entries e
      left join journal_entries re on re.id = e.reverses_entry_id
     where e.id = ${a}
  `),c=await f.db.execute((0,e.ll)`
    select l.line_number, l.amount, l.memo, l.is_open_item,
           a.number as account_number, a.name as account_name,
           p.display_name as party, d.name as department
      from journal_lines l
      join accounts a on a.id = l.account_id
      left join parties p on p.id = l.party_id
      left join departments d on d.id = l.department_id
     where l.entry_id = ${a}
     order by l.line_number
  `);return{entry:b.rows[0]??null,lines:c.rows}}f=(g.then?(await g)():g)[0],d()}catch(a){d(a)}})},91349:(a,b,c)=>{Promise.resolve().then(c.t.bind(c,57737,23)),Promise.resolve().then(c.bind(c,13930))}};