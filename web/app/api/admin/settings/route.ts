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
import {
  periodDerivationSql,
  periodDerivationStagingSql,
} from "../../../../lib/fiscal-periods";

export const runtime = "nodejs";

/**
 * Company & Accounting settings. GET preserves the user-administration view of
 * organization identity, locale, and the two independent accounting policies.
 * PUT persists the complete setup policy: identity, base currency, fiscal
 * calendar, reporting/tax policy, and control accounts.
 *
 * Reads retain the existing user-administration gate because the response is
 * still the company-administration view rather than a posting endpoint.
 * Every write is a setup operation and is separately gated by
 * admin.setup.manage: even an
 * identity-only payload shares one authoritative settings mutation boundary
 * with ledger policy and must never inherit user-administration authority.
 *
 * A fresh organization may change its fiscal-year start month. Once its active
 * default calendar has posted/reversed journals or a non-open period lock, the
 * fiscal foundation is immutable and the transaction refuses the entire PUT.
 */

const SETTINGS_READ_PERMISSION = "admin.users.manage";
const SETTINGS_WRITE_PERMISSION = "admin.setup.manage";

function fiscalCalendarLockedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "fiscal-calendar-locked",
      message:
        "Cannot change the fiscal calendar after postings or period closure.",
    },
    { status: 409 },
  );
}

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
      reportingFramework:
        settings.reportingFramework === "ifrs" ||
        settings.reportingFramework === "us_gaap"
          ? settings.reportingFramework
          : null,
      taxFramework:
        settings.taxFramework === "ias12" ? "ias12" : "asc740",
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
    reportingFramework?: unknown;
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
    if (body.reportingFramework !== undefined) {
      if (
        body.reportingFramework !== "us_gaap" &&
        body.reportingFramework !== "ifrs"
      ) {
        return NextResponse.json(
          { error: "reportingFramework must be us_gaap or ifrs" },
          { status: 400 },
        );
      }
      const curReportingFramework =
        settings.reportingFramework === "ifrs" ||
        settings.reportingFramework === "us_gaap"
          ? settings.reportingFramework
          : null;
      if (body.reportingFramework !== curReportingFramework) {
        // Lease classifications and NRV write-downs snapshot the policy that
        // produced their accounting evidence. Once either evidence stream
        // exists, changing the org policy without a prospective migration
        // would make a later read appear to reinterpret committed history.
        if (curReportingFramework !== null) {
          const evidence = await tx.execute<{
            leaseEvidence: boolean;
            inventoryEvidence: boolean;
          }>(sql`
            select exists (
                     select 1 from lease_agreements where org_id = ${orgId}
                   ) as "leaseEvidence",
                   exists (
                     select 1 from inventory_writedowns where org_id = ${orgId}
                   ) as "inventoryEvidence"`);
          if (evidence.rows[0]?.leaseEvidence || evidence.rows[0]?.inventoryEvidence) {
            return NextResponse.json(
              {
                error: "reporting-framework-locked",
                message:
                  "Cannot change the reporting framework after lease or inventory NRV evidence exists.",
              },
              { status: 409 },
            );
          }
        }
        nextSettings.reportingFramework = body.reportingFramework;
        changes.reportingFramework = [
          curReportingFramework,
          body.reportingFramework,
        ];
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

    if (startMonthChanged) {
      // Lock the target calendar and its periods before inspecting activity.
      // New journals/locks must acquire a foreign-key key-share lock on one of
      // these rows, so they cannot race the eligibility decision. Existing
      // lock and journal rows are locked below so close/post status changes are
      // equally fenced until this transaction commits.
      const calendar = await tx.execute<{ id: string }>(sql`
        select id
          from fiscal_calendars
         where org_id = ${orgId} and is_default and is_active
         for update`);
      const calendarId = calendar.rows[0]?.id;
      if (!calendarId) {
        return NextResponse.json(
          {
            error: "fiscal-calendar-not-found",
            message: "An active default fiscal calendar is required.",
          },
          { status: 409 },
        );
      }

      await tx.execute(sql`
        select id
          from accounting_periods
         where org_id = ${orgId} and fiscal_calendar_id = ${calendarId}
         for update`);

      // Established calendars can contain millions of journals. Refuse them
      // with index-backed existence probes before taking row locks; only a
      // candidate fresh calendar reaches the concurrency fence below.
      const activity = await tx.execute<{
        posted: boolean;
        closed: boolean;
      }>(sql`
        select exists (
                 select 1
                   from journal_entries entry
                   join accounting_periods period
                     on period.org_id = entry.org_id
                    and period.id = entry.period_id
                  where period.org_id = ${orgId}
                    and period.fiscal_calendar_id = ${calendarId}
                    and entry.status in ('posted', 'reversed')
                  limit 1
               ) as posted,
               exists (
                 select 1
                   from period_locks period_lock
                   join accounting_periods period
                     on period.org_id = period_lock.org_id
                    and period.id = period_lock.period_id
                  where period.org_id = ${orgId}
                    and period.fiscal_calendar_id = ${calendarId}
                    and (
                      period_lock.state <> 'open'
                      or period_lock.reopen_expires_at <= now()
                    )
                  limit 1
               ) as closed`);
      if (activity.rows[0]?.posted || activity.rows[0]?.closed) {
        return fiscalCalendarLockedResponse();
      }

      const periodLocks = await tx.execute<{
        state: string;
        reopenExpired: boolean;
      }>(sql`
        select period_lock.state,
               period_lock.reopen_expires_at <= now() as "reopenExpired"
          from period_locks period_lock
          join accounting_periods period
            on period.org_id = period_lock.org_id
           and period.id = period_lock.period_id
         where period.org_id = ${orgId}
           and period.fiscal_calendar_id = ${calendarId}
         for update of period_lock`);
      const calendarClosed = periodLocks.rows.some(
        (periodLock) => periodLock.state !== "open" || periodLock.reopenExpired,
      );

      const journals = await tx.execute<{ status: string }>(sql`
        select entry.status
          from journal_entries entry
          join accounting_periods period
            on period.org_id = entry.org_id
           and period.id = entry.period_id
         where period.org_id = ${orgId}
           and period.fiscal_calendar_id = ${calendarId}
         for update of entry`);
      const calendarPosted = journals.rows.some(
        (entry) => entry.status === "posted" || entry.status === "reversed",
      );

      if (calendarPosted || calendarClosed) {
        return fiscalCalendarLockedResponse();
      }
    }

    await tx.execute(sql`
    update orgs
       set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${actor.id}
     where id = ${orgId}`);

    if (startMonthChanged) {
      // Move existing labels outside the canonical range first so a calendar
      // rotation cannot collide with another period's old unique key.
      await tx.execute(periodDerivationStagingSql(orgId));
      await tx.execute(periodDerivationSql(orgId, effectiveStart));
      await tx.execute(sql`
      update fiscal_calendars
         set year_start_month = ${effectiveStart}, updated_at = now(), updated_by = ${actor.id}
       where org_id = ${orgId} and is_default`);
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
