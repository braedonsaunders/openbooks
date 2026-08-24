import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  PaymentAcceptanceError,
  configSecrets,
  normalizeAcceptanceProviderSettings,
  saveAcceptanceConfig,
  testAcceptanceConnection,
} from "@openbooks/engine/src/payment-acceptance.ts";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isFeatureEnabled } from "../../../../../lib/features";
import { canonicalDecimal, compareDecimal } from "../../../../../lib/exact-decimal";

export const runtime = "nodejs";

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
    if (typeof body.feeIncomeAccountId !== "string") {
      return NextResponse.json({ error: "fee income account is required" }, { status: 400 });
    }
    const provider = body.provider === "stripe" || body.provider === "adyen" || body.provider === "gocardless" ? body.provider : null;
    const paymentMethod = body.paymentMethod === "card" || body.paymentMethod === "bank_debit" ? body.paymentMethod : "all";
    const effectiveFrom = typeof body.effectiveFrom === "string" && body.effectiveFrom ? body.effectiveFrom : await businessToday(orgId);
    const effectiveTo = typeof body.effectiveTo === "string" && body.effectiveTo ? body.effectiveTo : null;
    const id = typeof body.id === "string" ? body.id : null;
    const moneyOrNull = (raw: unknown) => {
      if (raw == null || raw === "") return null;
      const exact = canonicalDecimal(raw, 4);
      if (exact === null || compareDecimal(exact, "0") < 0) return "invalid";
      return normalizeMoney(exact);
    };
    const percent = moneyOrNull(body.percent);
    const fixedAmount = moneyOrNull(body.fixedAmount);
    const capAmount = moneyOrNull(body.capAmount);
    if (percent === "invalid" || fixedAmount === "invalid" || capAmount === "invalid") {
      return NextResponse.json({ error: "surcharge amounts must be non-negative decimals" }, { status: 400 });
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
    if (id) {
      await db.execute(sql`
        update payment_surcharge_rules set
          name = ${values.name}, calculation = ${values.calculation}, percent = ${values.percent},
          fixed_amount = ${values.fixedAmount}, cap_amount = ${values.capAmount},
          fee_income_account_id = ${values.feeIncomeAccountId}, provider = ${values.provider},
          payment_method = ${values.paymentMethod}, effective_from = ${values.effectiveFrom},
          effective_to = ${values.effectiveTo}, updated_at = now(), updated_by = ${gate.user.id}
        where org_id = ${orgId} and id = ${id}
      `);
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'payment_surcharge_rules', ${id}, 'update', ${JSON.stringify({ after: values })}::jsonb, ${gate.user.id})
      `);
    } else {
      const ins = (await db.execute<{ id: string }>(sql`
        insert into payment_surcharge_rules
          (org_id, name, calculation, percent, fixed_amount, cap_amount, fee_income_account_id,
           provider, payment_method, effective_from, effective_to, created_by, updated_by)
        values (${orgId}, ${values.name}, ${values.calculation}, ${values.percent}, ${values.fixedAmount},
                ${values.capAmount}, ${values.feeIncomeAccountId}, ${values.provider}, ${values.paymentMethod},
                ${values.effectiveFrom}, ${values.effectiveTo}, ${gate.user.id}, ${gate.user.id})
        returning id
      `));
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'payment_surcharge_rules', ${ins.rows[0]!.id}, 'insert', ${JSON.stringify({ after: values })}::jsonb, ${gate.user.id})
      `);
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "deleteRule") {
    if (typeof body.id !== "string") return NextResponse.json({ error: "id is required" }, { status: 400 });
    await db.execute(sql`
      update payment_surcharge_rules set is_active = false, updated_at = now(), updated_by = ${gate.user.id}
       where org_id = ${orgId} and id = ${body.id}
    `);
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'payment_surcharge_rules', ${body.id}, 'delete', ${JSON.stringify({ before: { isActive: true }, after: { isActive: false } })}::jsonb, ${gate.user.id})
    `);
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
