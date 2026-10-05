import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { portalRefusal } from "./errors.ts";
import { recordPortalEvent } from "./tokens.ts";

export const PORTAL_SECTIONS = [
  "invoices",
  "paymentMethods",
  "subscriptions",
  "usage",
  "orders",
  "returns",
  "giftCards",
] as const;

export type PortalSection = (typeof PORTAL_SECTIONS)[number];

export type PortalSaveOffer =
  | { id: string; kind: "pause"; label: string; note?: string }
  | { id: string; kind: "discount"; label: string; promotionCode: string; note?: string };

export type PortalSettings = {
  portalName: string;
  sections: Record<PortalSection, boolean>;
  returnWindowDays: number;
  returnReasons: string[];
  returnResolutions: {
    refund: boolean;
    exchange: boolean;
    storeCredit: boolean;
    storeCreditBonusPercent: string;
  };
  saveOffers: PortalSaveOffer[];
};

export const DEFAULT_PORTAL_SETTINGS: PortalSettings = {
  portalName: "Customer portal",
  sections: {
    invoices: true,
    paymentMethods: true,
    subscriptions: true,
    usage: true,
    orders: true,
    returns: true,
    giftCards: true,
  },
  returnWindowDays: 30,
  returnReasons: ["damaged", "wrong_item", "not_as_described", "changed_mind", "late_delivery"],
  returnResolutions: { refund: true, exchange: true, storeCredit: true, storeCreditBonusPercent: "0" },
  saveOffers: [],
};

type SettingsRow = {
  portal_name: string;
  sections: unknown;
  return_window_days: number;
  return_reasons: unknown;
  return_resolutions: unknown;
  save_offers: unknown;
};

/** Merge a stored row over the defaults so newer sections default on for older rows. Pure. */
export function mergePortalSettings(row: SettingsRow | null): PortalSettings {
  if (!row) return structuredClone(DEFAULT_PORTAL_SETTINGS);
  const sections = { ...DEFAULT_PORTAL_SETTINGS.sections };
  if (row.sections && typeof row.sections === "object" && !Array.isArray(row.sections)) {
    for (const section of PORTAL_SECTIONS) {
      const value = (row.sections as Record<string, unknown>)[section];
      if (typeof value === "boolean") sections[section] = value;
    }
  }
  const resolutions = { ...DEFAULT_PORTAL_SETTINGS.returnResolutions };
  if (row.return_resolutions && typeof row.return_resolutions === "object") {
    const stored = row.return_resolutions as Record<string, unknown>;
    for (const key of ["refund", "exchange", "storeCredit"] as const) {
      if (typeof stored[key] === "boolean") resolutions[key] = stored[key];
    }
    if (typeof stored.storeCreditBonusPercent === "string") {
      resolutions.storeCreditBonusPercent = stored.storeCreditBonusPercent;
    }
  }
  return {
    portalName: typeof row.portal_name === "string" && row.portal_name.trim() ? row.portal_name : DEFAULT_PORTAL_SETTINGS.portalName,
    sections,
    returnWindowDays: Number.isInteger(row.return_window_days) && row.return_window_days >= 0
      ? row.return_window_days
      : DEFAULT_PORTAL_SETTINGS.returnWindowDays,
    returnReasons: Array.isArray(row.return_reasons)
      ? row.return_reasons.filter((reason): reason is string => typeof reason === "string" && reason.trim().length > 0)
      : [...DEFAULT_PORTAL_SETTINGS.returnReasons],
    returnResolutions: resolutions,
    saveOffers: Array.isArray(row.save_offers)
      ? (row.save_offers.filter((offer): offer is PortalSaveOffer => isSaveOffer(offer)) as PortalSaveOffer[])
      : [],
  };
}

function isSaveOffer(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const offer = value as Record<string, unknown>;
  if (typeof offer.id !== "string" || !offer.id.trim()) return false;
  if (offer.kind === "pause") return typeof offer.label === "string" && !!offer.label.trim();
  if (offer.kind === "discount") {
    return typeof offer.label === "string" && !!offer.label.trim()
      && typeof offer.promotionCode === "string" && !!offer.promotionCode.trim();
  }
  return false;
}

/** Last returnable day for a source document: document date + window days. Pure. */
export function returnWindowDeadline(documentDate: string, windowDays: number): string {
  return addCalendarDays(documentDate, windowDays);
}

export async function readPortalSettings(orgId: string, runner: SqlExecutor = db): Promise<PortalSettings> {
  const row = (await runner.execute<SettingsRow>(sql`
    select portal_name, sections, return_window_days, return_reasons, return_resolutions, save_offers
      from customer_portal_settings
     where org_id = ${orgId} and effective_from <= current_date
     order by effective_from desc
     limit 1
  `)).rows[0] ?? null;
  return mergePortalSettings(row);
}

export type SavePortalSettingsInput = {
  portalName?: unknown;
  sections?: unknown;
  returnWindowDays?: unknown;
  returnReasons?: unknown;
  returnResolutions?: unknown;
  saveOffers?: unknown;
  effectiveFrom?: string | null;
};

function parseSettingsInput(input: SavePortalSettingsInput): Omit<SettingsRow, "portal_name"> & { portalName: string } {
  const settings = structuredClone(DEFAULT_PORTAL_SETTINGS);
  if (input.portalName !== undefined) {
    if (typeof input.portalName !== "string" || !input.portalName.trim() || input.portalName.trim().length > 80) {
      throw portalRefusal("The portal name must be 1–80 characters", "invalid_input", 422, "Enter a short customer-facing portal name");
    }
    settings.portalName = input.portalName.trim();
  }
  if (input.sections !== undefined) {
    if (!input.sections || typeof input.sections !== "object" || Array.isArray(input.sections)) {
      throw portalRefusal("Portal sections must name each section on or off", "invalid_input", 422, "Switch each portal section on or off");
    }
    for (const section of PORTAL_SECTIONS) {
      const value = (input.sections as Record<string, unknown>)[section];
      if (value !== undefined) {
        if (typeof value !== "boolean") {
          throw portalRefusal(`Portal section ${section} must be on or off`, "invalid_input", 422, "Switch each portal section on or off");
        }
        settings.sections[section] = value;
      }
    }
  }
  if (input.returnWindowDays !== undefined) {
    const days = typeof input.returnWindowDays === "string" && input.returnWindowDays.trim() !== ""
      ? Number(input.returnWindowDays)
      : input.returnWindowDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 365) {
      throw portalRefusal("The return window must be 0–365 days", "invalid_input", 422, "Enter whole days from 0 to 365");
    }
    settings.returnWindowDays = days;
  }
  if (input.returnReasons !== undefined) {
    if (!Array.isArray(input.returnReasons) || input.returnReasons.length === 0 || input.returnReasons.length > 20
      || !input.returnReasons.every((reason) => typeof reason === "string" && reason.trim() && reason.trim().length <= 40)) {
      throw portalRefusal("Return reasons must be 1–20 short labels", "invalid_input", 422, "List up to twenty short return reasons");
    }
    settings.returnReasons = input.returnReasons.map((reason) => (reason as string).trim());
  }
  if (input.returnResolutions !== undefined) {
    const resolutions = input.returnResolutions as Record<string, unknown>;
    if (!resolutions || typeof resolutions !== "object" || Array.isArray(resolutions)) {
      throw portalRefusal("Return resolutions must name each outcome on or off", "invalid_input", 422, "Switch refund, exchange and store credit on or off");
    }
    for (const key of ["refund", "exchange", "storeCredit"] as const) {
      if (resolutions[key] !== undefined) {
        if (typeof resolutions[key] !== "boolean") {
          throw portalRefusal(`Return resolution ${key} must be on or off`, "invalid_input", 422, "Switch refund, exchange and store credit on or off");
        }
        settings.returnResolutions[key] = resolutions[key];
      }
    }
    if (resolutions.storeCreditBonusPercent !== undefined) {
      const bonus = String(resolutions.storeCreditBonusPercent);
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(bonus) || Number(bonus) > 100) {
        throw portalRefusal("The store credit bonus must be 0–100 percent", "invalid_input", 422, "Enter a bonus percent from 0 to 100");
      }
      settings.returnResolutions.storeCreditBonusPercent = bonus;
    }
    if (!settings.returnResolutions.refund && !settings.returnResolutions.exchange && !settings.returnResolutions.storeCredit) {
      throw portalRefusal("At least one return outcome must stay on", "invalid_input", 422, "Keep refund, exchange or store credit enabled");
    }
  }
  if (input.saveOffers !== undefined) {
    if (!Array.isArray(input.saveOffers) || input.saveOffers.length > 10 || !input.saveOffers.every(isSaveOffer)) {
      throw portalRefusal("Save offers must each name a pause or a discount with a promotion code", "invalid_input", 422, "Add up to ten pause or discount offers with labels");
    }
    settings.saveOffers = input.saveOffers as PortalSaveOffer[];
  }
  return {
    portalName: settings.portalName,
    sections: settings.sections,
    return_window_days: settings.returnWindowDays,
    return_reasons: settings.returnReasons,
    return_resolutions: settings.returnResolutions,
    save_offers: settings.saveOffers,
  };
}

/**
 * Save the portal configuration as a new effective-dated row (or rewrite
 * today's row, which carries the same effective date). Operator action:
 * audited to audit_log, never to the customer event trail.
 */
export async function savePortalSettings(
  orgId: string,
  actorId: string,
  input: SavePortalSettingsInput,
): Promise<PortalSettings> {
  const parsed = parseSettingsInput(input);
  if (input.effectiveFrom !== undefined && input.effectiveFrom !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) {
    throw portalRefusal("The effective date must be a calendar date", "invalid_input", 422, "Pick the date the new portal rules start");
  }
  return withOrgTransaction(orgId, async () => {
    const effectiveFrom = input.effectiveFrom ?? await businessTodayInTx(db, orgId);
    const existing = (await db.execute<{ id: string }>(sql`
      select id from customer_portal_settings
       where org_id = ${orgId} and effective_from = ${effectiveFrom}
       limit 1
      for update
    `)).rows[0];
    let settingsId: string;
    if (existing) {
      const updated = (await db.execute<{ id: string }>(sql`
        update customer_portal_settings
           set portal_name = ${parsed.portalName}, sections = ${JSON.stringify(parsed.sections)}::jsonb,
               return_window_days = ${parsed.return_window_days},
               return_reasons = ${JSON.stringify(parsed.return_reasons)}::jsonb,
               return_resolutions = ${JSON.stringify(parsed.return_resolutions)}::jsonb,
               save_offers = ${JSON.stringify(parsed.save_offers)}::jsonb,
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${existing.id}
        returning id
      `)).rows[0];
      if (!updated) throw portalRefusal("The portal settings changed while saving", "changed_concurrently", 409, "Reload the portal settings and save again");
      settingsId = updated.id;
    } else {
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into customer_portal_settings
          (org_id, effective_from, portal_name, sections, return_window_days,
           return_reasons, return_resolutions, save_offers, created_by, updated_by)
        values (${orgId}, ${effectiveFrom}, ${parsed.portalName}, ${JSON.stringify(parsed.sections)}::jsonb,
                ${parsed.return_window_days}, ${JSON.stringify(parsed.return_reasons)}::jsonb,
                ${JSON.stringify(parsed.return_resolutions)}::jsonb, ${JSON.stringify(parsed.save_offers)}::jsonb,
                ${actorId}, ${actorId})
        returning id
      `)).rows[0];
      if (!inserted) throw new Error("portal settings were not saved");
      settingsId = inserted.id;
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'customer_portal_settings', ${settingsId},
              ${existing ? "update" : "insert"},
              ${JSON.stringify({ event: "portal_settings_saved", effectiveFrom, after: parsed })}::jsonb, ${actorId})
    `);
    return readPortalSettings(orgId);
  });
}

/** Customer-audit helper for portal writes: one row per action, no silent writes. */
export async function auditCustomerAction(
  runner: SqlExecutor,
  orgId: string,
  partyId: string,
  linkId: string | null,
  action: string,
  reasonCode: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await recordPortalEvent(runner, orgId, { partyId, linkId, action, reasonCode, detail });
}
