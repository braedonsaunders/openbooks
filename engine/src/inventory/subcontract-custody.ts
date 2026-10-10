import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { loadSubsidiaryContext, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { InventoryError, InventoryNotFoundError } from "./contracts.ts";

/** Custody changes physical availability, never the owner or carried value of stock. */
export async function assertSubcontractCustodyFeature(tx: SqlExecutor,orgId:string) {
  if (!await lockAndCheckOrgFeature(tx,orgId,"manufacturingSubcontract")) {
    throw new InventoryError("Turn on Manufacturing Subcontracting in Company Settings → Features before moving or configuring vendor custody stock.");
  }
}

export async function lockSubcontractCustodyAuthority(
  tx:SqlExecutor,orgId:string,actorId:string|null,subsidiaryId:string,locationId:string,
) {
  const custody=(await tx.execute<{vendorId:string}>(sql`select custodian_party_id as "vendorId" from stock_locations
    where org_id=${orgId} and id=${locationId} and kind='subcontract' for share`)).rows[0];
  if (!custody) return null;
  if (!actorId || !isUuid(actorId) || !(await tx.execute(sql`select id from users
    where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`)).rows.length) throw new InventoryNotFoundError("not_found");
  let scope:ReadonlySet<string>|null=null;
  for (const permission of ["items.post","manufacturing.manage"]) {
    const granted=await lockActorCommandAuthority(tx,orgId,actorId,subsidiaryId,permission);
    if(granted!==null) scope=scope===null?granted:new Set([...scope].filter(id=>granted.has(id)));
  }
  if(!(await tx.execute(sql`select stock.id from stock_locations stock
    join locations location on location.org_id=stock.org_id and location.id=stock.location_id
    join parties vendor on vendor.org_id=stock.org_id and vendor.id=stock.custodian_party_id
    where stock.org_id=${orgId} and stock.id=${locationId}
      ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})}
      ${subsidiaryVisibleFilter(sql`vendor.subsidiary_id`,scope,{orgWideNull:true})}`)).rows.length) throw new InventoryNotFoundError("not_found");
  await assertSubcontractCustodyFeature(tx,orgId);
  await assertCustodianVendor(tx,orgId,custody.vendorId,subsidiaryId);
  return custody;
}

export async function assertCustodianVendor(tx:SqlExecutor,orgId:string,vendorId:string,subsidiaryId?:string) {
  if (!isUuid(vendorId)) throw new InventoryError("Choose an active vendor for the custody location.");
  const vendor=(await tx.execute(sql`select party.id from parties party
    where party.org_id=${orgId} and party.id=${vendorId} and party.is_active
      and (party.kind='vendor' or exists(select 1 from vendor_roles role where role.org_id=party.org_id and role.party_id=party.id))
    for share of party`)).rows[0];
  if (!vendor) throw new InventoryError("Choose an active vendor for the custody location.");
  await tx.execute(sql`select party_id from vendor_roles where org_id=${orgId} and party_id=${vendorId} for share`);
  if (subsidiaryId) await validateSubsidiaryRestrictions(tx,{
    orgId,ctx:await loadSubsidiaryContext(tx,orgId),lines:[],partyId:vendorId,docSubsidiaryId:subsidiaryId,
  });
}

/** Used by the existing Setup writer before a create claim or update can succeed. */
export async function validateSubcontractLocationConfiguration(
  tx:SqlExecutor,orgId:string,actorId:string,input:Record<string,unknown>,locationId?:string,
) {
  const previous=locationId?(await tx.execute<Record<string,unknown>>(sql`select kind,custodian_party_id,inventory_ownership,parent_id
    from stock_locations where org_id=${orgId} and id=${locationId} for update`)).rows[0]:undefined;
  const kind=input.kind??previous?.kind??"bin";
  const custodian=input.custodianPartyId===undefined?previous?.custodian_party_id??null:input.custodianPartyId;
  const ownership=input.inventoryOwnership??previous?.inventory_ownership??"owned";
  const parentId=input.parentId===undefined?previous?.parent_id??null:input.parentId;
  if (kind!=="subcontract" && previous?.kind!=="subcontract" && custodian==null && parentId==null) return;
  const parent=parentId?(await tx.execute<{kind:string;vendorId:string|null}>(sql`select kind,custodian_party_id as "vendorId"
    from stock_locations where org_id=${orgId} and id=${String(parentId)} for share`)).rows[0]:undefined;
  if (kind!=="subcontract" && previous?.kind!=="subcontract" && custodian==null && parent?.kind!=="subcontract") return;
  const actor=(await tx.execute(sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`)).rows[0];
  if (!actor) throw new InventoryNotFoundError("not_found");
  for (const permission of ["admin.setup.manage","manufacturing.manage"]) {
    const scope=await lockActorCommandAuthority(tx,orgId,actorId,null,permission);
    if (scope!==null) throw new InventoryError("Vendor custody locations require organization-wide setup authority.");
  }
  await assertSubcontractCustodyFeature(tx,orgId);
  if (kind==="subcontract") {
    if (ownership!=="owned" || typeof custodian!=="string") throw new InventoryError("Vendor custody keeps company-owned stock and requires a vendor.");
    await assertCustodianVendor(tx,orgId,custodian);
  } else if (custodian!=null) throw new InventoryError("Use a vendor custody location for a custodian; external ownership belongs to Consignment.");
  if (parent?.kind==="subcontract" && (kind!=="subcontract" || custodian!==parent.vendorId)) {
    throw new InventoryError("A child of vendor custody must keep the same vendor and custody kind.");
  }
}
