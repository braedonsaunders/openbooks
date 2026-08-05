import { sql } from "drizzle-orm";
import { db } from "../db.ts";

/**
 * Payroll country packs — the jurisdiction layer.
 *
 * A pack declares its statutory liability SLOTS: named account destinations
 * for the withholdings its engine computes, each mapped to the seeded
 * components it covers. Slot values live on pay_components.liability_account_id
 * (set for every mapped component at once), so the posting path needs no
 * jurisdiction knowledge at all — it just follows the component's account.
 * Legacy orgs configured before packs existed fall back to the old
 * orgs.settings.payroll keys named here; new configuration always writes
 * the components.
 *
 * The US pack declares its slots (FIT withholding, FICA, FUTA, SUTA) the
 * same way — nothing in the settings UI or the commit path is
 * Canada-specific.
 */

export interface PayrollStatutorySlot {
  key: string;
  /** Seeded pay_components.code values this slot's account applies to. */
  componentCodes: readonly string[];
  /** Pre-pack orgs.settings.payroll key honoured as a read fallback. */
  legacySettingsKey?: string;
}

export interface PayrollCountryPack {
  country: string;
  installable: boolean;
  statutorySlots: readonly PayrollStatutorySlot[];
}

export const PAYROLL_COUNTRY_PACKS: Record<string, PayrollCountryPack> = {
  CA: {
    country: "CA",
    installable: true,
    statutorySlots: [
      { key: "income_tax", componentCodes: ["TAX"], legacySettingsKey: "taxPayableAccountId" },
      { key: "cpp", componentCodes: ["CPP", "CPP2", "CPP-ER"], legacySettingsKey: "cppPayableAccountId" },
      { key: "ei", componentCodes: ["EI", "EI-ER"], legacySettingsKey: "eiPayableAccountId" },
      { key: "qpip", componentCodes: ["QPIP", "QPIP-ER"], legacySettingsKey: "eiPayableAccountId" },
      { key: "vacation", componentCodes: ["VAC"], legacySettingsKey: "vacationPayableAccountId" },
    ],
  },
  US: {
    country: "US",
    installable: true,
    statutorySlots: [
      { key: "fit", componentCodes: ["FIT"] },
      { key: "fica", componentCodes: ["SS", "MED", "MED2", "SS-ER", "MED-ER"] },
      { key: "futa", componentCodes: ["FUTA"] },
      { key: "suta", componentCodes: ["SUTA"] },
    ],
  },
};

export interface PackSlotState {
  country: string;
  slots: { key: string; accountId: string | null }[];
}

/**
 * Installed packs with each slot's current account: the mapped components'
 * liability account when set, else the legacy settings fallback.
 */
export async function packSlotState(
  orgId: string,
  installedCountries: string[],
  legacySettings: Record<string, unknown>,
): Promise<PackSlotState[]> {
  const packs = installedCountries
    .map((country) => PAYROLL_COUNTRY_PACKS[country])
    .filter((pack): pack is PayrollCountryPack => Boolean(pack));
  if (packs.length === 0) return [];
  const components = (await db.execute(sql`
    select code, liability_account_id from pay_components
     where org_id = ${orgId} and system_key is not null
  `)) as unknown as { rows: { code: string; liability_account_id: string | null }[] };
  const byCode = new Map(components.rows.map((c) => [c.code, c.liability_account_id]));
  return packs.map((pack) => ({
    country: pack.country,
    slots: pack.statutorySlots.map((slot) => {
      const fromComponents = slot.componentCodes
        .map((code) => byCode.get(code))
        .find((accountId) => accountId != null);
      const legacy = slot.legacySettingsKey
        ? ((legacySettings[slot.legacySettingsKey] as string | null | undefined) ?? null)
        : null;
      return { key: slot.key, accountId: fromComponents ?? legacy };
    }),
  }));
}

export class PayrollPackError extends Error {}

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
    db.execute(sql`
      select count(*)::int as n from employee_payroll_profiles
       where org_id = ${orgId} and country = ${country} and is_active`),
    db.execute(sql`
      select count(distinct l.stub_id)::int as n
        from pay_stub_lines l
        join pay_components c on c.id = l.component_id
       where l.org_id = ${orgId} and c.country = ${country} and c.system_key is not null`),
  ])) as unknown as { rows: { n: number }[] }[];

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
    const removed = (await tx.execute(sql`
      delete from pay_components
       where org_id = ${orgId} and country = ${country} and system_key is not null
       returning id`)) as unknown as { rows: { id: string }[] };
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
  if (!slot) throw new Error(`unknown payroll pack slot ${country}/${slotKey}`);
  await db.execute(sql`
    update pay_components
       set liability_account_id = ${accountId}, updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and code = any(${`{${slot.componentCodes.join(",")}}`}::text[])
  `);
}
