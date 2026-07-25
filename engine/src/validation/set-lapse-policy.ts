import { sql } from "drizzle-orm";
import { db } from "../db.ts";
const ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const env:any = await db.execute(sql`select env_kind from orgs where id=${ORG}`);
if (env.rows[0]?.env_kind !== "sandbox") throw new Error("refusing: not a sandbox");
const r:any = await db.execute(sql`
  update project_types set invoicing_profile =
    coalesce(invoicing_profile,'{}'::jsonb) || '{"rateCardLapse":"carry_forward"}'::jsonb
   where org_id=${ORG}`);
console.log("project types set to carry_forward:", r.rowCount);
process.exit(0);
