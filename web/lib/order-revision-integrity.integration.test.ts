import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { SessionUser } from "./auth";
const root = pathToFileURL(process.cwd()+"/").href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __orderRevisionUser: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "next-intl/server") return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__orderRevisionUser.user}" };
  if (specifier.startsWith("@/")) return next(root+"web/"+specifier.slice(2)+".ts",context);
  return next(specifier,context);
}});
const { db, withOrg, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { makeGET, makePATCH, makeDELETE, makeConvertPOST } = await import("../app/api/_order/handlers");
const request = (method: string, body?: unknown) => new Request("http://audit.local/api/sales-orders", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

for (const operation of ["read", "edit", "issue", "delete", "void", "conversion race", "current issue", "current void", "current conversion", "truncated token"] as const) {
  test(`order revision contract: ${operation}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    let release = () => {};
    let edit: Promise<unknown> | undefined;
    let command: Promise<Response> | undefined;
    try {
      const actor = await createScratchUser(org.orgId, "Order reviewer", "reviewer");
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
      state.user = { id: actor,orgId:org.orgId,name:"Order reviewer",email:"order@scratch.test",roles:[],isSuperAdmin:false,envKind:"production",productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor };
      const id = randomUUID();
      const kind = operation.includes("conversion") ? "quote" as const : "sales_order" as const;
      await db.execute(sql`insert into documents (id,org_id,kind,document_number,document_date,currency,party_id,subsidiary_id,created_by)
        values (${id},${org.orgId},${kind},${`ORDER-${id}`},${org.date},'CAD',${org.customerId},${org.subsidiaryId},${actor})`);
      await db.execute(sql`insert into document_lines (org_id,document_id,line_number,account_id,quantity,unit_price,amount)
        values (${org.orgId},${id},1,${org.accounts.revenue},'1','100','100')`);
      if (operation.endsWith("void") || operation.includes("conversion")) await db.execute(sql`update documents set status='approved' where id=${id}`);
      await db.execute(sql`update documents set updated_at=date_trunc('second',now()+interval '1 day')+interval '123450 microseconds' where id=${id}`);
      const token = (await db.execute<{ revision: string }>(sql`select to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision from documents where id=${id}`)).rows[0]!.revision;
      const cfg = { kind, readPerm: "ar.read", createPerm: "ar.create" };
      const params = { params: Promise.resolve({ id }) };
      await withOrgContext(org.orgId, async () => {
        if (operation === "read") {
          const response = await makeGET(cfg)(request("GET"), params);
          assert.equal(response.status,200);
          assert.equal((await response.json()).doc.updated_at, token);
          return;
        }
        if (operation.startsWith("current")) {
          const response = operation === "current conversion"
            ? await makeConvertPOST(cfg)(request("POST", { targetKind: "sales_order", expectedUpdatedAt: token }), params)
            : await makePATCH(cfg)(request("PATCH", { expectedUpdatedAt: token,
                ...(operation === "current issue" ? { status: "approved" }
                  : { status: "voided", reason: "Cancel reviewed order", reversalDate: org.date }) }), params);
          const payload = await response.json();
          assert.equal(response.status, 200, JSON.stringify(payload));
          const resultId = operation === "current conversion" ? payload.id : id;
          const result = (await db.execute<{ status: string }>(sql`select status from documents where id=${resultId}`)).rows[0];
          assert.equal(result?.status, operation === "current void" ? "voided" : "approved");
          return;
        }
        if (operation === "truncated token") {
          const response = await makePATCH(cfg)(request("PATCH", { status: "approved", expectedUpdatedAt: token.replace(/(\.\d{3})\d{3}Z$/, "$1Z") }), params);
          assert.equal(response.status, 409);
          assert.equal((await db.execute<{ status: string }>(sql`select status from documents where id=${id}`)).rows[0]!.status, "draft");
          return;
        }
        let response: Response;
        if (operation === "conversion race") {
          let ready!: () => void, pid = 0;
          const staged = new Promise<void>(resolve => { ready = resolve; });
          const hold = new Promise<void>(resolve => { release = resolve; });
          edit = withOrg(org.orgId, async () => {
            pid = (await db.execute<{ pid:number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
            await db.execute(sql`update documents set memo='Concurrent edit',updated_at=updated_at+interval '1 second' where id=${id}`);
            ready(); await hold;
          });
          await Promise.race([staged,edit]);
          command = makeConvertPOST(cfg)(request("POST",{targetKind:"sales_order",expectedUpdatedAt:token}),params);
          let settled = false, blocked = false;
          void command.then(() => { settled=true; },()=>{settled=true;});
          const deadline=Date.now()+10_000;
          while (!settled && Date.now()<deadline) {
            blocked=(await db.execute<{blocked:boolean}>(sql`select exists(select 1 from pg_stat_activity where datname=current_database() and ${pid}=any(pg_blocking_pids(pid))) as blocked`)).rows[0]!.blocked;
            if (blocked) break;
            await new Promise(resolve=>setTimeout(resolve,10));
          }
          assert.ok(blocked,"conversion must wait for its source lock");
          release(); await edit; response=await command;
        } else {
          await db.execute(sql`update documents set memo='Unreviewed edit',updated_at=updated_at+interval '1 microsecond' where id=${id}`);
          response = operation === "delete" ? await makeDELETE(cfg)(request("DELETE",{expectedUpdatedAt:token}),params)
            : await makePATCH(cfg)(request("PATCH",{expectedUpdatedAt:token,...(operation === "edit" ? {memo:"Stale edit"} : operation === "issue" ? {status:"approved"} : {status:"voided",reason:"Cancel reviewed order",reversalDate:org.date})}),params);
        }
        assert.equal(response.status,409,JSON.stringify(await response.json()));
        assert.equal((await db.execute<{count:number}>(sql`select count(*)::int as count from documents where org_id=${org.orgId}`)).rows[0]!.count,1);
      });
    } finally { release(); await Promise.allSettled([edit,command]); state.user=null; await dropScratchOrg(org.orgId); }
  });
}
