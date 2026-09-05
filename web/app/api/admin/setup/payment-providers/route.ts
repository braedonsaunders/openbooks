import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/src/db.ts";
import {
  PaymentAcceptanceError,
  configSecrets,
  normalizeAcceptanceProviderSettings,
  saveAcceptanceConfig,
  testAcceptanceConnection,
} from "@openbooks/engine/src/payment-acceptance.ts";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/src/business-date.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { canonicalDecimal, compareDecimal } from "../../../../../lib/exact-decimal";

export const runtime = "nodejs";


/** Audit-evidence shape for payment_surcharge_rules: the stored row itself. */
type SurchargeRuleSnapshot = {
  name: string;
  calculation: string;
  percent: string | null;
  fixedAmount: string | null;
  capAmount: string | null;
  feeIncomeAccountId: string;
  provider: string | null;
  paymentMethod: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

const SURCHARGE_RULE_SNAPSHOT_COLUMNS = sql`
  name, calculation, percent::text as percent, fixed_amount::text as "fixedAmount",
  cap_amount::text as "capAmount", fee_income_account_id as "feeIncomeAccountId",
  provider, payment_method as "paymentMethod", effective_from::text as "effectiveFrom",
  effective_to::text as "effectiveTo", is_active as "isActive"`;

/** The rule row targeted by a save/delete does not exist in this org. */
class SurchargeRuleMissing extends Error {}

/**
 * Another active rule covering the same provider tier, payment methods, and
 * start date already exists. Resolution would silently shadow one behind the
 * other for every checkout either serves, so setup refuses the pair instead
 * of letting effective dating hide a live fee policy.
 */
class SurchargeRuleDatingConflict extends Error {
  constructor(readonly effectiveFrom: string) {
    super(`another active surcharge rule already takes effect on ${effectiveFrom}`);
  }
}

/** Drizzle/node-postgres may expose the server error directly or as `cause`. */
function postgresErrorCode(error: unknown): string | undefined {
  let current = error;
  while (current && typeof current === "object") {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

/** Provider acceptance configuration. Secrets are write-only — responses only
 *  ever report their presence. */
export async function GET() {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;
  const [configs, banks, rules, incomeAccounts] = await Promise.all([
    db.execute(sql`
      select provider, display_name as "displayName", is_enabled as "isEnabled",
             acceptance_enabled as "acceptanceEnabled", default_bank_account_id as "defaultBankAccountId",
             publishable_key as "publishableKey", surcharge_rule_id as "surchargeRuleId", settings,
             (secrets is not null) as "hasSecrets", last_error as "lastError"
        from psp_provider_configs
       where org_id = ${orgId} and provider in ('stripe', 'adyen', 'gocardless')
       order by provider
    `),
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and type = 'asset_bank' and is_active and not is_summary
       order by number nulls last, name
    `),
    db.execute(sql`
      select id, name, calculation, percent, fixed_amount as "fixedAmount", cap_amount as "capAmount",
             fee_income_account_id as "feeIncomeAccountId", provider, payment_method as "paymentMethod",
             effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo", is_active as "isActive"
        from payment_surcharge_rules where org_id = ${orgId}
       order by effective_from desc
    `),
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and type in ('income', 'income_other') and is_active and not is_summary
       order by number nulls last, name
    `),
  ]);
  return NextResponse.json({
    configs: configs.rows,
    bankAccounts: banks.rows,
    surchargeRules: rules.rows,
    incomeAccounts: incomeAccounts.rows,
    featureEnabled: await isFeatureEnabled(orgId, "onlinePayments"),
  });
}

export async function POST(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "onlinePayments"))) {
    return NextResponse.json({ error: "feature disabled" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>;
  const orgId = gate.user.orgId;

  if (body.action === "saveRule") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const calculation = body.calculation;
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    if (calculation !== "percent" && calculation !== "fixed" && calculation !== "percent_plus_fixed") {
      return NextResponse.json({ error: "invalid calculation" }, { status: 400 });
    }
    if (typeof body.feeIncomeAccountId !== "string" || !isUuid(body.feeIncomeAccountId)) {
      return NextResponse.json({ error: "fee income account is required" }, { status: 400 });
    }
    const id = typeof body.id === "string" ? body.id : null;
    if (id !== null && !isUuid(id)) {
      return NextResponse.json({ error: "invalid rule id" }, { status: 400 });
    }
    const provider = body.provider === "stripe" || body.provider === "adyen" || body.provider === "gocardless" ? body.provider : null;
    const paymentMethod = body.paymentMethod === "card" || body.paymentMethod === "bank_debit" ? body.paymentMethod : "all";

    // Effective dating accepts only real calendar days: a malformed string
    // would otherwise surface as a Postgres cast failure and an inverted
    // range as a constraint violation — both raw 500s.
    const effectiveFrom = typeof body.effectiveFrom === "string" && body.effectiveFrom ? body.effectiveFrom : await businessToday(orgId);
    const effectiveTo = typeof body.effectiveTo === "string" && body.effectiveTo ? body.effectiveTo : null;
    if (!isIsoCalendarDate(effectiveFrom)) {
      return NextResponse.json({ error: "effectiveFrom must be a calendar date (YYYY-MM-DD)" }, { status: 422 });
    }
    if (effectiveTo !== null && (!isIsoCalendarDate(effectiveTo) || effectiveTo < effectiveFrom)) {
      return NextResponse.json(
        { error: "effectiveTo must be a calendar date on or after effectiveFrom" },
        { status: 422 },
      );
    }

    // Every supplied amount must be strictly positive: a stored zero is either
    // a silent never-charging policy or ignored config noise, since
    // computeSurcharge treats absent components as zero.
    const moneyOrNull = (raw: unknown) => {
      if (raw == null || raw === "") return null;
      const exact = canonicalDecimal(raw, 4);
      if (exact === null) return "invalid";
      if (compareDecimal(exact, "0") <= 0 || exact.replace("-", "").split(".")[0]!.length > 12) return "invalid";
      return normalizeMoney(exact);
    };
    const percent = moneyOrNull(body.percent);
    const fixedAmount = moneyOrNull(body.fixedAmount);
    const capAmount = moneyOrNull(body.capAmount);
    if (percent === "invalid" || fixedAmount === "invalid" || capAmount === "invalid") {
      return NextResponse.json(
        { error: "surcharge amounts must be positive decimals with at most 4 fraction digits" },
        { status: 422 },
      );
    }

    // The calculation owns exactly its components: a component it ignores must
    // not be stored (misleading setup), and the rule must actually charge — a
    // policy whose fee is identically zero would silently pass as a surcharge.
    if ((calculation === "fixed" && percent !== null) || (calculation === "percent" && fixedAmount !== null)) {
      return NextResponse.json(
        { error: `${calculation} surcharges do not take a ${calculation === "fixed" ? "percent" : "fixed amount"}` },
        { status: 422 },
      );
    }
    if (
      (calculation === "percent" && percent === null) ||
      (calculation === "fixed" && fixedAmount === null) ||
      (calculation === "percent_plus_fixed" && percent === null && fixedAmount === null)
    ) {
      return NextResponse.json(
        { error: "surcharge rule must charge a nonzero fee for its calculation type" },
        { status: 422 },
      );
    }

    // A referenced fee account must be a real posting income account here.
    const feeAccount = await db.execute<{ id: string }>(sql`
      select id from accounts
       where org_id = ${orgId} and id = ${body.feeIncomeAccountId}
         and type in ('income', 'income_other') and is_active and not is_summary
       limit 1
    `);
    if (!feeAccount.rows[0]) {
      return NextResponse.json({ error: "fee income account not found" }, { status: 422 });
    }

    const values = {
      name,
      calculation,
      percent,
      fixedAmount,
      capAmount,
      feeIncomeAccountId: body.feeIncomeAccountId,
      provider,
      paymentMethod,
      effectiveFrom,
      effectiveTo,
    };

    // Rule write + audit evidence commit together or not at all; both audit
    // sides are captured rows, never the request payload restated.
    try {
      await withOrgTransaction(orgId, async () => {
        const beforeRow = id
          ? (
              await db.execute<SurchargeRuleSnapshot>(sql`
                select ${SURCHARGE_RULE_SNAPSHOT_COLUMNS}
                  from payment_surcharge_rules
                 where org_id = ${orgId} and id = ${id}
              `)
            ).rows[0] ?? null
          : null;
        if (id && !beforeRow) throw new SurchargeRuleMissing();

        // Same provider tier + overlapping effective window + overlapping
        // method coverage = shadowing. This preflight gives an admin a useful
        // message; migration 0023's exclusion constraint is the authoritative
        // concurrency guard when two transactions both pass this read.
        // Disjoint methods (card-only vs bank-debit-only) never compete.
        const clash = await db.execute<{ id: string }>(sql`
          select id from payment_surcharge_rules
           where org_id = ${orgId} and is_active
             and provider is not distinct from ${values.provider}
             and id is distinct from ${id}
             and daterange(effective_from, effective_to, '[]')
                 && daterange(${values.effectiveFrom}::date, ${values.effectiveTo}::date, '[]')
             and not ((payment_method = 'card' and ${values.paymentMethod} = 'bank_debit')
                   or (payment_method = 'bank_debit' and ${values.paymentMethod} = 'card'))
           limit 1
        `);
        if (clash.rows[0]) throw new SurchargeRuleDatingConflict(values.effectiveFrom);

        if (id) {
          const updated = await db.execute<SurchargeRuleSnapshot>(sql`
            update payment_surcharge_rules set
              name = ${values.name}, calculation = ${values.calculation}, percent = ${values.percent},
              fixed_amount = ${values.fixedAmount}, cap_amount = ${values.capAmount},
              fee_income_account_id = ${values.feeIncomeAccountId}, provider = ${values.provider},
              payment_method = ${values.paymentMethod}, effective_from = ${values.effectiveFrom},
              effective_to = ${values.effectiveTo}, updated_at = now(), updated_by = ${gate.user.id}
            where org_id = ${orgId} and id = ${id}
            returning ${SURCHARGE_RULE_SNAPSHOT_COLUMNS}
          `);
          const afterRow = updated.rows[0];
          if (!afterRow) throw new SurchargeRuleMissing();
          await db.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'payment_surcharge_rules', ${id}, 'update',
                    ${JSON.stringify({ rule: [beforeRow, afterRow] })}::jsonb, ${gate.user.id})
          `);
        } else {
          const inserted = await db.execute<SurchargeRuleSnapshot & { id: string }>(sql`
            insert into payment_surcharge_rules
              (org_id, name, calculation, percent, fixed_amount, cap_amount, fee_income_account_id,
               provider, payment_method, effective_from, effective_to, created_by, updated_by)
            values (${orgId}, ${values.name}, ${values.calculation}, ${values.percent}, ${values.fixedAmount},
                    ${values.capAmount}, ${values.feeIncomeAccountId}, ${values.provider}, ${values.paymentMethod},
                    ${values.effectiveFrom}, ${values.effectiveTo}, ${gate.user.id}, ${gate.user.id})
            returning id, ${SURCHARGE_RULE_SNAPSHOT_COLUMNS}
          `);
          const afterRow = inserted.rows[0]!;
          await db.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'payment_surcharge_rules', ${afterRow.id}, 'insert',
                    ${JSON.stringify({ rule: [null, afterRow] })}::jsonb, ${gate.user.id})
          `);
        }
      });
    } catch (e) {
      if (e instanceof SurchargeRuleMissing) {
        return NextResponse.json({ error: "surcharge rule not found" }, { status: 404 });
      }
      if (e instanceof SurchargeRuleDatingConflict) {
        return NextResponse.json({ error: e.message }, { status: 409 });
      }
      // The preflight above is intentionally unlocked. The storage constraint
      // decides a concurrent race; expose the exact same API contract rather
      // than leaking a constraint name or converting the loser into a 500.
      const code = postgresErrorCode(e);
      if (code === "23P01" || code === "23505") {
        return NextResponse.json(
          { error: new SurchargeRuleDatingConflict(values.effectiveFrom).message },
          { status: 409 },
        );
      }
      throw e;
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "deleteRule") {
    if (typeof body.id !== "string" || !isUuid(body.id)) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    try {
      await withOrgTransaction(orgId, async () => {
        const before = await db.execute<SurchargeRuleSnapshot>(sql`
          select ${SURCHARGE_RULE_SNAPSHOT_COLUMNS}
            from payment_surcharge_rules
           where org_id = ${orgId} and id = ${body.id}
        `);
        const beforeRow = before.rows[0];
        if (!beforeRow || !beforeRow.isActive) throw new SurchargeRuleMissing();
        // Deactivation is a real state change: re-deleting an inactive rule
        // must fail loudly rather than fabricate another audit entry.
        const deactivated = await db.execute<{ id: string }>(sql`
          update payment_surcharge_rules set is_active = false, updated_at = now(), updated_by = ${gate.user.id}
           where org_id = ${orgId} and id = ${body.id} and is_active
          returning id
        `);
        if (!deactivated.rows[0]) throw new SurchargeRuleMissing();
        await db.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'payment_surcharge_rules', ${body.id}, 'delete',
                  ${JSON.stringify({ rule: [beforeRow, { ...beforeRow, isActive: false }] })}::jsonb, ${gate.user.id})
        `);
      });
    } catch (e) {
      if (e instanceof SurchargeRuleMissing) {
        return NextResponse.json({ error: "surcharge rule not found" }, { status: 404 });
      }
      throw e;
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "test") {
    const provider = body.provider;
    if (provider !== "stripe" && provider !== "adyen" && provider !== "gocardless") {
      return NextResponse.json({ error: "unknown provider" }, { status: 400 });
    }
    const config = (await db.execute<Parameters<typeof configSecrets>[0]>(sql`
      select id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id,
             publishable_key, settings, surcharge_rule_id, secrets
        from psp_provider_configs
       where org_id = ${orgId} and provider = ${provider} limit 1
    `));
    if (!config.rows[0]) return NextResponse.json({ ok: false, detail: "provider is not configured" });
    let result: { ok: boolean; detail: string };
    try {
      result = await testAcceptanceConnection(provider, configSecrets(config.rows[0]));
    } catch (e) {
      result = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    await db.execute(sql`
      update psp_provider_configs set last_error = ${result.ok ? null : result.detail}, updated_at = now()
       where org_id = ${orgId} and provider = ${provider}
    `);
    return NextResponse.json(result);
  }

  const provider = body.provider;
  if (provider !== "stripe" && provider !== "adyen" && provider !== "gocardless") {
    return NextResponse.json({ error: "provider must be stripe, adyen or gocardless" }, { status: 400 });
  }
  for (const [field, value] of [
    ["defaultBankAccountId", body.defaultBankAccountId],
    ["surchargeRuleId", body.surchargeRuleId],
  ] as const) {
    if (value !== undefined && value !== null && (typeof value !== "string" || !isUuid(value))) {
      return NextResponse.json({ error: `${field} must be a valid UUID` }, { status: 400 });
    }
  }
  try {
    if (body.settings != null && (typeof body.settings !== "object" || Array.isArray(body.settings))) {
      throw new PaymentAcceptanceError("provider settings must be an object");
    }
    const settings = normalizeAcceptanceProviderSettings(
      provider,
      body.settings == null ? undefined : (body.settings as Record<string, unknown>),
    );
    await saveAcceptanceConfig(gate.user.orgId, gate.user.id, {
      provider,
      displayName: typeof body.displayName === "string" ? body.displayName : undefined,
      isEnabled: body.isEnabled !== false,
      acceptanceEnabled: body.acceptanceEnabled === true,
      defaultBankAccountId: typeof body.defaultBankAccountId === "string" ? body.defaultBankAccountId : null,
      publishableKey: typeof body.publishableKey === "string" ? body.publishableKey : null,
      surchargeRuleId: typeof body.surchargeRuleId === "string" ? body.surchargeRuleId : null,
      settings,
      apiKey: typeof body.apiKey === "string" && body.apiKey ? body.apiKey : null,
      webhookSecret: typeof body.webhookSecret === "string" && body.webhookSecret ? body.webhookSecret : null,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const status = e instanceof PaymentAcceptanceError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
