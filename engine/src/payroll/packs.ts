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
 * A future US pack declares its own slots (FIT withholding, FICA, FUTA/SUTA)
 * the same way — nothing in the settings UI or the commit path is
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
  US: { country: "US", installable: false, statutorySlots: [] },
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
