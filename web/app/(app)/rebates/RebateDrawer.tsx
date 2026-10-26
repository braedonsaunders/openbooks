"use client";

import { useState } from "react";
import { ApprovalActions } from "@/components/approval-actions";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge, Button, Input, SearchSelect, Select, UrlDrawer } from "@openbooks/ui";
import { DrawerTabStrip } from "@/components/drawer-tab-strip";
import { DateField } from "@/components/date-field";
import { Field } from "@/components/field";
import { MoneyInput } from "@/components/money-input";
import { readApiErrorMessage } from "@/lib/api-error";
import { useDirtyClose } from "@/lib/use-dirty-close";
import { useMoney } from "@/components/money-provider";
import type { RebateAgreement, RebateClaim } from "@openbooks/engine/revenue/rebates";
import { cmp } from "@openbooks/engine/money/money";

export type RebateDrawerData = {
  agreement: RebateAgreement;
  claim: RebateClaim | null;
  parties: { id: string; name: string }[];
  banks: { id: string; name: string }[];
  canPost: boolean;
  today: string;
  baseCurrency: string;
  sources: { lineId: string; documentId: string; label: string }[];
  closeHref: string;
};

const STATUS_VARIANT: Record<string, "success" | "secondary" | "warning" | "outline"> = {
  draft: "outline",
  approved: "success",
  document_pending: "warning",
  settled: "success",
  cancelled: "secondary",
};

export function RebateDrawer({ data }: { data: RebateDrawerData }) {
  const router = useRouter();
  const t = useTranslations("rebates");
  const common = useTranslations("common");
  const { money } = useMoney(data.agreement.currency);
  const { agreement: a, claim: c } = data;
  const initialPartyId = a.party_id ?? data.parties[0]?.id ?? "";
  const initialFxRate = a.currency === data.baseCurrency ? "1" : "";
  const [date, setDate] = useState(data.today);
  const [reason, setReason] = useState("");
  const [partyId, setPartyId] = useState(initialPartyId);
  const [bankId, setBankId] = useState("");
  const [fxRate, setFxRate] = useState(initialFxRate);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("terms");
  const [method, setMethod] = useState("credit");
  const [lineId, setLineId] = useState("");
  const [cost, setCost] = useState("");
  const [resale, setResale] = useState("");
  const [evidence, setEvidence] = useState("");
  const [documentId, setDocumentId] = useState("");

  const dirty =
    date !== data.today ||
    reason !== "" ||
    partyId !== initialPartyId ||
    bankId !== "" ||
    fxRate !== initialFxRate ||
    method !== "credit" ||
    lineId !== "" ||
    cost !== "" ||
    resale !== "" ||
    evidence !== "" ||
    documentId !== "";
  const closeGuard = useDirtyClose({
    dirty,
    busy,
    onClose: () => router.push(data.closeHref as never),
    message: common("feedback.unsavedChanges"),
    confirmLabel: common("confirm.discardChanges"),
  });

  function resetDrafts() {
    setDate(data.today);
    setReason("");
    setPartyId(initialPartyId);
    setBankId("");
    setFxRate(initialFxRate);
    setMethod("credit");
    setLineId("");
    setCost("");
    setResale("");
    setEvidence("");
    setDocumentId("");
  }

  async function command(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/rebates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setError(await readApiErrorMessage(response, t("drawer.errors.actionFailed")));
        return;
      }
      const result = await response.json();
      resetDrafts();
      if (result.documentId) {
        const href =
          result.kind === "customer_credit" || result.kind === "customer_invoice"
            ? `/ar/invoices?doc=${result.documentId}`
            : `/ap/bills?doc=${result.documentId}`;
        router.push(href as never);
      } else if (body.action === "claim" && result.id) {
        router.push(`/rebates?view=claims&record=${result.id}` as never);
      }
      router.refresh();
    } catch {
      setError(t("drawer.errors.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const reasonField = (
    <Field label={t("drawer.reviewReason")}>
      <Input value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} />
    </Field>
  );
  const dateField = (
    <Field label={t("drawer.postingOrCutoffDate")}>
      <DateField value={date} onChange={setDate} disabled={busy} />
    </Field>
  );
  const status = c?.status ?? a.status;

  return (
    <UrlDrawer
      open
      openKey={c?.id ?? a.id}
      closeHref={data.closeHref}
      beforeClose={closeGuard.beforeClose}
      size="xl"
      title={c ? t("drawer.claimTitle") : a.name}
      description={`${a.code} · ${t(`sides.${a.side}`)} · ${t(`statuses.${status}`)}`}
    >
      <div className="space-y-4 p-1">
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[status] ?? "secondary"}>{t(`statuses.${status}`)}</Badge>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {c ? (
          <div className="space-y-4">
            <p className="text-lg tabular-nums">
              {money(c.amount)} {a.currency}
            </p>
            <p className="text-sm">{t("drawer.claimEarnedThrough", { date: c.cutoff_on })}</p>
            <ApprovalActions subjectKind={`${a.side}_rebate_claim`} subjectId={c.id} />
            {data.canPost && c.status === "draft" ? (
              <>
                {reasonField}
                <Button
                  disabled={busy || reason.trim().length < 8}
                  onClick={() => command({ action: "approveClaim", claimId: c.id, reason })}
                >
                  {common("actions.submit")}
                </Button>
              </>
            ) : null}
            {data.canPost && c.status === "approved" ? (
              <div className="space-y-4">
                <Field label={t("drawer.settlementMethod")}>
                  <Select
                    value={method}
                    disabled={busy}
                    onChange={(event) => setMethod(event.target.value)}
                  >
                    <option value="credit">{t("drawer.creditDocument")}</option>
                    <option value="payment">{t("drawer.paymentOrReceipt")}</option>
                  </Select>
                </Field>
                {dateField}
                {method === "credit" ? (
                  <Button
                    disabled={busy || !date}
                    onClick={() =>
                      command({
                        action: "prepareCredit",
                        claimId: c.id,
                        documentDate: date,
                      })
                    }
                  >
                    {t("drawer.prepareDocument", {
                      kind: cmp(c.amount, "0") > 0 ? t("drawer.credit") : t("drawer.recovery"),
                    })}
                  </Button>
                ) : (
                  <div className="space-y-4">
                    <Field label={t("drawer.bankAccount")}>
                      <SearchSelect
                        value={bankId}
                        onChange={setBankId}
                        disabled={busy}
                        options={data.banks.map((bank) => ({
                          value: bank.id,
                          label: bank.name,
                        }))}
                      />
                    </Field>
                    <Field
                      label={t("drawer.settlementFxRate", {
                        from: a.currency,
                        to: data.baseCurrency,
                      })}
                    >
                      <MoneyInput
                        value={fxRate}
                        onChange={setFxRate}
                        field={t("drawer.fxRateField")}
                        ariaLabel={t("drawer.fxRateField")}
                        maxScale={10}
                        required
                        disabled={busy}
                      />
                    </Field>
                    {reasonField}
                    <Button
                      disabled={busy || !date || !bankId || !fxRate || reason.trim().length < 8}
                      onClick={() =>
                        command({
                          action: "pay",
                          claimId: c.id,
                          postingDate: date,
                          bankAccountId: bankId,
                          fxRate,
                          reason,
                        })
                      }
                    >
                      {t("drawer.recordBankSettlement")}
                    </Button>
                  </div>
                )}
              </div>
            ) : null}
            {data.canPost && ["draft", "approved"].includes(c.status) ? (
              <Button
                variant="outline"
                disabled={busy || reason.trim().length < 8}
                onClick={() => command({ action: "cancelClaim", claimId: c.id, reason })}
              >
                {t("drawer.cancelClaim")}
              </Button>
            ) : null}
            {c.settlement_document_id ? (
              <Link
                className="underline"
                href={`${a.side === "customer" ? "/ar/invoices" : "/ap/bills"}?doc=${c.settlement_document_id}`}
              >
                {t("drawer.openSettlementDocument")}
              </Link>
            ) : null}
            {data.canPost && c.status === "settled" && !c.settlement_document_id ? (
              <div className="space-y-4">
                {dateField}
                {reasonField}
                <Button
                  variant="outline"
                  disabled={busy || !date || reason.trim().length < 8}
                  onClick={() =>
                    command({
                      action: "reversePayment",
                      claimId: c.id,
                      postingDate: date,
                      reason,
                    })
                  }
                >
                  {t("drawer.reverseBankSettlement")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-5">
            <DrawerTabStrip
              tabs={[
                { key: "terms", label: t("drawer.termsTab") },
                { key: "claim", label: t("drawer.generateClaimTab") },
                { key: "cost", label: t("drawer.costEvidenceTab") },
              ]}
              activeKey={tab}
              onSelect={setTab}
              ariaLabel={t("drawer.agreementDetails")}
            />
            <div hidden={tab !== "terms"} className="space-y-4">
              <p>
                {t("drawer.eligiblePeriod", {
                  activity: t(`activities.${a.activity}`),
                  start: a.effective_from,
                  end: a.effective_to,
                  currency: a.currency,
                })}
              </p>
              <p>
                {t("drawer.methodLine", {
                  method: t(`methods.${a.method}`),
                  basis: t(`tierBasis.${a.tier_basis}`),
                })}
              </p>
              <p>
                {t("drawer.stackingPolicy", {
                  policy: t(`stacking.${a.stacking}`),
                  group: a.selection_group,
                })}
              </p>
              <Link className="underline" href={`/admin/setup/rebate-agreements?row=${a.id}`}>
                {t("drawer.viewAgreementSettings")}
              </Link>
              <ApprovalActions subjectKind={`${a.side}_rebate_agreement`} subjectId={a.id} />
              {data.canPost && a.status === "draft" ? (
                <div className="space-y-4">
                  {reasonField}
                  <Button
                    disabled={busy || reason.trim().length < 8}
                    onClick={() =>
                      command({
                        action: "approveAgreement",
                        agreementId: a.id,
                        reason,
                      })
                    }
                  >
                    {common("actions.submit")}
                  </Button>
                </div>
              ) : null}
            </div>
            <div hidden={tab !== "claim"} className="space-y-4">
              <Field label={t("drawer.customerOrVendor")}>
                <SearchSelect
                  value={partyId}
                  onChange={setPartyId}
                  disabled={busy}
                  options={data.parties.map((party) => ({
                    value: party.id,
                    label: party.name,
                  }))}
                />
              </Field>
              {dateField}
              {reasonField}
              <Button
                disabled={
                  !data.canPost ||
                  busy ||
                  a.status !== "approved" ||
                  !partyId ||
                  reason.trim().length < 8
                }
                onClick={() =>
                  command({
                    action: "claim",
                    agreementId: a.id,
                    partyId,
                    cutoffOn: date,
                    reason,
                  })
                }
              >
                {t("drawer.generateEarnedClaim")}
              </Button>
            </div>
            <div hidden={tab !== "cost"} className="space-y-4">
              <p className="text-sm">{t("drawer.stockCostExplanation")}</p>
              <Field label={t("drawer.sourceDocumentLine")}>
                <SearchSelect
                  value={lineId}
                  onChange={setLineId}
                  disabled={busy}
                  options={data.sources.map((source) => ({
                    value: source.lineId,
                    label: source.label,
                  }))}
                />
              </Field>
              <Field label={t("drawer.costInCurrency", { currency: a.currency })}>
                <MoneyInput
                  value={cost}
                  onChange={setCost}
                  field={t("drawer.costField")}
                  ariaLabel={t("drawer.costField")}
                  required
                  disabled={busy}
                />
              </Field>
              <Field label={t("drawer.downstreamResale")}>
                <MoneyInput
                  value={resale}
                  onChange={setResale}
                  field={t("drawer.resaleField")}
                  ariaLabel={t("drawer.resaleField")}
                  disabled={busy}
                />
              </Field>
              <Field label={t("drawer.costEvidence")}>
                <Input
                  value={evidence}
                  disabled={busy}
                  onChange={(event) => setEvidence(event.target.value)}
                />
              </Field>
              <Button
                variant="outline"
                disabled={!data.canPost || busy || !lineId || !cost || evidence.trim().length < 20}
                onClick={() =>
                  command({
                    action: "attestCost",
                    documentLineId: lineId,
                    costAmount: cost,
                    resaleAmount: resale || null,
                    currency: a.currency,
                    evidence,
                  })
                }
              >
                {t("drawer.recordCostEvidence")}
              </Button>
              <Field label={t("drawer.postedSourceTransaction")}>
                <SearchSelect
                  value={documentId}
                  onChange={setDocumentId}
                  disabled={busy}
                  options={[
                    ...new Map(
                      data.sources.map((source) => [
                        source.documentId,
                        {
                          value: source.documentId,
                          label: source.label.split(" · ")[0]!,
                        },
                      ]),
                    ).values(),
                  ]}
                />
              </Field>
              {dateField}
              {reasonField}
              <Button
                disabled={!data.canPost || busy || !documentId || reason.trim().length < 8}
                onClick={() =>
                  command({
                    action: "reassess",
                    documentId,
                    postingDate: date,
                    reason,
                  })
                }
              >
                {t("drawer.reassessEarnedRebates")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </UrlDrawer>
  );
}
