/** Managed-property and unit CRUD. Split from property/management.ts (pure moves only). */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, normalizeMoney } from "../money/money.ts";
import { assertEnabled, assertLockedSubsidiaryInScope, assertPropertyPostingScope, audit, exactMoney, fixedAssetsFeatureEnabled, lockPropertyInScope, multiCurrencyFeatureEnabled, PropertyManagementError } from "./management-foundation.ts";

export async function createManagedProperty(input: {
  orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; subsidiaryId: string; locationId?: string | null; fixedAssetId?: string | null;
  code: string; name: string; propertyType: string; currency?: string | null; address?: Record<string, string>;
  rentIncomeAccountId?: string | null; camIncomeAccountId?: string | null; depositLiabilityAccountId?: string | null; defaultBankAccountId?: string | null;
  custom?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const code = input.code.trim(); const name = input.name.trim();
  if (!code || !name) throw new PropertyManagementError("Property code and name are required");
  if (!["residential", "commercial", "mixed_use", "industrial", "other"].includes(input.propertyType)) {
    throw new PropertyManagementError("Invalid property type");
  }
  const requestedCurrency = (input.currency ?? "").trim().toUpperCase();
  if (requestedCurrency && !/^[A-Z]{3}$/.test(requestedCurrency)) throw new PropertyManagementError("Property currency must be a three-letter ISO code");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    if (input.fixedAssetId && !(await fixedAssetsFeatureEnabled(tx, input.orgId))) {
      throw new PropertyManagementError("Fixed assets feature is disabled");
    }
    if (requestedCurrency && !(await multiCurrencyFeatureEnabled(tx, input.orgId))) {
      throw new PropertyManagementError("Multi-currency is disabled", 404);
    }
    const scope = (await tx.execute<{ currency: string; subsidiary_active: boolean; location_ok: boolean; asset_ok: boolean; rent_account_ok: boolean; cam_account_ok: boolean; deposit_account_ok: boolean; bank_account_ok: boolean }>(sql`
      select s.base_currency as currency,
        s.is_active as subsidiary_active,
        (${input.locationId ?? null}::uuid is null or exists(
          select 1 from locations l
           where l.org_id=${input.orgId} and l.id=${input.locationId ?? null}
             and (l.subsidiary_id is null or l.subsidiary_id=s.id or
               (l.subsidiary_include_children and exists(
                 with recursive ancestors(id) as (
                   select s0.parent_id
                     from subsidiaries s0
                    where s0.org_id=${input.orgId} and s0.id=s.id
                   union all
                   select s0.parent_id
                     from subsidiaries s0
                     join ancestors a on a.id=s0.id
                    where s0.org_id=${input.orgId}
                 )
                 select 1 from ancestors where id=l.subsidiary_id
               ))
             )
        )) as location_ok,
        (${input.fixedAssetId ?? null}::uuid is null or exists(select 1 from fixed_assets where org_id=${input.orgId} and id=${input.fixedAssetId ?? null} and subsidiary_id=s.id)) as asset_ok,
        (${input.rentIncomeAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.rentIncomeAccountId ?? null} and type in ('income','income_other') and is_active and not is_summary)) as rent_account_ok,
        (${input.camIncomeAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.camIncomeAccountId ?? null} and type in ('income','income_other') and is_active and not is_summary)) as cam_account_ok,
        (${input.depositLiabilityAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.depositLiabilityAccountId ?? null} and type in ('liability_current_other','liability_long_term') and is_active and not is_summary)) as deposit_account_ok,
        (${input.defaultBankAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.defaultBankAccountId ?? null} and type='asset_bank' and is_active and not is_summary)) as bank_account_ok
      from subsidiaries s where s.org_id=${input.orgId} and s.id=${input.subsidiaryId}
    `));
    const row = scope.rows[0];
    if (!row) throw new PropertyManagementError("Subsidiary not found");
    // The target entity is fixed before the write: a restricted caller may
    // only create into a subsidiary they can see, checked inside the same
    // transaction that validates and inserts.
    assertLockedSubsidiaryInScope(input.allowedSubsidiaryIds, input.subsidiaryId);
    if (!row.subsidiary_active) throw new PropertyManagementError("Subsidiary is inactive");
    if (!row.location_ok || !row.asset_ok) throw new PropertyManagementError("Property dimensions do not belong to this organization");
    if (!row.rent_account_ok || !row.cam_account_ok || !row.deposit_account_ok || !row.bank_account_ok) throw new PropertyManagementError("Property control accounts have incompatible account types");
    await assertPropertyPostingScope(tx, input.orgId, input.subsidiaryId, [
      input.rentIncomeAccountId,
      input.camIncomeAccountId,
      input.depositLiabilityAccountId,
      input.defaultBankAccountId,
    ]);
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into managed_properties(org_id,subsidiary_id,location_id,fixed_asset_id,code,name,property_type,currency,address,
        rent_income_account_id,cam_income_account_id,deposit_liability_account_id,default_bank_account_id,custom,created_by,updated_by)
      values(${input.orgId},${input.subsidiaryId},${input.locationId ?? null},${input.fixedAssetId ?? null},${code},${name},${input.propertyType},
        ${requestedCurrency || row.currency},${JSON.stringify(input.address ?? {})}::jsonb,${input.rentIncomeAccountId ?? null},${input.camIncomeAccountId ?? null},
        ${input.depositLiabilityAccountId ?? null},${input.defaultBankAccountId ?? null},${JSON.stringify(input.custom ?? {})}::jsonb,${input.actorId},${input.actorId}) returning id
    `));
    const id = inserted.rows[0]!.id;
    await audit(tx, input.orgId, "managed_properties", id, "insert", input.actorId, { code, name });
    return { id };
  });
}
export async function updateManagedProperty(input: {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  propertyId: string;
  subsidiaryId: string;
  locationId?: string | null;
  fixedAssetId?: string | null;
  code: string;
  name: string;
  propertyType: string;
  status: string;
  currency?: string;
  address?: Record<string, string>;
  rentIncomeAccountId?: string | null;
  camIncomeAccountId?: string | null;
  depositLiabilityAccountId?: string | null;
  defaultBankAccountId?: string | null;
  custom?: Record<string, unknown>;
  reason?: string | null;
}): Promise<{ id: string }> {
  const code = input.code.trim();
  const name = input.name.trim();
  const currencySubmitted = input.currency !== undefined && input.currency !== null && String(input.currency).trim() !== "";
  const currency = currencySubmitted ? String(input.currency).trim().toUpperCase() : "";
  if (!code || !name)
    throw new PropertyManagementError("Property code and name are required");
  if (currencySubmitted && !/^[A-Z]{3}$/.test(currency))
    throw new PropertyManagementError(
      "Property currency must be a three-letter ISO code",
    );
  if (
    !["residential", "commercial", "mixed_use", "industrial", "other"].includes(
      input.propertyType,
    )
  ) {
    throw new PropertyManagementError("Invalid property type");
  }
  if (!["active", "inactive", "sold"].includes(input.status))
    throw new PropertyManagementError("Invalid property status");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    const nextAssetSql = input.fixedAssetId !== undefined
      ? sql`${input.fixedAssetId ?? null}::uuid`
      : sql`p.fixed_asset_id`;
    const scope = (await tx.execute<{
        currentSubsidiaryId: string;
        currentCurrency: string;
        currentFixedAssetId: string | null;
        currentCode: string;
        currentName: string;
        currentPropertyType: string;
        currentStatus: string;
        currentLocationId: string | null;
        currentAddress: Record<string, string> | null;
        currentRentIncomeAccountId: string | null;
        currentCamIncomeAccountId: string | null;
        currentDepositLiabilityAccountId: string | null;
        currentDefaultBankAccountId: string | null;
        currentCustom: Record<string, unknown> | null;
        has_leases: boolean;
        has_active_leases: boolean;
        subsidiary_ok: boolean;
        subsidiary_active: boolean;
        location_ok: boolean;
        asset_ok: boolean;
        rent_account_ok: boolean;
        cam_account_ok: boolean;
        deposit_account_ok: boolean;
        bank_account_ok: boolean;
      }>(sql`
      select p.subsidiary_id as "currentSubsidiaryId",p.currency as "currentCurrency",p.fixed_asset_id as "currentFixedAssetId",
        p.code as "currentCode",p.name as "currentName",p.property_type as "currentPropertyType",p.status as "currentStatus",
        p.location_id as "currentLocationId",p.address as "currentAddress",
        p.rent_income_account_id as "currentRentIncomeAccountId",p.cam_income_account_id as "currentCamIncomeAccountId",
        p.deposit_liability_account_id as "currentDepositLiabilityAccountId",p.default_bank_account_id as "currentDefaultBankAccountId",
        p.custom as "currentCustom",
        exists(select 1 from property_leases where org_id=p.org_id and property_id=p.id) as has_leases,
        exists(select 1 from property_leases where org_id=p.org_id and property_id=p.id and status in ('active','notice')) as has_active_leases,
        exists(select 1 from subsidiaries where org_id=${input.orgId} and id=${input.subsidiaryId}) as subsidiary_ok,
        exists(select 1 from subsidiaries where org_id=${input.orgId} and id=${input.subsidiaryId} and is_active) as subsidiary_active,
        (${input.locationId ?? null}::uuid is null or exists(
          select 1 from locations l
           where l.org_id=${input.orgId} and l.id=${input.locationId ?? null}
             and (l.subsidiary_id is null or l.subsidiary_id=${input.subsidiaryId} or
               (l.subsidiary_include_children and exists(
                 with recursive ancestors(id) as (
                   select s.parent_id
                     from subsidiaries s
                    where s.org_id=${input.orgId} and s.id=${input.subsidiaryId}
                   union all
                   select s.parent_id
                     from subsidiaries s
                     join ancestors a on a.id=s.id
                    where s.org_id=${input.orgId}
                 )
                 select 1 from ancestors where id=l.subsidiary_id
               ))
             )
        )) as location_ok,
        (${nextAssetSql} is null or exists(select 1 from fixed_assets where org_id=${input.orgId} and id=${nextAssetSql} and subsidiary_id=${input.subsidiaryId})) as asset_ok,
        (${input.rentIncomeAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.rentIncomeAccountId ?? null} and type in ('income','income_other') and is_active and not is_summary)) as rent_account_ok,
        (${input.camIncomeAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.camIncomeAccountId ?? null} and type in ('income','income_other') and is_active and not is_summary)) as cam_account_ok,
        (${input.depositLiabilityAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.depositLiabilityAccountId ?? null} and type in ('liability_current_other','liability_long_term') and is_active and not is_summary)) as deposit_account_ok,
        (${input.defaultBankAccountId ?? null}::uuid is null or exists(select 1 from accounts where org_id=${input.orgId} and id=${input.defaultBankAccountId ?? null} and type='asset_bank' and is_active and not is_summary)) as bank_account_ok
      from managed_properties p where p.org_id=${input.orgId} and p.id=${input.propertyId} for update
    `));
    const row = scope.rows[0];
    if (!row) throw new PropertyManagementError("Property not found");
    // The row is locked FOR UPDATE above: both the current and the target
    // subsidiary are rechecked inside the transaction, so a concurrent
    // rehome cannot slip a restricted edit onto another entity's property.
    assertLockedSubsidiaryInScope(input.allowedSubsidiaryIds, row.currentSubsidiaryId);
    assertLockedSubsidiaryInScope(input.allowedSubsidiaryIds, input.subsidiaryId);
    if (!row.subsidiary_ok) throw new PropertyManagementError("Subsidiary not found");
    if (!row.subsidiary_active) throw new PropertyManagementError("Subsidiary is inactive");
    const currentAssetId = row.currentFixedAssetId ? String(row.currentFixedAssetId) : null;
    const nextAssetId = input.fixedAssetId !== undefined ? (input.fixedAssetId || null) : currentAssetId;
    if (nextAssetId !== currentAssetId && !(await fixedAssetsFeatureEnabled(tx, input.orgId))) {
      throw new PropertyManagementError("Fixed assets feature is disabled");
    }
    if (currencySubmitted && currency !== row.currentCurrency && !(await multiCurrencyFeatureEnabled(tx, input.orgId))) {
      throw new PropertyManagementError("Multi-currency is disabled", 404);
    }
    const nextCurrency = currencySubmitted ? currency : row.currentCurrency;
    if (!row.subsidiary_ok || !row.location_ok || !row.asset_ok)
      throw new PropertyManagementError(
        "Property dimensions do not belong to this organization",
      );
    if (
      !row.rent_account_ok ||
      !row.cam_account_ok ||
      !row.deposit_account_ok ||
      !row.bank_account_ok
    ) {
      throw new PropertyManagementError(
        "Property control accounts have incompatible account types",
      );
    }
    await assertPropertyPostingScope(tx, input.orgId, input.subsidiaryId, [
      input.rentIncomeAccountId,
      input.camIncomeAccountId,
      input.depositLiabilityAccountId,
      input.defaultBankAccountId,
    ]);
    if (
      row.has_leases &&
      (row.currentSubsidiaryId !== input.subsidiaryId ||
        row.currentCurrency !== nextCurrency)
    ) {
      throw new PropertyManagementError(
        "Subsidiary and currency cannot change after a lease exists",
      );
    }
    if (row.has_active_leases && input.status !== "active") {
      throw new PropertyManagementError(
        "End active or notice leases before deactivating this property",
      );
    }
    await tx.execute(sql`
      update managed_properties set subsidiary_id=${input.subsidiaryId},location_id=${input.locationId ?? null},
        fixed_asset_id=${nextAssetId},code=${code},name=${name},property_type=${input.propertyType},
        status=${input.status},currency=${nextCurrency},address=${JSON.stringify(input.address ?? {})}::jsonb,
        rent_income_account_id=${input.rentIncomeAccountId ?? null},cam_income_account_id=${input.camIncomeAccountId ?? null},
        deposit_liability_account_id=${input.depositLiabilityAccountId ?? null},default_bank_account_id=${input.defaultBankAccountId ?? null},
        custom=${JSON.stringify(input.custom ?? {})}::jsonb,updated_at=now(),updated_by=${input.actorId}
      where org_id=${input.orgId} and id=${input.propertyId}
    `);
    // Rent, CAM income, deposit liability, bank controls, location, fixed
    // asset, currency and custom policy all move money or posting scope, so
    // the audit carries every material field before/after (the lease-update
    // shape) plus the optional change reason — never just the new code.
    const changeReason = input.reason?.trim() ? input.reason.trim() : null;
    const before = {
      code: row.currentCode, name: row.currentName, propertyType: row.currentPropertyType, status: row.currentStatus,
      subsidiaryId: row.currentSubsidiaryId, locationId: row.currentLocationId, fixedAssetId: currentAssetId,
      currency: row.currentCurrency, address: row.currentAddress ?? {},
      rentIncomeAccountId: row.currentRentIncomeAccountId, camIncomeAccountId: row.currentCamIncomeAccountId,
      depositLiabilityAccountId: row.currentDepositLiabilityAccountId, defaultBankAccountId: row.currentDefaultBankAccountId,
      custom: row.currentCustom ?? {},
    };
    const after = {
      code, name, propertyType: input.propertyType, status: input.status,
      subsidiaryId: input.subsidiaryId, locationId: input.locationId ?? null, fixedAssetId: nextAssetId,
      currency: nextCurrency, address: input.address ?? {},
      rentIncomeAccountId: input.rentIncomeAccountId ?? null, camIncomeAccountId: input.camIncomeAccountId ?? null,
      depositLiabilityAccountId: input.depositLiabilityAccountId ?? null, defaultBankAccountId: input.defaultBankAccountId ?? null,
      custom: input.custom ?? {},
    };
    await audit(
      tx,
      input.orgId,
      "managed_properties",
      input.propertyId,
      "update",
      input.actorId,
      {
        before,
        after,
        changedFields: Object.keys(after).filter((key) => JSON.stringify(after[key as keyof typeof after]) !== JSON.stringify(before[key as keyof typeof before])),
        ...(changeReason == null ? {} : { reason: changeReason }),
      },
    );
    return { id: input.propertyId };
  });
}
export async function deleteManagedProperty(orgId: string, actorId: string, allowedSubsidiaryIds: ReadonlySet<string> | null, propertyId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    await lockPropertyInScope(tx, orgId, propertyId, allowedSubsidiaryIds);
    const record = (await tx.execute<{ code: string; name: string; has_units: boolean; has_leases: boolean; has_cam: boolean }>(sql`
      select p.code,p.name,
        exists(select 1 from property_units where org_id=p.org_id and property_id=p.id) as has_units,
        exists(select 1 from property_leases where org_id=p.org_id and property_id=p.id) as has_leases,
        exists(select 1 from cam_pools where org_id=p.org_id and property_id=p.id) as has_cam
      from managed_properties p where p.org_id=${orgId} and p.id=${propertyId} for update
    `));
    const row = record.rows[0];
    if (!row) throw new PropertyManagementError("Property not found");
    if (row.has_units || row.has_leases || row.has_cam) {
      throw new PropertyManagementError("A property with units, leases, or CAM history cannot be deleted; deactivate it instead");
    }
    await tx.execute(sql`delete from managed_properties where org_id=${orgId} and id=${propertyId}`);
    await audit(tx, orgId, "managed_properties", propertyId, "delete", actorId, { before: { code: row.code, name: row.name } });
  });
}
export async function createPropertyUnit(input: { orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; propertyId: string; code: string; name?: string | null; unitType?: string | null; rentableArea?: string | null; bedrooms?: number | null }): Promise<{ id: string }> {
  if (!input.code.trim()) throw new PropertyManagementError("Unit code is required");
  const rentableArea = input.rentableArea == null || input.rentableArea === "" ? null : exactMoney(input.rentableArea, "Rentable area");
  if (rentableArea != null && cmp(rentableArea, "0") <= 0) throw new PropertyManagementError("Rentable area must be positive");
  if (input.bedrooms != null && (!Number.isInteger(input.bedrooms) || input.bedrooms < 0)) {
    throw new PropertyManagementError("Bedrooms must be a non-negative whole number");
  }
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    // Lock the property before inserting: a concurrent rehome must not move
    // the unit's entity out from under a restricted creator.
    await lockPropertyInScope(tx, input.orgId, input.propertyId, input.allowedSubsidiaryIds);
    const result = (await tx.execute<{ id: string }>(sql`
      insert into property_units(org_id,property_id,code,name,unit_type,rentable_area,bedrooms,created_by,updated_by)
      select ${input.orgId},id,${input.code.trim()},${input.name ?? null},${input.unitType ?? null},${rentableArea},${input.bedrooms ?? null},${input.actorId},${input.actorId}
        from managed_properties where org_id=${input.orgId} and id=${input.propertyId} and status='active' returning id
    `));
    if (!result.rows[0]) throw new PropertyManagementError("Active property not found");
    await audit(tx, input.orgId, "property_units", result.rows[0].id, "insert", input.actorId, { propertyId: input.propertyId, code: input.code.trim() });
    return { id: result.rows[0].id };
  });
}
export async function updatePropertyUnit(input: {
  orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; unitId: string; code: string; name?: string | null;
  unitType?: string | null; rentableArea?: string | null; bedrooms?: number | null; status?: string;
  reason?: string | null;
}): Promise<{ id: string }> {
  const code = input.code.trim();
  const rentableArea = input.rentableArea == null || input.rentableArea === "" ? null : exactMoney(input.rentableArea, "Rentable area");
  if (!code) throw new PropertyManagementError("Unit code is required");
  if (rentableArea != null && cmp(rentableArea, "0") <= 0) throw new PropertyManagementError("Rentable area must be positive");
  if (input.bedrooms != null && (!Number.isInteger(input.bedrooms) || input.bedrooms < 0)) {
    throw new PropertyManagementError("Bedrooms must be a non-negative whole number");
  }
  const changeReason = input.reason?.trim() ? input.reason.trim() : null;
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    const currentResult = (await tx.execute<{
      status: string; has_active_lease: boolean; code: string; name: string | null;
      unit_type: string | null; rentable_area: string | null; bedrooms: number | null;
      property_id: string;
    }>(sql`
      select u.status,u.code,u.name,u.unit_type,u.rentable_area::text as rentable_area,u.bedrooms,u.property_id,
        exists(select 1 from property_leases l where l.org_id=u.org_id and l.unit_id=u.id and l.status in ('active','notice')) as has_active_lease
      from property_units u where u.org_id=${input.orgId} and u.id=${input.unitId} for update
    `));
    const current = currentResult.rows[0];
    if (!current) throw new PropertyManagementError("Unit not found");
    await lockPropertyInScope(tx, input.orgId, String(current.property_id), input.allowedSubsidiaryIds);
    const status = input.status ?? current.status;
    if (!["vacant", "occupied", "notice", "offline"].includes(status)) throw new PropertyManagementError("Invalid unit status");
    if (current.has_active_lease && status !== current.status) throw new PropertyManagementError("End the active lease before changing unit availability");
    if (!current.has_active_lease && ["occupied", "notice"].includes(status)) throw new PropertyManagementError("Unit occupancy is controlled by lease activation");
    const name = input.name?.trim() || null;
    const unitType = input.unitType?.trim() || null;
    const bedrooms = input.bedrooms ?? null;
    const result = (await tx.execute<{ id: string; propertyId: string }>(sql`
      update property_units set code=${code},name=${name},unit_type=${unitType},
        rentable_area=${rentableArea},bedrooms=${bedrooms},status=${status},updated_at=now(),updated_by=${input.actorId}
      where org_id=${input.orgId} and id=${input.unitId} returning id,property_id as "propertyId"
    `));
    const unit = result.rows[0];
    if (!unit) throw new PropertyManagementError("Unit not found");
    // Rentable area is the CAM weight and bedrooms/status drive availability:
    // the audit carries the full before/after pair (the lease-update shape),
    // never just the new code, so a later allocation can be traced to the
    // edit that moved it.
    const before = {
      code: current.code, name: current.name, unitType: current.unit_type,
      rentableArea: current.rentable_area == null ? null : normalizeMoney(current.rentable_area),
      bedrooms: current.bedrooms, status: current.status,
    };
    const after = { code, name, unitType, rentableArea, bedrooms, status };
    await audit(tx, input.orgId, "property_units", unit.id, "update", input.actorId, {
      propertyId: unit.propertyId,
      before,
      after,
      changedFields: Object.keys(after).filter((key) => JSON.stringify(after[key as keyof typeof after]) !== JSON.stringify(before[key as keyof typeof before])),
      ...(changeReason == null ? {} : { reason: changeReason }),
    });
    return { id: unit.id };
  });
}
export async function deletePropertyUnit(orgId: string, actorId: string, allowedSubsidiaryIds: ReadonlySet<string> | null, unitId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    const record = (await tx.execute<{ code: string; propertyId: string; has_leases: boolean }>(sql`
      select u.code,u.property_id as "propertyId",
        exists(select 1 from property_leases where org_id=u.org_id and unit_id=u.id) as has_leases
      from property_units u where u.org_id=${orgId} and u.id=${unitId} for update
    `));
    const row = record.rows[0];
    if (!row) throw new PropertyManagementError("Unit not found");
    await lockPropertyInScope(tx, orgId, String(row.propertyId), allowedSubsidiaryIds);
    if (row.has_leases) throw new PropertyManagementError("A unit with lease history cannot be deleted; take it offline instead");
    await tx.execute(sql`delete from property_units where org_id=${orgId} and id=${unitId}`);
    await audit(tx, orgId, "property_units", unitId, "delete", actorId, { before: { code: row.code, propertyId: row.propertyId } });
  });
}
