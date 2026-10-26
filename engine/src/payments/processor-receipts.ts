import { sql } from "drizzle-orm";
import { db, withOrgTransaction, withTransactionSavepoint } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { businessToday } from "../platform/business-date.ts";
import { isIso4217CurrencyCode } from "../fx/currencies.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import {
  assertUnrestrictedScope,
  ScopeNotFoundError,
  subsidiaryScopeAllows,
  subsidiaryVisibleFilter,
} from "../organization/subsidiary-scope.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import {
  PROCESSOR_RECEIPT_POLICY_KEY,
  processorReceiptPolicies,
  receiptPolicyWindowsOverlap,
  resolveReceiptFunding,
  type ProcessorReceiptPolicy,
} from "../payments-core/receipt-funding.ts";
import { PSP_PROVIDERS, isPspProvider } from "./psp-settlement.ts";

export { type ProcessorReceiptPolicy } from "../payments-core/receipt-funding.ts";

export async function receiptFundingSubsidiaryOptions(
  orgId: string,
  actorId: string,
  kind: "customer_payment" | "vendor_payment",
  requested: ReadonlySet<string> | null,
) {
  return withOrgTransaction(orgId, async () => {
    const live = await lockActorCommandAuthority(
      db,
      orgId,
      actorId,
      null,
      kind === "customer_payment" ? "ar.pay" : "ap.pay",
    );
    return (
      await db.execute<{ id: string; name: string; currency: string }>(
        sql`
      select id, name, base_currency as currency from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by name`,
        "objects",
      )
    ).filter(
      (row) => subsidiaryScopeAllows(live, row.id) && subsidiaryScopeAllows(requested, row.id),
    );
  });
}

export async function loadProcessorReceiptConfiguration(
  orgId: string,
  actorId: string,
  requested: ReadonlySet<string> | null,
) {
  return withOrgTransaction(orgId, async () => {
    const live = await lockActorCommandAuthority(db, orgId, actorId, null, "admin.setup.manage");
    if (!(await lockAndCheckOrgFeature(db, orgId, "banking")))
      throw new PaymentError("Processor receipt funding is disabled while Banking is off.");
    const visible = (id: string) =>
      subsidiaryScopeAllows(live, id) && subsidiaryScopeAllows(requested, id);
    const providers = await db.execute<{
      provider: string;
      display_name: string;
      is_enabled: boolean;
      default_clearing_account_id: string | null;
      settings: unknown;
    }>(
      sql`
      select provider, display_name, is_enabled, default_clearing_account_id, settings from psp_provider_configs
       where org_id = ${orgId} order by provider`,
      "objects",
    );
    const accounts = await db.execute<{ id: string; number: string | null; name: string }>(
      sql`
      select id, number, name from accounts a where org_id = ${orgId} and type = 'asset_current_other' and is_active and not is_summary
        ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, live, { orgWideNull: true })}
        ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, requested, { orgWideNull: true })} order by number nulls last, name`,
      "objects",
    );
    const accountIds = new Set(accounts.map((account) => account.id));
    const subsidiaries = (
      await db.execute<{ id: string; name: string; currency: string }>(
        sql`
      select id, name, base_currency as currency from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by name`,
        "objects",
      )
    ).filter((row) => visible(row.id));
    return {
      accounts,
      subsidiaries,
      canManage: live === null && requested === null,
      providers: PSP_PROVIDERS.map((provider) => {
        const config = providers.find((row) => row.provider === provider);
        return config
          ? {
              provider: config.provider,
              name: config.display_name,
              enabled: config.is_enabled,
              configured: true,
              clearingAccountId: accountIds.has(config.default_clearing_account_id ?? "")
                ? config.default_clearing_account_id
                : null,
              policies: processorReceiptPolicies(config.settings).filter(
                (policy) => visible(policy.subsidiaryId) && accountIds.has(policy.accountId),
              ),
            }
          : {
              provider,
              name: provider,
              enabled: false,
              configured: false,
              clearingAccountId: null,
              policies: [],
            };
      }),
    };
  });
}

/** Receipt-only options. Bank, transfer and vendor-payment pickers retain
 * their independent account contracts. No general asset picker is widened. */
export async function receiptFundingAccountOptions(input: {
  orgId: string;
  actorId: string;
  kind: "customer_payment" | "vendor_payment";
  subsidiaryId: string;
  currency: string;
  onDate: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ id: string; number: string | null; name: string; provider: string | null }[]> {
  return withOrgTransaction(input.orgId, async () => {
    const live = await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      input.subsidiaryId,
      input.kind === "customer_payment" ? "ar.pay" : "ap.pay",
    );
    if (!subsidiaryScopeAllows(input.allowedSubsidiaryIds, input.subsidiaryId))
      throw new ScopeNotFoundError();
    const rows = await db.execute<{
      id: string;
      number: string | null;
      name: string;
      type: string;
    }>(
      sql`
      select id, number, name, type from accounts a where org_id = ${input.orgId} and is_active and not is_summary
        and (type = 'asset_bank' or (type = 'asset_current_other' and exists (
          select 1 from psp_provider_configs p where p.org_id = a.org_id and p.is_enabled and p.default_clearing_account_id = a.id)))
        ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, live, { orgWideNull: true })}
        ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, input.allowedSubsidiaryIds, { orgWideNull: true })}
      order by number nulls last, name`,
      "objects",
    );
    const options = [];
    for (const row of rows) {
      try {
        const funding = await resolveReceiptFunding(db, {
          ...input,
          accountId: row.id,
          allowedSubsidiaryIds: live,
        });
        options.push({
          id: row.id,
          number: row.number,
          name: row.name,
          provider: funding?.provider ?? null,
        });
      } catch (error) {
        if (!(error instanceof PaymentError)) throw error;
      }
    }
    return options;
  });
}

/** Provider-scoped dated configuration stored on the existing PSP authority.
 * Mapping identities are immutable; only a prospective end date can change. */
export async function saveProcessorReceiptPolicy(
  orgId: string,
  provider: string,
  input: ProcessorReceiptPolicy,
  actorId: string,
  reason: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ProcessorReceiptPolicy> {
  assertUnrestrictedScope(allowedSubsidiaryIds);
  if (!isPspProvider(provider))
    throw new PaymentError("Choose a native settlement provider for processor receipts.");
  const [policy] = processorReceiptPolicies({ [PROCESSOR_RECEIPT_POLICY_KEY]: [input] });
  if (!isIso4217CurrencyCode(policy!.currency))
    throw new PaymentError("Choose an ISO currency for processor receipts.");
  const explanation = reason.trim();
  if (explanation.length < 5 || explanation.length > 500)
    throw new PaymentError(
      "A reason between 5 and 500 characters is required for receipt funding policy.",
    );
  return withOrgTransaction(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const live = await lockActorCommandAuthority(db, orgId, actorId, null, "admin.setup.manage");
      assertUnrestrictedScope(live);
      if (!(await lockAndCheckOrgFeature(db, orgId, "banking")))
        throw new PaymentError(
          "Enable Banking in Company Settings → Features before configuring processor receipts.",
        );
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`processor-receipt-policy:${orgId}`}, 0))`,
      );
      const configs = await db.execute<{
        id: string;
        provider: string;
        is_enabled: boolean;
        default_clearing_account_id: string | null;
        settings: Record<string, unknown>;
      }>(
        sql`
      select id, provider, is_enabled, default_clearing_account_id, settings from psp_provider_configs
       where org_id = ${orgId} order by provider for update`,
        "objects",
      );
      let config = configs.find((row) => row.provider === provider);
      let creatingProvider = false;
      if (!config) {
        // A concurrent native provider create is benign: reuse and revalidate
        // its locked row without overwriting any of its posting defaults.
        const created = await db.execute<{ id: string }>(
          sql`insert into psp_provider_configs (org_id, provider, display_name, is_enabled, created_by, updated_by)
        values (${orgId}, ${provider}, ${provider}, true, ${actorId}, ${actorId}) on conflict (org_id, provider) do nothing returning id`,
          "objects",
        );
        creatingProvider = created.length === 1;
        config = (
          await db.execute<(typeof configs)[number]>(
            sql`select id, provider, is_enabled, default_clearing_account_id, settings
        from psp_provider_configs where org_id = ${orgId} and provider = ${provider} for update`,
            "objects",
          )
        )[0];
        if (!config) throw new PaymentError("The processor provider could not be configured.");
      }
      if (
        !config?.is_enabled ||
        (config.default_clearing_account_id !== null &&
          config.default_clearing_account_id !== policy!.accountId)
      ) {
        throw new PaymentError(
          "Configure and enable this provider's processor clearing account before adding its receipt funding policy.",
        );
      }
      const account = (
        await db.execute<{ type: string }>(
          sql`select type from accounts where org_id = ${orgId} and id = ${policy!.accountId}
      and is_active and not is_summary and (currency_restriction is null or currency_restriction = ${policy!.currency}) for share`,
          "objects",
        )
      )[0];
      if (account?.type !== "asset_current_other")
        throw new PaymentError(
          "Processor receipts require an active nonsummary other-current-asset clearing account.",
        );
      const subsidiary = (
        await db.execute<{ id: string }>(
          sql`select id from subsidiaries where org_id = ${orgId} and id = ${policy!.subsidiaryId} and is_active and not is_elimination for share`,
          "objects",
        )
      )[0];
      if (!subsidiary) throw new ScopeNotFoundError();
      const policies = processorReceiptPolicies(config.settings);
      const prior = policies.find((row) => row.id === policy!.id);
      if (prior && canonicalJson(prior) === canonicalJson(policy)) return prior;
      if (prior) {
        const today = await businessToday(orgId);
        if (
          canonicalJson({ ...prior, effectiveTo: null }) !==
            canonicalJson({ ...policy, effectiveTo: null }) ||
          (prior.effectiveTo !== null && prior.effectiveTo < today) ||
          policy!.effectiveTo === null ||
          policy!.effectiveTo < today
        ) {
          throw new PaymentError(
            "A receipt funding mapping is immutable. Close it prospectively and create a new dated policy.",
          );
        }
      }
      for (const other of configs)
        for (const candidate of processorReceiptPolicies(other.settings)) {
          if (other.provider === provider && candidate.id === policy!.id) continue;
          if (
            receiptPolicyWindowsOverlap(candidate, policy!) &&
            (other.provider === provider || candidate.accountId === policy!.accountId)
          ) {
            throw new PaymentError(
              "Receipt funding policies overlap for this provider or clearing pool, legal entity and currency.",
            );
          }
        }
      const next = [...policies.filter((row) => row.id !== policy!.id), policy!];
      const written =
        await db.execute<never>(sql`update psp_provider_configs set default_clearing_account_id = coalesce(default_clearing_account_id, ${policy!.accountId}), settings = jsonb_set(coalesce(settings, '{}'::jsonb),
      ${`{${PROCESSOR_RECEIPT_POLICY_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb), updated_at = now(), updated_by = ${actorId}
      where org_id = ${orgId} and id = ${config.id}`);
      if (written.rowCount !== 1)
        throw new PaymentError("Receipt funding policy could not be saved.");
      // The same resolver certifies account/entity restrictions for setup and use.
      await resolveReceiptFunding(db, {
        orgId,
        accountId: policy!.accountId,
        kind: "customer_payment",
        subsidiaryId: policy!.subsidiaryId,
        currency: policy!.currency,
        onDate: policy!.effectiveFrom,
        allowedSubsidiaryIds: null,
        lock: true,
      });
      await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${orgId}, 'psp_provider_configs', ${config.id}, 'update',
        ${JSON.stringify({
          mode: "processor_receipt_policy",
          reason: explanation,
          before: creatingProvider
            ? null
            : {
                policy: prior ?? null,
                clearingAccountId: config.default_clearing_account_id,
                isEnabled: config.is_enabled,
              },
          after: { policy, clearingAccountId: policy!.accountId, isEnabled: true },
        })}::jsonb, ${actorId}, ${policy!.id})`);
      return policy!;
    }),
  );
}
