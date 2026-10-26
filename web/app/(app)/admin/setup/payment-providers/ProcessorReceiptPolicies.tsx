"use client";

import { useIdentityState } from "@/lib/use-identity-state";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AsyncUrlDrawer } from "@/components/async-url-drawer";
import { isUuid } from "@/lib/list-params";
import { Button, Input, Label, Select } from "@openbooks/ui";
import { fetchAction } from "@braedonsaunders/appkit-errors";
import { useAppAction } from "@/lib/use-app-action";
import { useBusinessToday } from "@/components/business-date-provider";
import { PagedTable } from "@/components/paged-table";
import type { ProcessorReceiptPolicy } from "@openbooks/engine/payments/documents";
import { confirmDialog } from "@/lib/confirm";
import { DateField } from "@/components/date-field";

type Configuration = {
  canManage: boolean;
  accounts: { id: string; number: string | null; name: string }[];
  subsidiaries: { id: string; name: string; currency: string }[];
  providers: {
    provider: string;
    name: string;
    enabled: boolean;
    configured: boolean;
    clearingAccountId: string | null;
    policies: ProcessorReceiptPolicy[];
  }[];
};

export function ProcessorReceiptPolicies() {
  const t = useTranslations("processorReceipts");
  const tc = useTranslations("common");
  const today = useBusinessToday();
  const { busy, execute } = useAppAction();
  const [data, setData] = useState<Configuration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const provider = params.get("receiptProvider") ?? "";
  const policyId = params.get("receiptPolicy");
  const creating = params.get("receiptNew") === "1";
  const href = (fields: Record<string, string | undefined>) => {
    const query = new URLSearchParams(params.toString());
    query.set("view", "processor_receipts");
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) query.delete(key);
      else query.set(key, value);
    }
    return `${pathname}?${query}`;
  };
  const closeHref = href({ receiptPolicy: undefined, receiptNew: undefined });
  const [editing, setEditing] = useState<{
    policy: ProcessorReceiptPolicy;
    original: ProcessorReceiptPolicy;
    existing: boolean;
    provider: string;
  } | null>(null);
  const load = useCallback(() => {
    return fetchAction<Configuration>("/api/admin/setup/payment-providers/receipt-funding").then(
      (result) => {
        if (result.ok) {
          setData(result.data);
          setError(null);
        } else setError(result.error.serverMessage ?? t("loadFailed"));
      },
    );
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);
  const selected = provider
    ? data?.providers.find((row) => row.provider === provider)
    : data?.providers[0];
  const [saveError, setSaveError] = useIdentityState<string | null>([policyId, provider], null);
  const [reason, setReason] = useIdentityState([policyId, provider], "");
  const patch = (fields: Partial<ProcessorReceiptPolicy>) =>
    setEditing((current) =>
      current ? { ...current, policy: { ...current.policy, ...fields } } : null,
    );
  const [resolvedIdentity, setResolvedIdentity] = useState("");
  const editorIdentity = JSON.stringify([policyId, selected?.provider, creating, !!data]);
  if (resolvedIdentity !== editorIdentity) {
    setResolvedIdentity(editorIdentity);
    const existing = selected?.policies.find((policy) => policy.id === policyId);
    const sub = data?.subsidiaries[0];
    if (existing && selected)
      setEditing({
        policy: existing,
        original: existing,
        existing: true,
        provider: selected.provider,
      });
    else if (policyId && isUuid(policyId) && creating && selected && sub) {
      const policy = {
        id: policyId,
        accountId: selected.clearingAccountId ?? "",
        subsidiaryId: sub.id,
        currency: sub.currency,
        effectiveFrom: today,
        effectiveTo: null,
      };
      setEditing({ policy, original: policy, existing: false, provider: selected.provider });
    } else setEditing(null);
  }
  const confirmClose = async () => {
    if (busy) return false;
    if (
      !editing ||
      (!reason.trim() && JSON.stringify(editing.policy) === JSON.stringify(editing.original))
    )
      return true;
    return confirmDialog({ message: tc("feedback.unsavedChanges") });
  };
  const resolvablePolicy = !!(
    policyId &&
    isUuid(policyId) &&
    selected &&
    (selected.policies.some((policy) => policy.id === policyId) ||
      (creating && data?.subsidiaries.length))
  );
  return (
    <div className="space-y-4">
      {data ? (
        <>
          <div className="flex items-end justify-between gap-3">
            <div>
              <Label>{t("provider")}</Label>
              <Select
                value={selected?.provider ?? ""}
                onChange={(event) =>
                  router.replace(
                    href({
                      receiptProvider: event.target.value,
                      receiptPolicy: undefined,
                      receiptNew: undefined,
                    }),
                  )
                }
              >
                {data.providers.map((row) => (
                  <option key={row.provider} value={row.provider}>
                    {row.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              disabled={
                !data.canManage ||
                !selected ||
                (selected.configured && !selected.enabled) ||
                !data.subsidiaries.length
              }
              onClick={() => {
                setReason("");
                router.push(
                  href({
                    receiptProvider: selected!.provider,
                    receiptPolicy: crypto.randomUUID(),
                    receiptNew: "1",
                  }),
                );
              }}
            >
              {t("newPolicy")}
            </Button>
          </div>
          {!data.canManage ? (
            <p role="note" className="text-sm">
              {t("readOnly")}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <PagedTable
            rows={selected?.policies ?? []}
            rowKey={(row) => row.id}
            pageSize={15}
            emptyAsRow
            empty={<p>{t("empty")}</p>}
            onRowClick={(policy) => {
              setReason("");
              router.push(
                href({
                  receiptProvider: selected!.provider,
                  receiptPolicy: policy.id,
                  receiptNew: undefined,
                }),
              );
            }}
            columns={[
              {
                key: "account",
                header: t("clearingAccount"),
                cell: (row) => {
                  const a = data.accounts.find((account) => account.id === row.accountId);
                  return a ? `${a.number ?? ""} ${a.name}` : "—";
                },
              },
              {
                key: "entity",
                header: t("legalEntity"),
                cell: (row) =>
                  data.subsidiaries.find((sub) => sub.id === row.subsidiaryId)?.name ?? "—",
              },
              { key: "currency", header: t("currency"), cell: (row) => row.currency },
              { key: "from", header: t("effectiveFrom"), cell: (row) => row.effectiveFrom },
              {
                key: "to",
                header: t("effectiveTo"),
                cell: (row) => row.effectiveTo ?? t("openEnded"),
              },
            ]}
          />
        </>
      ) : (
        <div role="status">
          {error ?? "…"}
          {error ? <Button onClick={() => void load()}>{tc("actions.retry")}</Button> : null}
        </div>
      )}
      <AsyncUrlDrawer
        open={policyId !== null}
        openKey={policyId ?? ""}
        closeHref={closeHref}
        title={t("title")}
        pending={!data || (resolvablePolicy && !editing)}
        error={error ?? (data && policyId && !resolvablePolicy ? t("loadFailed") : null)}
        onRetry={() => void load()}
        beforeClose={confirmClose}
        description={data?.providers.find((row) => row.provider === editing?.provider)?.name}
        footer={
          <Button
            disabled={busy || !data?.canManage || !editing || reason.trim().length < 5}
            onClick={async () => {
              if (!editing) return;
              setSaveError(null);
              await execute(
                () =>
                  fetchAction("/api/admin/setup/payment-providers/receipt-funding", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      provider: editing.provider,
                      policy: editing.policy,
                      reason,
                    }),
                  }),
                {
                  fallbackMessage: t("saveFailed"),
                  onRefused: (failure) => setSaveError(failure.serverMessage ?? t("saveFailed")),
                  onOk: async () => {
                    router.replace(closeHref);
                    setEditing(null);
                    await load();
                  },
                },
              );
            }}
          >
            {tc("actions.save")}
          </Button>
        }
      >
        {editing && data ? (
          <div className="space-y-4">
            {saveError ? (
              <p role="alert" className="text-sm text-red-600">
                {saveError}
              </p>
            ) : null}
            <div>
              <Label>{t("clearingAccount")}</Label>
              <Select
                disabled={editing.existing || !data.canManage}
                value={editing.policy.accountId}
                onChange={(event) => patch({ accountId: event.target.value })}
              >
                <option value="">{t("choose")}</option>
                {data.accounts
                  .filter((account) => {
                    const pool = data.providers.find(
                      (row) => row.provider === editing.provider,
                    )?.clearingAccountId;
                    return !pool || account.id === pool;
                  })
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.number} {account.name}
                    </option>
                  ))}
              </Select>
            </div>
            <div>
              <Label>{t("legalEntity")}</Label>
              <Select
                disabled={editing.existing || !data.canManage}
                value={editing.policy.subsidiaryId}
                onChange={(event) =>
                  patch({
                    subsidiaryId: event.target.value,
                    currency:
                      data.subsidiaries.find((sub) => sub.id === event.target.value)?.currency ??
                      "",
                  })
                }
              >
                {data.subsidiaries.map((sub) => (
                  <option key={sub.id} value={sub.id}>
                    {sub.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>{t("currency")}</Label>
              <Input
                disabled={editing.existing || !data.canManage}
                maxLength={3}
                value={editing.policy.currency}
                onChange={(event) => patch({ currency: event.target.value.toUpperCase() })}
              />
            </div>
            <div>
              <Label>{t("effectiveFrom")}</Label>
              <DateField
                disabled={editing.existing || !data.canManage}
                value={editing.policy.effectiveFrom}
                onChange={(value) => patch({ effectiveFrom: value })}
              />
            </div>
            <div>
              <Label>{t("effectiveTo")}</Label>
              <DateField
                disabled={!data.canManage}
                value={editing.policy.effectiveTo ?? ""}
                onChange={(value) => patch({ effectiveTo: value || null })}
              />
            </div>
            <div>
              <Label>{t("reason")}</Label>
              <Input
                disabled={!data.canManage}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>
        ) : null}
      </AsyncUrlDrawer>
    </div>
  );
}
