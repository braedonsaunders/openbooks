/** Contributory-base and slot assertions. Split from packs.ts (pure moves only). */
import { type PayrollStatutorySlot, type PayrollCountryPack } from "./pack-types"
import { PAYROLL_COUNTRY_PACKS, payrollPack } from "./pack-registry"
import { sql } from "drizzle-orm"
import { assertValidControlAccountMappings, type ControlAccountRecord, type OrgControlAccounts } from "../records/control-accounts.ts"
import { db } from "../platform/db.ts"
import { PayrollPackError } from "./payroll-error.ts"

/**
 * Seed-time assertion of the contributory-bases declaration. The field is
 * required at compile time; this keeps a pack authored through a cast (tests,
 * scripts) from provisioning components whose pensionable/insurable flags
 * accumulate a base nobody named.
 */
export function assertContributoryBasesDeclared(country: string): void {
  const { contributoryBases } = payrollPack(country);
  if (!contributoryBases?.pensionable?.trim() || !contributoryBases?.insurable?.trim()) {
    throw new PayrollPackError(
      `the ${country} payroll pack does not declare its contributory bases — say what the `
      + "pensionable and insurable earning flags accumulate (engine/src/payroll/packs.ts "
      + "contributoryBases) before its components can be seeded",
    );
  }
}

export interface PackSlotState {
  country: string;
  /**
   * The pack's own display name, served alongside the code so surfaces that
   * list packs to a person never fall back to a bare country code. A
   * surface handed only codes has nothing to show but codes.
   */
  name: string;
  slots: { key: string; accountId: string | null }[];
}

/**
 * A slot with a `regions` declaration applies to a payroll population only
 * where they intersect. Absent population (a caller with no run or roster to
 * scope by) demands everything — today's behaviour — and a null or unknown
 * region still demands: demanding an account mapping is safe, skipping money
 * is not.
 */
export function packSlotAppliesToPopulation(
  slot: PayrollStatutorySlot,
  country: string,
  regionsByCountry?: ReadonlyMap<string, ReadonlySet<string | null>>,
): boolean {
  if (!slot.regions || slot.regions.length === 0) return true;
  const regions = regionsByCountry?.get(country);
  if (!regions || regions.size === 0) return true;
  const known = PAYROLL_COUNTRY_PACKS[country]?.regions?.known;
  for (const region of regions) {
    if (region == null || slot.regions.includes(region)) return true;
    // Fail-safe: a region code the pack does not declare (a typo'd province)
    // is not an inapplicable region — it is an unknown one, and demanding the
    // account mapping is safe while skipping money is not. The run still
    // refuses the undeclared region by name at calculate
    // (assertPayrollRegionSupported), so this demand is the setup half of
    // that refusal, not a second computation.
    if (region != null && known && !known.includes(region)) return true;
  }
  return false;
}

/**
 * Installed packs with each slot's current account: the mapped components'
 * liability account when set, else the legacy settings fallback. Slots that
 * do not apply to the given population are absent, not unmapped — an
 * Ontario-only run never sees the Québec slots at all.
 */
export async function packSlotState(
  orgId: string,
  installedCountries: string[],
  legacySettings: Record<string, unknown>,
  regionsByCountry?: ReadonlyMap<string, ReadonlySet<string | null>>,
): Promise<PackSlotState[]> {
  const packs = installedCountries
    .map((country) => PAYROLL_COUNTRY_PACKS[country])
    .filter((pack): pack is PayrollCountryPack => Boolean(pack));
  if (packs.length === 0) return [];
  const components = (await db.execute<{ country: string | null; code: string; liability_account_id: string | null }>(sql`
    select country, code, liability_account_id from pay_components
     where org_id = ${orgId} and system_key is not null
  `));
  // Keyed by country as well as code: two packs may declare the same code
  // (Canada and Australia both use WCB, 0248), and a code-only map would
  // collapse them to whichever row was read last.
  const byCountryCode = new Map(components.rows.map((c) => [`${c.country ?? ""}:${c.code}`, c.liability_account_id]));
  return packs.map((pack) => ({
    country: pack.country,
    name: pack.name,
    slots: pack.statutorySlots
      .filter((slot) => packSlotAppliesToPopulation(slot, pack.country, regionsByCountry))
      .map((slot) => {
        const fromComponents = slot.components
          .map((component) => byCountryCode.get(`${pack.country}:${component.code}`))
          .find((accountId) => accountId != null);
        const legacy = slot.legacySettingsKey
          ? ((legacySettings[slot.legacySettingsKey] as string | null | undefined) ?? null)
          : null;
        return { key: slot.key, accountId: fromComponents ?? legacy };
      }),
  }));
}

/**
 * Uninstall a country pack: remove its seeded statutory components and the
 * settings marker. Guarded — refuses while anything still depends on the
 * pack, with every blocker named:
 *   - active employee payroll profiles set to the country (their next
 *     calculation would need the pack's engine and components);
 *   - pay stubs whose lines reference the pack's components (payroll
 *     records must keep their component references forever).
 * User-authored components scoped to the country are left alone — they are
 * org configuration, not the pack's.
 */
export async function uninstallPayrollPack(
  orgId: string, actorId: string, country: string,
): Promise<{ componentsRemoved: number }> {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  if (!pack) throw new PayrollPackError(`unknown payroll country pack ${country}`);

  const [profiles, stubRefs] = (await Promise.all([
    db.execute<{ n: number }>(sql`
      select count(*)::int as n from employee_payroll_profiles
       where org_id = ${orgId} and country = ${country} and is_active`),
    db.execute<{ n: number }>(sql`
      select count(distinct l.stub_id)::int as n
        from pay_stub_lines l
        join pay_components c on c.id = l.component_id and c.org_id = l.org_id
       where l.org_id = ${orgId} and c.country = ${country} and c.system_key is not null`),
  ]));

  const blockers: string[] = [];
  const profileCount = Number(profiles.rows[0]?.n ?? 0);
  const stubCount = Number(stubRefs.rows[0]?.n ?? 0);
  if (profileCount > 0) {
    blockers.push(`${profileCount} active employee payroll profile(s) are set to ${country} — move or deactivate them first`);
  }
  if (stubCount > 0) {
    blockers.push(`${stubCount} pay stub(s) reference this pack's statutory components — payroll records keep the pack installed`);
  }
  if (blockers.length > 0) {
    throw new PayrollPackError(`cannot uninstall the ${country} pack: ${blockers.join("; ")}`);
  }

  return await db.transaction(async (tx) => {
    // Draft (uncommitted) stubs could still reference the components between
    // the check above and this delete; the FK makes that a loud failure, not
    // a silent orphan.
    const removed = (await tx.execute<{ id: string }>(sql`
      delete from pay_components
       where org_id = ${orgId} and country = ${country} and system_key is not null
       returning id`));
    await tx.execute(sql`
      update orgs
         set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb), '{payroll,countries}',
           coalesce((
             select jsonb_agg(value) from jsonb_array_elements_text(settings#>'{payroll,countries}')
              where value <> ${country}
           ), '[]'::jsonb))
       where id = ${orgId}`);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_components', ${orgId}, 'delete',
              ${JSON.stringify({ uninstalledPayrollPack: country })}, ${actorId})`);
    return { componentsRemoved: removed.rows.length };
  });
}

/** Write one slot's account onto every component the slot covers. */
export async function setPackSlotAccount(
  orgId: string,
  actorId: string,
  country: string,
  slotKey: string,
  accountId: string | null,
): Promise<void> {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  const slot = pack?.statutorySlots.find((s) => s.key === slotKey);
  if (!slot) throw new PayrollPackError(`unknown payroll pack slot ${country}/${slotKey}`);
  if (slot.components.length === 0) return;
  const updated = await db.execute(sql`
    update pay_components
       set liability_account_id = ${accountId}, updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and country = ${country}
       and code = any(${`{${slot.components.map((c) => c.code).join(",")}}`}::text[])
  `);
  // A mapping that touches no component row is a lost save: the setup surface
  // would report success while the slot stays unmapped (the pack's components
  // were never seeded). Refuse rather than report ok.
  if ((updated.rowCount ?? 0) === 0) {
    throw new PayrollPackError(
      `the ${country} "${slotKey}" slot has no seeded payroll components in this organization — `
      + `install the ${country} payroll pack before mapping its accounts`,
    );
  }
}

/**
 * Default a pack's role-declared slots onto the chart account their role
 * resolves to — but only where the operator has not mapped the slot yet.
 *
 * A pack names a ROLE (`liabilityAccountRole`), never an account number, and
 * the org's own chart resolves it, so a withheld-tax slot lands in the
 * payroll-deductions account of whichever chart the org uses (2110 here,
 * 2300 there) without the pack knowing either number. An explicit mapping
 * always wins: this fills `liability_account_id is null` rows only, so it
 * can complete setup but never re-point a configured liability. A role the
 * chart does not map leaves the slot unmapped rather than guessing — commit
 * still refuses an unmapped slot by name. A role mapped to a missing,
 * inactive, or wrong-typed account fails closed here instead of wiring a
 * liability nobody can remit from.
 */
export async function ensurePackSlotRoleAccounts(
  executor: Pick<typeof db, "execute">,
  orgId: string,
  actorId: string | null,
  country: string,
): Promise<void> {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  if (!pack) throw new PayrollPackError(`unknown payroll country pack ${country}`);
  const slots = pack.statutorySlots.filter((slot) => slot.liabilityAccountRole);
  if (slots.length === 0) return;
  const settings = (await executor.execute<{ control: unknown }>(sql`
    select settings->'controlAccounts' as control from orgs where id = ${orgId}`));
  const control = (settings.rows[0]?.control ?? {}) as Record<string, unknown>;
  for (const slot of slots) {
    const role = slot.liabilityAccountRole!;
    const accountId = control[role];
    // No role mapping: the operator maps the slot by hand, exactly as a pack
    // without a role declaration. Never invent an account.
    if (accountId == null || accountId === "") continue;
    if (typeof accountId !== "string") {
      throw new PayrollPackError(
        `the ${role} control account is not an account id — map it to the payroll-deductions `
        + "account before installing payroll",
      );
    }
    const records = (await executor.execute<ControlAccountRecord>(sql`
      select id, type, is_active as "isActive", is_summary as "isSummary"
        from accounts
       where org_id = ${orgId} and id = ${accountId}`));
    assertValidControlAccountMappings({ [role]: accountId } as OrgControlAccounts, records.rows);
    await executor.execute(sql`
      update pay_components
         set liability_account_id = ${accountId}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId}
         and country = ${country}
         and code = any(${`{${slot.components.map((c) => c.code).join(",")}}`}::text[])
         and liability_account_id is null
    `);
  }
}
