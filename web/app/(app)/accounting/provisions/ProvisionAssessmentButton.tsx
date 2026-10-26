"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, UrlDrawer, Input, Label, SearchSelect, Select, Textarea } from "@openbooks/ui";
import type {
  ProvisionIdentity,
  ProvisionEstimate,
  provisionEditorOptions,
  readProvisionObligation,
} from "@openbooks/engine/provisions";
import { PagedTable } from "@/components/paged-table";
import { LineGrid, type LineGridColumn } from "@/components/line-grid";
import { MoneyInput, moneyFieldError } from "@/components/money-input";
import { useBusinessToday } from "@/components/business-date-provider";
import { useDirtyClose } from "@/lib/use-dirty-close";
import { readApiErrorMessage } from "@/lib/api-error";
import { DateField } from "@/components/date-field";

type Choices = Awaited<ReturnType<typeof provisionEditorOptions>>;
type OutcomeRow = Record<string, unknown> & { id: string; amount: string; probability: string };

export function ProvisionAssessmentHistory({
  assessments,
}: {
  assessments: Awaited<ReturnType<typeof readProvisionObligation>>["assessments"];
}) {
  const t = useTranslations("accounting.provisions"),
    accounting = useTranslations("accounting.lifecycle");
  return (
    <PagedTable
      rows={assessments}
      rowKey={(row) => row.id}
      empty={t("noAssessments")}
      columns={[
        {
          key: "date",
          header: t("date"),
          cell: (row) => (
            <Link href={`/accounting/changes?change=${row.id}`}>{row.effectiveOn}</Link>
          ),
        },
        {
          key: "reason",
          header: t("reason"),
          cell: (row) => row.reason,
          search: (row) => row.reason,
        },
        { key: "status", header: t("status"), cell: (row) => accounting(row.status) },
      ]}
      searchable
    />
  );
}
/** The assessment editor's URL-addressed drawer and exact-decimal outcome grid. */
export function ProvisionAssessmentButton({
  options,
  identity,
  assessmentOpen,
  openHref,
  closeHref,
  stacked = false,
  showTrigger = true,
}: {
  options: Choices;
  identity?: ProvisionIdentity;
  assessmentOpen: boolean;
  openHref: string;
  closeHref: string;
  stacked?: boolean;
  showTrigger?: boolean;
}) {
  const t = useTranslations("accounting.provisions"),
    common = useTranslations("common");
  const today = useBusinessToday(),
    router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({
    date: today,
    method: "best_estimate",
  });
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID()),
    [initialKey, setInitialKey] = useState(requestKey);
  const [obligationId, setObligationId] = useState(() => identity?.id ?? crypto.randomUUID());
  const [outcomes, setOutcomes] = useState<OutcomeRow[]>([]);
  const update = (key: string, value: string) => {
    setValues((current) => {
      const next = { ...current, [key]: value };
      if (key === "subsidiary") {
        if (
          options.projects.some((row) => row.id === current.project && row.subsidiaryId !== value)
        )
          delete next.project;
        for (const accountKey of ["expense", "liability"]) {
          const selected = options.accounts.find((row) => row.id === current[accountKey]);
          if (selected && !selected.subsidiaryIds.includes(value)) delete next[accountKey];
        }
      }
      return next;
    });
    setRequestKey(crypto.randomUUID());
  };
  const updateOutcomes = (rows: typeof outcomes) => {
    setOutcomes(rows);
    setRequestKey(crypto.randomUUID());
  };
  const reset = () => {
    setValues({ date: today, method: "best_estimate" });
    setOutcomes([]);
    setError(null);
    const next = crypto.randomUUID();
    setRequestKey(next);
    setInitialKey(next);
    setObligationId(identity?.id ?? crypto.randomUUID());
  };
  const close = () => {
    reset();
    router.push(closeHref as never);
  };
  const closeGuard = useDirtyClose({
    dirty: requestKey !== initialKey,
    busy,
    onClose: close,
    message: common("feedback.unsavedChanges"),
    confirmLabel: common("confirm.discardChanges"),
  });
  const beforeClose = async () => {
    const allowed = await closeGuard.beforeClose();
    if (allowed) reset();
    return allowed;
  };
  const construction = Boolean(identity?.projectId || values.project);
  const needsEstimate =
    !construction &&
    values.obligation === "yes" &&
    values.outflow === "probable" &&
    values.estimable === "yes";
  const moneyInvalid =
    needsEstimate &&
    (values.method === "best_estimate"
      ? moneyFieldError(t("estimate"), "a money amount", values.amount ?? "", 4, {
          required: true,
        }) !== null
      : values.method === "expected_value"
        ? outcomes.length === 0 ||
          outcomes.some(
            (row) =>
              moneyFieldError(t("estimate"), "a money amount", row.amount, 4, { required: true }) ||
              moneyFieldError(t("probability"), "a probability", row.probability, 4, {
                required: true,
              }),
          )
        : ["minimum", "maximum"].some((key) =>
            moneyFieldError(t(key), "a money amount", values[key] ?? "", 4, { required: true }),
          ));
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const entity = options.subsidiaries.find((row) => row.id === values.subsidiary);
      const obligation = identity ?? {
        id: obligationId,
        name: values.name,
        subsidiaryId: values.subsidiary,
        currency: entity?.currency,
        bookId: values.book,
        expenseAccountId: values.expense,
        liabilityAccountId: values.liability,
        projectId: values.project || null,
      };
      const estimate: ProvisionEstimate | null = !needsEstimate
        ? null
        : values.method === "best_estimate"
          ? { method: "best_estimate", amount: values.amount ?? "" }
          : values.method === "expected_value"
            ? {
                method: "expected_value",
                outcomes: outcomes.map(({ amount, probability }) => ({ amount, probability })),
              }
            : {
                method:
                  values.method === "uniform_range" ? "uniform_range" : "no_better_estimate_range",
                minimum: values.minimum ?? "",
                maximum: values.maximum ?? "",
              };
      const response = await fetch("/api/accounting/provisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(construction
            ? {
                construction: {
                  remainingCost: values.remainingCost,
                  terminationAvailable: values.terminationAvailable === "yes",
                  terminationCost:
                    values.terminationAvailable === "yes" ? values.terminationCost : null,
                  relatedAssetsReviewed: values.assetsReviewed === "yes",
                  impairmentEvidence: values.impairmentEvidence,
                },
              }
            : {}),
          obligation,
          effectiveOn: values.date,
          reason: values.reason,
          idempotencyKey: requestKey,
          assessment: {
            presentObligation: values.obligation === "yes",
            outflow: values.outflow,
            reliablyEstimable: values.estimable === "yes",
            evidence: values.evidence,
            discounting: values.discounting,
            discountEvidence: values.discountEvidence,
            estimate,
          },
        }),
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t("failed")));
      const result = (await response.json()) as { id: string };
      reset();
      router.push(`/accounting/changes?change=${result.id}`);
      router.refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("failed");
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }
  const yesNo = (key: string) => (
    <div className="space-y-1">
      <Label htmlFor={`provision-${key}`}>{t(key)}</Label>
      <Select
        id={`provision-${key}`}
        value={values[key] ?? ""}
        onChange={(event) => update(key, event.target.value)}
      >
        <option value="">{t("choose")}</option>
        <option value="yes">{common("labels.yes")}</option>
        <option value="no">{common("labels.no")}</option>
      </Select>
    </div>
  );
  const picker = (key: string, rows: { id: string; name: string }[]) => (
    <div className="space-y-1">
      <Label>{t(key)}</Label>
      <SearchSelect
        ariaLabel={t(key)}
        value={values[key] ?? ""}
        onChange={(value) => update(key, value)}
        options={rows.map((row) => ({ value: row.id, label: row.name }))}
        placeholder={t("choose")}
      />
    </div>
  );
  const outcomeColumns: LineGridColumn<OutcomeRow>[] = [
    {
      key: "amount",
      label: t("estimate"),
      width: "minmax(140px, 1fr)",
      type: "amount",
      required: true,
    },
    {
      key: "probability",
      label: t("probability"),
      width: "minmax(120px, 1fr)",
      type: "decimal",
      decimalScale: 4,
      required: true,
    },
  ];
  return (
    <>
      {showTrigger ? (
        <Button asChild>
          <Link href={openHref as never}>{identity ? t("review") : t("new")}</Link>
        </Button>
      ) : null}
      <UrlDrawer
        open={assessmentOpen}
        openKey={identity?.id ?? "new"}
        closeHref={closeHref}
        beforeClose={beforeClose}
        stacked={stacked}
        title={identity ? t("review") : t("new")}
        size="2xl"
      >
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground">{t("approvalHint")}</p>
          {identity ? (
            <p className="font-medium">
              {identity.name} · {identity.currency}
            </p>
          ) : (
            <>
              <div className="space-y-1">
                <Label htmlFor="provision-name">{t("name")}</Label>
                <Input
                  id="provision-name"
                  value={values.name ?? ""}
                  onChange={(event) => update("name", event.target.value)}
                  maxLength={200}
                />
              </div>
              {options.projects.length ? (
                <>
                  {picker(
                    "project",
                    options.projects.filter(
                      (row) => !values.subsidiary || row.subsidiaryId === values.subsidiary,
                    ),
                  )}
                  <p className="text-sm text-muted-foreground">{t("projectHint")}</p>
                </>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                {picker("subsidiary", options.subsidiaries)}
                {picker("book", options.books)}
                {picker(
                  "expense",
                  options.accounts.filter(
                    (row) =>
                      ["expense", "expense_other"].includes(row.type) &&
                      row.subsidiaryIds.includes(values.subsidiary ?? ""),
                  ),
                )}
                {picker(
                  "liability",
                  options.accounts.filter(
                    (row) =>
                      ["liability_current_other", "liability_long_term"].includes(row.type) &&
                      row.subsidiaryIds.includes(values.subsidiary ?? ""),
                  ),
                )}
              </div>
            </>
          )}
          <div className="space-y-1">
            <Label htmlFor="provision-date">{t("date")}</Label>
            <DateField
              id="provision-date"
              value={values.date ?? ""}
              onChange={(value) => update("date", value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {yesNo("obligation")}
            {yesNo("estimable")}
            <div className="space-y-1">
              <Label htmlFor="provision-outflow">{t("outflow")}</Label>
              <Select
                id="provision-outflow"
                value={values.outflow ?? ""}
                onChange={(event) => update("outflow", event.target.value)}
              >
                <option value="">{t("choose")}</option>
                {["probable", "possible", "remote"].map((value) => (
                  <option key={value} value={value}>
                    {t(value)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="provision-evidence">{t("evidence")}</Label>
            <Textarea
              id="provision-evidence"
              value={values.evidence ?? ""}
              onChange={(event) => update("evidence", event.target.value)}
              maxLength={10000}
            />
          </div>
          {construction ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t("forecastHint")}</p>
              <MoneyInput
                value={values.remainingCost ?? ""}
                onChange={(value) => update("remainingCost", value)}
                field={t("remainingCost")}
                ariaLabel={t("remainingCost")}
                required
              />
              {yesNo("terminationAvailable")}
              {values.terminationAvailable === "yes" ? (
                <MoneyInput
                  value={values.terminationCost ?? ""}
                  onChange={(value) => update("terminationCost", value)}
                  field={t("terminationCost")}
                  ariaLabel={t("terminationCost")}
                  required
                />
              ) : null}
              {yesNo("assetsReviewed")}
              <Label htmlFor="provision-impairment-evidence">{t("impairmentEvidence")}</Label>
              <Textarea
                id="provision-impairment-evidence"
                value={values.impairmentEvidence ?? ""}
                onChange={(event) => update("impairmentEvidence", event.target.value)}
                maxLength={10000}
              />
            </div>
          ) : null}
          {needsEstimate ? (
            <>
              <div className="space-y-1">
                <Label htmlFor="provision-method">{t("method")}</Label>
                <Select
                  id="provision-method"
                  value={values.method ?? "best_estimate"}
                  onChange={(event) => update("method", event.target.value)}
                >
                  {(options.reportingFramework === "ifrs"
                    ? ["best_estimate", "expected_value", "uniform_range"]
                    : ["best_estimate", "no_better_estimate_range"]
                  ).map((value) => (
                    <option key={value} value={value}>
                      {t(value)}
                    </option>
                  ))}
                </Select>
              </div>
              {values.method === "best_estimate" ? (
                <MoneyInput
                  value={values.amount ?? ""}
                  onChange={(value) => update("amount", value)}
                  field={t("estimate")}
                  ariaLabel={t("estimate")}
                  required
                />
              ) : values.method === "expected_value" ? (
                <LineGrid<OutcomeRow>
                  columns={outcomeColumns}
                  rows={outcomes}
                  onRowsChange={updateOutcomes}
                  emptyRow={() => ({ id: crypto.randomUUID(), amount: "", probability: "" })}
                  getRowKey={(row) => row.id}
                  addLabel={t("addOutcome")}
                  minRows={0}
                />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {["minimum", "maximum"].map((key) => (
                    <MoneyInput
                      key={key}
                      value={values[key] ?? ""}
                      onChange={(value) => update(key, value)}
                      field={t(key)}
                      ariaLabel={t(key)}
                      required
                    />
                  ))}
                </div>
              )}
            </>
          ) : !construction ? (
            <p className="text-sm text-muted-foreground">{t("unrecognizedHint")}</p>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="provision-discounting">{t("discounting")}</Label>
            <Select
              id="provision-discounting"
              value={values.discounting ?? ""}
              onChange={(event) => update("discounting", event.target.value)}
            >
              <option value="">{t("choose")}</option>
              <option value="immaterial">{t("immaterial")}</option>
              {options.reportingFramework === "ifrs" ? (
                <option value="included_in_estimate">{t("included_in_estimate")}</option>
              ) : (
                <option value="undiscounted">{t("undiscounted")}</option>
              )}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="provision-discount-evidence">{t("discountEvidence")}</Label>
            <Textarea
              id="provision-discount-evidence"
              value={values.discountEvidence ?? ""}
              onChange={(event) => update("discountEvidence", event.target.value)}
              maxLength={10000}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="provision-reason">{t("reason")}</Label>
            <Textarea
              id="provision-reason"
              value={values.reason ?? ""}
              onChange={(event) => update("reason", event.target.value)}
              maxLength={1000}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              disabled={
                busy ||
                moneyInvalid ||
                (construction &&
                  (!values.remainingCost ||
                    !values.terminationAvailable ||
                    values.assetsReviewed !== "yes" ||
                    (values.impairmentEvidence?.trim().length ?? 0) < 20 ||
                    (values.terminationAvailable === "yes" && !values.terminationCost))) ||
                !values.obligation ||
                !values.estimable ||
                !values.outflow ||
                !values.discounting ||
                (values.evidence?.trim().length ?? 0) < 20 ||
                (values.discountEvidence?.trim().length ?? 0) < 20 ||
                (values.reason?.trim().length ?? 0) < 8 ||
                (!identity &&
                  (!values.name?.trim() ||
                    !values.subsidiary ||
                    !values.book ||
                    !values.expense ||
                    !values.liability))
              }
              onClick={() => void save()}
            >
              {t("propose")}
            </Button>
            <Button variant="outline" disabled={busy} onClick={closeGuard.close}>
              {common("actions.cancel")}
            </Button>
          </div>
        </div>
      </UrlDrawer>
    </>
  );
}
