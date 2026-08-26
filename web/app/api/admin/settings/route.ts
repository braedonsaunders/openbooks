import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  assertValidControlAccountMappings,
  CONTROL_ACCOUNT_ROLES,
  ControlAccountsIncompleteError,
  type ControlAccountRecord,
  type OrgControlAccounts,
} from "@openbooks/engine/src/control-accounts.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { DEFAULT_LOCALE, isLocale } from "../../../../i18n/config";
import { normalizeCountryCode } from "../../../../lib/countries";
import { periodDerivationSql } from "../../../../lib/fiscal-periods";

export const runtime = "nodejs";

/**
 * Company & Accounting settings. GET preserves the user-administration view of
 * non-financial organization identity/locale only. PUT persists the complete
 * setup policy: identity, base currency, fiscal calendar, tax/revenue policy,
 * and control accounts.
 *
 * Reads retain the existing user-administration gate because the response is
 * deliberately limited to identity/locale metadata. Every write is a setup
 * operation and is separately gated by admin.setup.manage: even an
 * identity-only payload shares one authoritative settings mutation boundary
 * with ledger policy and must never inherit user-administration authority.
 *
 * Changing the fiscal-year start month re-derives every accounting period's
 * fiscal_year / period_number / name from its start date, inside a transaction
 * that drops and recreates the (org_id, fiscal_year, period_number) unique
 * index so the intermediate state can't collide.
 */

const SETTINGS_READ_PERMISSION = "admin.users.manage";
const SETTINGS_WRITE_PERMISSION = "admin.setup.manage";

export async function GET() {
  const gate = await guardPermission(SETTINGS_READ_PERMISSION);
  if (gate instanceof NextResponse) return gate;
  const { orgId } = gate.user;

  const org = await db.execute(sql`
    select id, name, legal_name, country, settings
      from orgs where id = ${orgId}`);

  const row = org.rows[0];
  if (!row)
    return NextResponse.json({ error: "org not found" }, { status: 404 });
  const settings = (row.settings ?? {}) as Record<string, unknown>;

  return NextResponse.json({
    org: {
      name: row.name as string,
      legalName: (row.legal_name as string | null) ?? "",
      country: row.country as string,
      defaultLocale: isLocale(settings.defaultLocale)
        ? settings.defaultLocale
        : DEFAULT_LOCALE,
    },
  });
}

export async function PUT(req: Request) {
  const gate = await guardPermission(SETTINGS_WRITE_PERMISSION);
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;
  const { orgId } = actor;

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    name?: unknown;
    legalName?: unknown;
    country?: unknown;
    baseCurrency?: unknown;
    fiscalYearStartMonth?: unknown;
    taxFramework?: unknown;
    controlAccounts?: unknown;
    defaultLocale?: unknown;
    reportPdfStyle?: unknown;
    fairValueRangePolicy?: unknown;
  };

  // This feature probe does not contribute persisted state. Do it before the
  // row lock so disabled-feature requests cannot hold an accounting-policy
  // writer behind unrelated feature resolution.
  if (
    body.fairValueRangePolicy !== undefined &&
    !(await isFeatureEnabled(orgId, "revenueRecognition"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Lock first, then re-read, derive, persist, and audit through one
  // transaction. Concurrent editors therefore build on the latest committed
  // JSON document instead of spreading a stale snapshot over one another.
  return db.transaction(async (tx) => {
    const existing = await tx.execute(sql`
    select name, legal_name, base_currency, country, settings
      from orgs where id = ${orgId} for update`);
    const cur = existing.rows[0];
    if (!cur)
      return NextResponse.json({ error: "org not found" }, { status: 404 });
    const settings = (cur.settings ?? {}) as Record<string, unknown>;

    const changes: Record<string, unknown> = {};
    const sets: SQL[] = [];

    // --- display name (required) ---
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return NextResponse.json(
          { error: "display name is required" },
          { status: 400 },
        );
      }
      const name = body.name.trim();
      if (name !== cur.name) {
        sets.push(sql`name = ${name}`);
        changes.name = [cur.name, name];
      }
    }

    // --- legal name (optional) ---
    if (body.legalName !== undefined) {
      if (typeof body.legalName !== "string") {
        return NextResponse.json(
          { error: "legal name must be text" },
          { status: 400 },
        );
      }
      const legalName = body.legalName.trim() || null;
      if (legalName !== cur.legal_name) {
        sets.push(sql`legal_name = ${legalName}`);
        changes.legalName = [cur.legal_name, legalName];
      }
    }

    // --- country (ISO 3166-1 alpha-2) ---
    if (body.country !== undefined) {
      const country = normalizeCountryCode(body.country);
      if (!country) {
        return NextResponse.json(
          { error: "country must be a valid ISO country code" },
          { status: 400 },
        );
      }
      if (country !== cur.country) {
        sets.push(sql`country = ${country}`);
        changes.country = [cur.country, country];
      }
    }

    // --- base currency (must be a known currency) ---
    if (body.baseCurrency !== undefined) {
      if (
        typeof body.baseCurrency !== "string" ||
        !/^[A-Z]{3}$/.test(body.baseCurrency)
      ) {
        return NextResponse.json(
          { error: "base currency must be a 3-letter code" },
          { status: 400 },
        );
      }
      const known = await tx.execute(
        sql`select 1 from currencies where code = ${body.baseCurrency} limit 1`,
      );
      if (!known.rows[0]) {
        return NextResponse.json(
          {
            error: `unknown currency "${body.baseCurrency}" — add it to the currency table first`,
          },
          { status: 400 },
        );
      }
      if (body.baseCurrency !== cur.base_currency) {
        const ledgerEvidence = await tx.execute(sql`
        select exists (
          select 1 from journal_lines where org_id = ${orgId} limit 1
        ) as exists`);
        if (ledgerEvidence.rows[0]?.exists) {
          return NextResponse.json(
            {
              error: "base-currency-locked",
              message: "Cannot change base currency after postings exist.",
            },
            { status: 409 },
          );
        }
        sets.push(sql`base_currency = ${body.baseCurrency}`);
        changes.baseCurrency = [cur.base_currency, body.baseCurrency];
      }
    }

    // --- control accounts (validated against real, non-summary accounts) ---
    let nextControl: Record<string, string> | undefined;
    if (body.controlAccounts !== undefined) {
      if (
        typeof body.controlAccounts !== "object" ||
        body.controlAccounts === null ||
        Array.isArray(body.controlAccounts)
      ) {
        return NextResponse.json(
          { error: "controlAccounts must be an object" },
          { status: 400 },
        );
      }
      const input = body.controlAccounts as Record<string, unknown>;
      const currentControl =
        settings.controlAccounts && typeof settings.controlAccounts === "object"
          ? (settings.controlAccounts as Record<string, unknown>)
          : {};
      const collected: Record<string, unknown> = { ...currentControl };
      for (const key of CONTROL_ACCOUNT_ROLES) {
        const v = input[key];
        if (v === undefined) continue;
        if (v === null || v === "") {
          delete collected[key];
          continue;
        }
        if (typeof v !== "string" || !isUuid(v)) {
          return NextResponse.json(
            { error: `${key} must be an account id` },
            { status: 400 },
          );
        }
        collected[key] = v;
      }
      const ids = new Set<string>();
      for (const key of CONTROL_ACCOUNT_ROLES) {
        const accountId = collected[key];
        if (accountId === undefined) continue;
        if (typeof accountId !== "string" || !isUuid(accountId)) {
          return NextResponse.json(
            { error: `${key}: stored control account id is invalid` },
            { status: 400 },
          );
        }
        ids.add(accountId);
      }
      if (ids.size > 0) {
        const found = await tx.execute<ControlAccountRecord>(sql`
        select id, type, is_active as "isActive", is_summary as "isSummary"
          from accounts
         where org_id = ${orgId} and id in (${sql.join(
           [...ids].map((i) => sql`${i}`),
           sql`, `,
         )})
         for share`);
        try {
          assertValidControlAccountMappings(
            collected as OrgControlAccounts,
            found.rows,
          );
        } catch (error) {
          if (error instanceof ControlAccountsIncompleteError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
          }
          throw error;
        }
      }
      nextControl = collected as Record<string, string>;
    }

    // --- tenant default language (users without a personal locale inherit it) ---
    let nextDefaultLocale: string | undefined;
    if (body.defaultLocale !== undefined) {
      if (!isLocale(body.defaultLocale)) {
        return NextResponse.json(
          { error: "unsupported locale" },
          { status: 400 },
        );
      }
      nextDefaultLocale = body.defaultLocale;
    }

    // --- fiscal year start month ---
    let nextStartMonth: number | undefined;
    if (body.fiscalYearStartMonth !== undefined) {
      const m = Number(body.fiscalYearStartMonth);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        return NextResponse.json(
          { error: "fiscalYearStartMonth must be 1–12" },
          { status: 400 },
        );
      }
      nextStartMonth = m;
    }

    // Assemble the settings jsonb (merge, don't clobber sibling keys like eft).
    const curStartMonth =
      typeof settings.fiscalYearStartMonth === "number"
        ? settings.fiscalYearStartMonth
        : 1;
    const startMonthChanged =
      nextStartMonth !== undefined && nextStartMonth !== curStartMonth;
    const nextSettings = { ...settings } as Record<string, unknown>;
    let settingsChanged = false;
    if (nextStartMonth !== undefined && nextStartMonth !== curStartMonth) {
      nextSettings.fiscalYearStartMonth = nextStartMonth;
      changes.fiscalYearStartMonth = [curStartMonth, nextStartMonth];
      settingsChanged = true;
    }
    if (body.taxFramework !== undefined) {
      if (body.taxFramework !== "asc740" && body.taxFramework !== "ias12") {
        return NextResponse.json(
          { error: "taxFramework must be asc740 or ias12" },
          { status: 400 },
        );
      }
      const curFramework =
        settings.taxFramework === "ias12" ? "ias12" : "asc740";
      if (body.taxFramework !== curFramework) {
        nextSettings.taxFramework = body.taxFramework;
        changes.taxFramework = [curFramework, body.taxFramework];
        settingsChanged = true;
      }
    }
    if (nextControl !== undefined) {
      const curControl = (settings.controlAccounts ?? {}) as Record<
        string,
        string
      >;
      if (JSON.stringify(curControl) !== JSON.stringify(nextControl)) {
        nextSettings.controlAccounts = nextControl;
        changes.controlAccounts = [curControl, nextControl];
        settingsChanged = true;
      }
    }
    const curDefaultLocale = isLocale(settings.defaultLocale)
      ? settings.defaultLocale
      : DEFAULT_LOCALE;
    if (
      nextDefaultLocale !== undefined &&
      nextDefaultLocale !== curDefaultLocale
    ) {
      nextSettings.defaultLocale = nextDefaultLocale;
      changes.defaultLocale = [curDefaultLocale, nextDefaultLocale];
      settingsChanged = true;
    }
    // --- financial report PDF style (formal GAAP / modern branded) ---
    if (body.reportPdfStyle !== undefined) {
      const style = body.reportPdfStyle === "formal" ? "formal" : "modern";
      const curStyle =
        settings.reportPdfStyle === "formal" ? "formal" : "modern";
      if (style !== curStyle) {
        nextSettings.reportPdfStyle = style;
        changes.reportPdfStyle = [curStyle, style];
        settingsChanged = true;
      }
    }
    // --- fair value range policy (rev-rec allocation review: warn | off) ---
    // The policy lives on Company Settings, but it belongs to Revenue
    // Recognition. Turning that switch off must refuse a new write; the stored
    // value stays so turning the feature back on restores the same review rule.
    if (body.fairValueRangePolicy !== undefined) {
      if (
        body.fairValueRangePolicy !== "warn" &&
        body.fairValueRangePolicy !== "off"
      ) {
        return NextResponse.json(
          { error: "fairValueRangePolicy must be 'warn' or 'off'" },
          { status: 400 },
        );
      }
      const curRevenue = (settings.revenue ?? {}) as Record<string, unknown>;
      const curPolicy =
        curRevenue.fairValueRangePolicy === "off" ? "off" : "warn";
      if (body.fairValueRangePolicy !== curPolicy) {
        nextSettings.revenue = {
          ...curRevenue,
          fairValueRangePolicy: body.fairValueRangePolicy,
        };
        changes.fairValueRangePolicy = [curPolicy, body.fairValueRangePolicy];
        settingsChanged = true;
      }
    }
    if (settingsChanged) {
      sets.push(sql`settings = ${JSON.stringify(nextSettings)}::jsonb`);
    }

    if (sets.length === 0) {
      return NextResponse.json({ ok: true, changed: false });
    }

    // Persist org fields (+ settings) and, when the fiscal start moved, re-derive
    // every period. Audit evidence is the final statement in this SAME
    // transaction, so its failure rolls back org, calendar, and period changes.
    const effectiveStart = nextStartMonth ?? curStartMonth;
    await tx.execute(sql`
    update orgs
       set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${actor.id}
     where id = ${orgId}`);

    if (startMonthChanged) {
      // Drop the (org_id, fiscal_year, period_number) unique index so the
      // in-flight re-labelling can't collide, re-derive, then recreate it.
      await tx.execute(sql`drop index if exists periods_org_year_num`);
      await tx.execute(periodDerivationSql(orgId, effectiveStart));
      await tx.execute(sql`
      update fiscal_calendars
         set year_start_month = ${effectiveStart}, updated_at = now(), updated_by = ${actor.id}
       where org_id = ${orgId} and is_default`);
      await tx.execute(sql`
      create unique index periods_org_year_num
        on accounting_periods (org_id, fiscal_year, period_number)`);
    }

    await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'orgs', ${orgId}, 'update',
            ${JSON.stringify(changes)}, ${actor.id})`);

    return NextResponse.json({
      ok: true,
      changed: true,
      periodsRederived: startMonthChanged,
    });
  });
}
