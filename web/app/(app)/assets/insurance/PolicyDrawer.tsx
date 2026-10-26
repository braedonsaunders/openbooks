"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Badge, Button, Input, Label, Select, UrlDrawer } from "@openbooks/ui";
import { DrawerTabStrip } from "@/components/drawer-tab-strip";
import { PagedTable } from "@/components/paged-table";
import { useMoney } from "@/components/money-provider";
import { useAppAction } from "@/lib/use-app-action";
import { useDirtyClose } from "@/lib/use-dirty-close";
import { mergeHref } from "@/lib/list-params";
import { postJson } from "../depth-client";
import type { InsuranceData, PolicyDetail } from "./_data";
import { PolicyFields, policyBody, type PolicyFormValues } from "./PolicyFields";
import { DateField } from "@/components/date-field";

type Tab = "coverage" | "terms" | "renew";

/** One policy: covered assets and their values, the policy terms, and renewal into a new period. */
export function PolicyDrawer({
  policy,
  data,
  closeHref,
  createMode = false,
}: {
  policy: PolicyDetail | null;
  data: InsuranceData;
  closeHref: string;
  createMode?: boolean;
}) {
  if (createMode) return <PolicyCreateDrawer data={data} closeHref={closeHref} />;
  return policy ? <PolicyRecordDrawer policy={policy} data={data} closeHref={closeHref} /> : null;
}

function PolicyCreateDrawer({ data, closeHref }: { data: InsuranceData; closeHref: string }) {
  const t = useTranslations("assets");
  const tc = useTranslations("common");
  const router = useRouter();
  const action = useAppAction();
  const [form, setForm] = useState(() => ({
    subsidiaryId: data.subsidiaries[0]?.id ?? "",
    values: {
      insurerPartyId: "",
      policyNumber: "",
      description: "",
      coverageStartsOn: data.today,
      coverageEndsOn: "",
      premium: "",
      deductible: "",
      renewalLeadDays: "30",
    } satisfies PolicyFormValues,
  }));
  const [initialForm] = useState(form);
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  const closeGuard = useDirtyClose({
    dirty,
    busy: action.busy,
    onClose: () => {},
    message: tc("feedback.unsavedChanges"),
    confirmLabel: tc("confirm.discardChanges"),
  });

  async function create() {
    await action.execute(
      () =>
        postJson<{ id: string }>(
          "/api/assets/insurance/policies",
          { subsidiaryId: form.subsidiaryId, ...policyBody(form.values) },
          t("insurance.saveFailed"),
        ),
      {
        fallbackMessage: t("insurance.saveFailed"),
        successMessage: t("insurance.created"),
        onOk: (created) => {
          router.push(
            mergeHref("/assets/insurance", data.currentParams, {
              tab: "policies",
              policy: created.id,
            }),
          );
          router.refresh();
        },
      },
    );
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      beforeClose={closeGuard.beforeClose}
      size="xl"
      title={t("insurance.new")}
      headerActions={
        <Button
          disabled={
            action.busy ||
            !form.subsidiaryId ||
            !form.values.insurerPartyId ||
            !form.values.policyNumber.trim() ||
            !form.values.coverageEndsOn
          }
          onClick={() => void create()}
        >
          {t("insurance.create")}
        </Button>
      }
    >
      <div className="space-y-4 p-1">
        <ActionAlert error={action.refusal} fallbackMessage={t("insurance.saveFailed")} />
        <div className="space-y-1.5">
          <Label htmlFor="new-policy-subsidiary">{t("insurance.fields.legalEntity")}</Label>
          <Select
            id="new-policy-subsidiary"
            value={form.subsidiaryId}
            onChange={(event) =>
              setForm((current) => ({ ...current, subsidiaryId: event.target.value }))
            }
          >
            {data.subsidiaries.map((subsidiary) => (
              <option key={subsidiary.id} value={subsidiary.id}>
                {subsidiary.name}
              </option>
            ))}
          </Select>
        </div>
        <PolicyFields
          idPrefix="new-policy"
          values={form.values}
          insurers={data.insurers}
          onChange={(patch) =>
            setForm((current) => ({ ...current, values: { ...current.values, ...patch } }))
          }
        />
      </div>
    </UrlDrawer>
  );
}

function PolicyRecordDrawer({
  policy,
  data,
  closeHref,
}: {
  policy: PolicyDetail;
  data: InsuranceData;
  closeHref: string;
}) {
  const t = useTranslations("assets");
  const { money } = useMoney(policy.currency);
  const router = useRouter();
  const action = useAppAction();
  const manage = data.canMaintain;
  const tabs: Tab[] = manage
    ? [
        "coverage",
        "terms",
        ...(policy.status === "active" && !policy.renewed ? (["renew"] as const) : []),
      ]
    : ["coverage"];
  const [tab, setTab] = useState<Tab>("coverage");
  const [assetId, setAssetId] = useState("");
  const [insuredValue, setInsuredValue] = useState("");
  const [replacementValue, setReplacementValue] = useState("");
  const [removeReason, setRemoveReason] = useState("");
  const [values, setValues] = useState<PolicyFormValues>({
    insurerPartyId: policy.insurerPartyId,
    policyNumber: policy.policyNumber,
    description: policy.description ?? "",
    coverageStartsOn: policy.coverageStartsOn,
    coverageEndsOn: policy.coverageEndsOn,
    premium: policy.premium,
    deductible: policy.deductible,
    renewalLeadDays: String(policy.renewalLeadDays),
  });
  const [status, setStatus] = useState(policy.status);
  const [renewStart, setRenewStart] = useState(policy.coverageEndsOn);
  const [renewEnd, setRenewEnd] = useState("");
  const [renewPremium, setRenewPremium] = useState(policy.premium);
  const eligible = data.assets.filter((asset) => asset.subsidiaryId === policy.subsidiaryId);

  const run = (
    url: string,
    body: unknown,
    success: string,
    method: "POST" | "PATCH" = "POST",
    onOk?: (result: { id?: string }) => void,
  ) =>
    action.execute(() => postJson<{ id?: string }>(url, body, t("insurance.saveFailed"), method), {
      fallbackMessage: t("insurance.saveFailed"),
      successMessage: success,
      onOk: (result) => {
        onOk?.(result);
        router.refresh();
      },
    });

  const field = (id: string, label: string, control: ReactNode) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {control}
    </div>
  );

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500 dark:text-slate-400">
            {policy.policyNumber}
          </span>
          <span>{policy.insurerName}</span>
          {policy.status === "cancelled" ? (
            <Badge variant="secondary">{t("insurance.status.cancelled")}</Badge>
          ) : null}
        </span>
      }
      description={t("insurance.drawerDescription", {
        start: policy.coverageStartsOn,
        end: policy.coverageEndsOn,
        entity: policy.subsidiaryName,
      })}
      subtabs={
        <DrawerTabStrip
          ariaLabel={t("insurance.tabsAria")}
          activeKey={tab}
          onSelect={setTab}
          tabs={tabs.map((key) => ({ key, label: t(`insurance.drawerTabs.${key}`) }))}
        />
      }
      footer={
        <div className="flex w-full justify-end gap-4 text-sm tabular-nums text-slate-600 dark:text-slate-300">
          <span>
            {t("insurance.columns.premium")} {money(policy.premium)}
          </span>
          <span>
            {t("insurance.fields.deductible")} {money(policy.deductible)}
          </span>
          <strong className="text-slate-900 dark:text-slate-100">
            {t("insurance.columns.insuredTotal")} {money(policy.insuredTotal)}
          </strong>
        </div>
      }
    >
      <div className="space-y-4 p-1">
        <ActionAlert error={action.refusal} fallbackMessage={t("insurance.saveFailed")} />
        {tab === "coverage" ? (
          <div className="space-y-3">
            <PagedTable
              rows={policy.coverages}
              source="asset_insurance_coverages"
              rowKey={(row) => row.assetId}
              columns={[
                {
                  key: "asset",
                  header: t("insurance.columns.asset"),
                  cell: (row) => (
                    <Link
                      href={`/assets?asset=${row.assetId}`}
                      className="text-teal-700 hover:underline dark:text-teal-300"
                    >
                      <span className="font-mono text-[13px]">{row.assetNumber}</span>{" "}
                      {row.assetName}
                    </Link>
                  ),
                },
                {
                  key: "insured",
                  header: t("insurance.columns.insuredValue"),
                  align: "right",
                  cell: (row) => <span className="tabular-nums">{money(row.insuredValue)}</span>,
                },
                {
                  key: "replacement",
                  header: t("insurance.columns.replacementValue"),
                  align: "right",
                  cell: (row) =>
                    row.replacementValue ? (
                      <span className="tabular-nums">{money(row.replacementValue)}</span>
                    ) : (
                      "—"
                    ),
                },
                {
                  key: "actions",
                  header: "",
                  cell: (row) =>
                    manage ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={action.busy || !removeReason.trim()}
                        onClick={() =>
                          run(
                            `/api/assets/insurance/policies/${policy.id}`,
                            {
                              action: "remove_coverage",
                              assetId: row.assetId,
                              reason: removeReason,
                            },
                            t("insurance.coverageRemoved"),
                          )
                        }
                      >
                        {t("insurance.remove")}
                      </Button>
                    ) : null,
                },
              ]}
              empty={
                <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                  {t("insurance.noCoverage")}
                </p>
              }
              emptyAsRow
            />
            {manage && policy.coverages.length > 0
              ? field(
                  "remove-reason",
                  t("insurance.fields.removeReason"),
                  <Input
                    id="remove-reason"
                    value={removeReason}
                    onChange={(event) => setRemoveReason(event.target.value)}
                  />,
                )
              : null}
            {manage && policy.status === "active" ? (
              <div className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-[1fr_9rem_9rem_auto] sm:items-end dark:border-slate-800">
                {field(
                  "cover-asset",
                  t("insurance.columns.asset"),
                  <Select
                    id="cover-asset"
                    value={assetId}
                    onChange={(event) => setAssetId(event.target.value)}
                  >
                    <option value="">{t("insurance.fields.choose")}</option>
                    {eligible.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.label}
                      </option>
                    ))}
                  </Select>,
                )}
                {field(
                  "cover-insured",
                  t("insurance.columns.insuredValue"),
                  <Input
                    id="cover-insured"
                    inputMode="decimal"
                    value={insuredValue}
                    onChange={(event) => setInsuredValue(event.target.value)}
                  />,
                )}
                {field(
                  "cover-replacement",
                  t("insurance.columns.replacementValue"),
                  <Input
                    id="cover-replacement"
                    inputMode="decimal"
                    value={replacementValue}
                    onChange={(event) => setReplacementValue(event.target.value)}
                  />,
                )}
                <Button
                  disabled={action.busy || !assetId || !insuredValue.trim()}
                  onClick={() =>
                    run(
                      `/api/assets/insurance/policies/${policy.id}`,
                      {
                        action: "set_coverage",
                        assetId,
                        insuredValue,
                        replacementValue: replacementValue.trim() || null,
                      },
                      t("insurance.coverageSaved"),
                    )
                  }
                >
                  {t("insurance.cover")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === "terms" ? (
          <div className="space-y-3">
            <PolicyFields
              idPrefix="edit-policy"
              values={values}
              insurers={data.insurers}
              onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
            />
            {field(
              "policy-status",
              t("insurance.columns.status"),
              <Select
                id="policy-status"
                value={status}
                onChange={(event) => setStatus(event.target.value as "active" | "cancelled")}
              >
                <option value="active">{t("insurance.status.active")}</option>
                <option value="cancelled">{t("insurance.status.cancelled")}</option>
              </Select>,
            )}
            <Button
              disabled={action.busy || !values.policyNumber.trim()}
              onClick={() =>
                run(
                  `/api/assets/insurance/policies/${policy.id}`,
                  {
                    ...policyBody(values),
                    status,
                    expectedUpdatedAt: policy.updatedAt,
                  },
                  t("insurance.saved"),
                  "PATCH",
                )
              }
            >
              {t("insurance.save")}
            </Button>
          </div>
        ) : null}

        {tab === "renew" ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">{t("insurance.renewHelp")}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {field(
                "renew-start",
                t("insurance.fields.coverageStartsOn"),
                <DateField
                  id="renew-start"
                  value={renewStart}
                  onChange={(value) => setRenewStart(value)}
                />,
              )}
              {field(
                "renew-end",
                t("insurance.fields.coverageEndsOn"),
                <DateField
                  id="renew-end"
                  value={renewEnd}
                  onChange={(value) => setRenewEnd(value)}
                />,
              )}
              {field(
                "renew-premium",
                t("insurance.fields.premium"),
                <Input
                  id="renew-premium"
                  inputMode="decimal"
                  value={renewPremium}
                  onChange={(event) => setRenewPremium(event.target.value)}
                />,
              )}
            </div>
            <Button
              disabled={action.busy || !renewEnd}
              onClick={() =>
                run(
                  `/api/assets/insurance/policies/${policy.id}`,
                  {
                    action: "renew",
                    coverageStartsOn: renewStart,
                    coverageEndsOn: renewEnd,
                    premium: renewPremium.trim() || null,
                  },
                  t("insurance.renewed"),
                  "POST",
                  (result) => {
                    if (result.id) router.push(`/assets/insurance?policy=${result.id}`);
                  },
                )
              }
            >
              {t("insurance.renew")}
            </Button>
          </div>
        ) : null}
      </div>
    </UrlDrawer>
  );
}
