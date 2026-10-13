import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { migrationBusinessOwnerRole } from "./migration-owner-authority.ts";

test("only exact catalog-privilege and private-authority publishers stay with the maintenance login",()=>{
  for(const filename of ["generated/0539_query_console_and_script_authority_hardening.sql",
    "generated/0622_query_console_catalog_privileges.sql","generated/0626_tenant_retirement.sql"]){
  const digest=createHash("sha256").update(readFileSync(`schema/migrations/${filename}`)).digest("hex");
  assert.equal(migrationBusinessOwnerRole(filename,digest,"openbooks_schema_owner"),undefined);
  assert.throws(()=>migrationBusinessOwnerRole(filename,"0".repeat(64),"openbooks_schema_owner"),/published identity/);
  assert.equal(migrationBusinessOwnerRole("generated/0628_production_retirement_contracts.sql",digest,"openbooks_schema_owner"),"openbooks_schema_owner");
  assert.equal(migrationBusinessOwnerRole("generated/0707_financial_policy_bypass_predicate.sql",digest,undefined),undefined);
  }
});
