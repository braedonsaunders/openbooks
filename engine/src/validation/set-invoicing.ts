import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { resolveTargetOrg } from "./target-org.ts";
const ORG = process.env.TARGET_ORG ?? process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
async function retry<T>(fn:()=>Promise<T>,n=8):Promise<T>{let l:unknown;for(let i=0;i<n;i++){try{return await fn()}catch(e){l=e;await new Promise(r=>setTimeout(r,2500*(i+1)))}}throw l}
await resolveTargetOrg(ORG);
const patch = JSON.parse(process.argv[2] ?? "{}");
const r:any = await retry(()=>db.execute(sql`
  update project_types set invoicing_profile = coalesce(invoicing_profile,'{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
   where org_id=${ORG}`));
console.log("patched", r.rowCount, "project types with", JSON.stringify(patch));
process.exit(0);
