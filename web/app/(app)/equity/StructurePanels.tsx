"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Badge, Button, Input, SearchSelect, Textarea, UrlDrawer } from "@openbooks/ui";
import type { ClassRow } from "@openbooks/engine/equity";
import { PagedTable } from "@/components/paged-table";
import { DateField } from "@/components/date-field";
import { useAppAction } from "@/lib/use-app-action";
import { EquityAsOfControl } from "./AsOfControl";
import type { EquityContext, StakeholdersViewData, StructureViewData } from "./view";
import {
  CELL,
  CommandRefusal,
  DATE_CELL,
  Field,
  HEAD,
  LINK,
  NUM_CELL,
  NUM_HEAD,
  PendingActions,
  SegmentTabs,
  isPendingApproval,
  listSort,
  postCommand,
  toastGoverned,
  useCivilDate,
  useDecimal,
  usePercent,
  usePrice,
  useShares,
  withParams,
} from "./shared";

const BASE = "/equity";

type ClassActionMode = "authorized_shares" | "conversion_price" | "conversion_class" | "split";

/**
 * Share classes on the as-of date with their terms and capitalization.
 * Approvers amend a class or record a split in its drawer (`?amend=<id>`).
 */
export function EquityClassesPanel({ view }: { view: StructureViewData | null }) {
  const t = useTranslations("equity");
  const shares = useShares();
  const price = usePrice();
  const multiple = useDecimal();
  const percentText = usePercent();
  const search = useSearchParams();
  if (!view) return null;
  const { context } = view;
  const terms = new Map(view.structure.classes.map((row) => [row.id, row]));
  const amendId = search?.get("amend") ?? null;
  const amending = amendId
    ? (view.classRows.find((row) => row.shareClassId === amendId) ?? null)
    : null;
  return (
    <div className="space-y-3">
      <PendingActions
        context={context}
        filter={(request) => request.action === "class_amendment" || request.action === "split"}
      />
      <PagedTable
        prepared
        searchable
        source="equity_share_classes"
        rows={view.classRows}
        rowKey={(row) => row.shareClassId}
        empty={t("classes.empty")}
        emptyFiltered={t("classes.emptyFiltered")}
        urlState={{
          pageKey: "page",
          page: context.list.page,
          searchKey: "q",
          query: context.list.query,
        }}
        {...listSort(context)}
        toolbarAfter={<EquityAsOfControl control={view.asOfControl} />}
        columns={[
          {
            key: "class",
            header: <>{t("capTable.columns.class")}</>,
            headerClassName: HEAD,
            className: CELL,
            cell: (row) => (
              <span>
                <span className="font-mono font-medium">{row.code}</span>{" "}
                <span className="text-slate-500">{row.name}</span>
              </span>
            ),
            search: (row) => `${row.code} ${row.name}`,
            sortKey: "class",
            sortValue: (row) => row.code,
          },
          {
            key: "kind",
            header: <>{t("classes.columns.kind")}</>,
            headerClassName: HEAD,
            className: CELL,
            cell: (row) => <Badge variant="outline">{t(`classKind.${row.kind}`)}</Badge>,
            search: (row) => t(`classKind.${row.kind}`),
            sortKey: "kind",
            sortValue: (row) => t(`classKind.${row.kind}`),
          },
          {
            key: "seniority",
            header: <>{t("classes.columns.seniority")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <>{row.kind === "preferred" ? row.seniority : "—"}</>,
            sortKey: "seniority",
            sortValue: (row) => (row.kind === "preferred" ? row.seniority : null),
          },
          {
            key: "authorized",
            header: <>{t("capTable.columns.authorized")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <>{shares(row.authorized)}</>,
            sortKey: "authorized",
            sortType: "decimal",
            sortValue: (row) => row.authorized,
          },
          {
            key: "outstanding",
            header: <>{t("capTable.columns.outstanding")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <>{shares(row.outstanding)}</>,
            sortKey: "outstanding",
            sortType: "decimal",
            sortValue: (row) => row.outstanding,
          },
          {
            key: "par",
            header: <>{t("classes.columns.par")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <>{price(row.parValue, context.currency)}</>,
          },
          {
            key: "issuePrice",
            header: <>{t("classes.columns.issuePrice")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <>{price(row.originalIssuePrice, context.currency)}</>,
          },
          {
            key: "conversionPrice",
            header: <>{t("classes.columns.conversionPrice")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <>{price(row.conversionPrice, context.currency)}</>,
          },
          {
            key: "preference",
            header: <>{t("classes.columns.preference")}</>,
            headerClassName: HEAD,
            className: `${CELL} text-xs`,
            cell: (row) => {
              const record = terms.get(row.shareClassId);
              if (!record || record.kind !== "preferred") return <>—</>;
              return (
                <>
                  {`${multiple(record.liquidationMultiple)}×`} ·{" "}
                  {t(`participation.${record.participation}`)}
                  {record.participation === "capped" && record.participationCapMultiple
                    ? ` (${multiple(record.participationCapMultiple)}×)`
                    : ""}
                </>
              );
            },
          },
          {
            key: "antiDilution",
            header: <>{t("fields.antiDilution")}</>,
            headerClassName: HEAD,
            className: `${CELL} text-xs`,
            cell: (row) => {
              const record = terms.get(row.shareClassId);
              return (
                <>
                  {record && record.kind === "preferred"
                    ? t(`antiDilution.${record.antiDilution}`)
                    : "—"}
                </>
              );
            },
          },
          {
            key: "fullyDilutedPercent",
            header: <>{t("capTable.columns.fullyDilutedPercent")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <>{percentText(row.fullyDilutedPercent)}</>,
            sortKey: "fullyDilutedPercent",
            sortType: "decimal",
            sortValue: (row) => row.fullyDilutedPercent,
          },
          {
            key: "actions",
            header: <span className="sr-only">{t("capTable.columns.actions")}</span>,
            headerClassName: HEAD,
            className: `${CELL} text-right`,
            cell: (row) =>
              context.canManage ? (
                <Button asChild size="sm" variant="ghost">
                  <Link href={withParams(BASE, context.params, { amend: row.shareClassId })}>
                    {t("capTable.amend")}
                  </Link>
                </Button>
              ) : null,
          },
        ]}
      />
      {amending && context.canManage && (
        <ClassActionDrawer
          shareClass={amending}
          context={context}
          closeHref={withParams(BASE, context.params, { amend: undefined })}
          commonClasses={view.classRows
            .filter((row) => row.kind === "common" && row.shareClassId !== amending.shareClassId)
            .map((row) => ({ value: row.shareClassId, label: `${row.code} · ${row.name}` }))}
        />
      )}
    </div>
  );
}

/**
 * Approver actions on a class: amend the authorized shares, the conversion
 * price or the conversion class, or record a split. A split of a common
 * class reports the preferred conversion prices it adjusted.
 */
function ClassActionDrawer({
  shareClass,
  context,
  closeHref,
  commonClasses,
}: {
  shareClass: ClassRow;
  context: EquityContext;
  closeHref: string;
  commonClasses: { value: string; label: string }[];
}) {
  const t = useTranslations("equity");
  const router = useRouter();
  const shares = useShares();
  const price = usePrice();
  const [mode, setModeState] = useState<ClassActionMode>("authorized_shares");
  const { busy, refusal, execute, clearRefusal } = useAppAction();
  // A refusal answers the action it was given for; another action starts clean.
  const setMode = (next: ClassActionMode) => {
    setModeState(next);
    clearRefusal();
  };
  const [form, setForm] = useState({
    effectiveOn: context.asOf,
    value: "",
    numerator: "",
    denominator: "",
    reason: "",
    conversionShareClassId: "",
  });
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const done = (pending: boolean) => {
    toast.success(pending ? t("approval.submitted") : t("classActions.saved"));
    router.push(closeHref as never);
    router.refresh();
  };
  async function submit() {
    const failed = t("classActions.failed");
    if (mode === "split") {
      await execute(
        () =>
          postCommand<{
            status: string;
            adjustedClasses?: { code: string; conversionPriceAfter: string | null }[];
          }>(
            `/api/equity/classes/${shareClass.shareClassId}/splits`,
            {
              effectiveOn: form.effectiveOn,
              ratioNumerator: form.numerator,
              ratioDenominator: form.denominator,
              reason: form.reason,
            },
            failed,
          ),
        {
          fallbackMessage: failed,
          onOk: (split) => {
            if (split.adjustedClasses && split.adjustedClasses.length > 0) {
              toast.success(
                t("classActions.splitAdjusted", {
                  classes: split.adjustedClasses
                    .map(
                      (row) => `${row.code} → ${price(row.conversionPriceAfter, context.currency)}`,
                    )
                    .join(", "),
                }),
              );
            }
            done(isPendingApproval(split));
          },
        },
      );
      return;
    }
    await execute(
      () =>
        postCommand(
          `/api/equity/classes/${shareClass.shareClassId}/amendments`,
          {
            kind: mode,
            effectiveOn: form.effectiveOn,
            reason: form.reason,
            ...(mode === "authorized_shares"
              ? { authorizedShares: form.value }
              : mode === "conversion_price"
                ? { conversionPrice: form.value }
                : { conversionShareClassId: form.conversionShareClassId }),
          },
          failed,
        ),
      { fallbackMessage: failed, onOk: (result) => done(isPendingApproval(result)) },
    );
  }
  const modes = [
    { key: "authorized_shares" as const, label: t("classActions.authorized") },
    ...(shareClass.kind === "preferred"
      ? [
          { key: "conversion_price" as const, label: t("classActions.conversionPrice") },
          { key: "conversion_class" as const, label: t("classActions.conversionClass") },
        ]
      : []),
    { key: "split" as const, label: t("classActions.split") },
  ];
  const ready =
    form.effectiveOn &&
    form.reason.trim().length >= 5 &&
    (mode === "split"
      ? form.numerator && form.denominator
      : mode === "conversion_class"
        ? form.conversionShareClassId
        : form.value);
  return (
    <UrlDrawer
      open
      openKey={shareClass.shareClassId}
      closeHref={closeHref}
      title={t("classActions.title", { code: shareClass.code })}
      description={t("classActions.description")}
      footer={
        <div className="flex justify-end gap-2">
          <Button asChild variant="ghost">
            <Link href={closeHref}>{t("actions.cancel")}</Link>
          </Button>
          <Button onClick={submit} disabled={busy || !ready}>
            {t("actions.save")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-4">
        <SegmentTabs
          value={mode}
          onChange={setMode}
          tabs={modes}
          label={t("classActions.title", { code: shareClass.code })}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("fields.effectiveOn")}>
            <DateField value={form.effectiveOn} onChange={(value) => set("effectiveOn")(value)} />
          </Field>
          {mode === "authorized_shares" && (
            <Field
              label={t("fields.authorizedShares")}
              hint={t("classActions.currentAuthorized", {
                value: shares(shareClass.authorized),
                valueCount: Number(shareClass.authorized),
              })}
            >
              <Input
                inputMode="numeric"
                value={form.value}
                onChange={(e) => set("value")(e.target.value)}
              />
            </Field>
          )}
          {mode === "conversion_price" && (
            <Field
              label={t("fields.conversionPrice")}
              hint={t("classActions.currentConversionPrice", {
                value: price(shareClass.conversionPrice, context.currency),
              })}
            >
              <Input
                inputMode="decimal"
                value={form.value}
                onChange={(e) => set("value")(e.target.value)}
              />
            </Field>
          )}
          {mode === "conversion_class" && (
            <Field label={t("fields.conversionClass")} hint={t("classActions.conversionClassHelp")}>
              <SearchSelect
                value={form.conversionShareClassId}
                options={commonClasses}
                onChange={(value) => set("conversionShareClassId")(value ?? "")}
                ariaLabel={t("fields.conversionClass")}
              />
            </Field>
          )}
          {mode === "split" && (
            <>
              <Field label={t("fields.splitNew")}>
                <Input
                  inputMode="numeric"
                  value={form.numerator}
                  onChange={(e) => set("numerator")(e.target.value)}
                  placeholder="2"
                />
              </Field>
              <Field label={t("fields.splitOld")}>
                <Input
                  inputMode="numeric"
                  value={form.denominator}
                  onChange={(e) => set("denominator")(e.target.value)}
                  placeholder="1"
                />
              </Field>
            </>
          )}
        </div>
        {mode === "split" && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("classActions.splitHelp")}
          </p>
        )}
        <Field label={t("fields.reason")}>
          <Textarea rows={3} value={form.reason} onChange={(e) => set("reason")(e.target.value)} />
        </Field>
        <CommandRefusal refusal={refusal} fallback={t("classActions.failed")} />
      </div>
    </UrlDrawer>
  );
}

/** Plans and their pools as of the date; approvers change a plan's reserve in its drawer (`?reserve=<id>`). */
export function EquityPlansPanel({ view }: { view: StructureViewData | null }) {
  const t = useTranslations("equity");
  const shares = useShares();
  const date = useCivilDate();
  const search = useSearchParams();
  if (!view) return null;
  const { context } = view;
  const classCodes = new Map(view.structure.classes.map((row) => [row.id, row.code]));
  const reserveId = search?.get("reserve") ?? null;
  const reservePlan = reserveId
    ? (view.structure.plans.find((row) => row.id === reserveId) ?? null)
    : null;
  return (
    <div className="space-y-3">
      <PendingActions context={context} filter={(request) => request.action === "reserve_change"} />
      <PagedTable
        prepared
        searchable
        source="equity_plans"
        rows={view.structure.plans}
        rowKey={(row) => row.id}
        empty={t("plans.empty")}
        emptyFiltered={t("plans.emptyFiltered")}
        urlState={{
          pageKey: "page",
          page: context.list.page,
          searchKey: "q",
          query: context.list.query,
        }}
        {...listSort(context)}
        toolbarAfter={<EquityAsOfControl control={view.asOfControl} />}
        columns={[
          {
            key: "code",
            header: <>{t("plans.columns.plan")}</>,
            headerClassName: HEAD,
            className: CELL,
            cell: (row) => (
              <span>
                <span className="font-mono font-medium">{row.code}</span>{" "}
                <span className="text-slate-500">{row.name}</span>
              </span>
            ),
            search: (row) => `${row.code} ${row.name}`,
            sortKey: "plan",
            sortValue: (row) => row.code,
          },
          {
            key: "class",
            header: <>{t("plans.columns.class")}</>,
            headerClassName: HEAD,
            className: `${CELL} font-mono`,
            cell: (row) => <>{classCodes.get(row.shareClassId) ?? "—"}</>,
            search: (row) => classCodes.get(row.shareClassId) ?? "",
            sortKey: "class",
            sortValue: (row) => classCodes.get(row.shareClassId) ?? null,
          },
          {
            key: "effective",
            header: <>{t("plans.columns.effective")}</>,
            headerClassName: HEAD,
            className: DATE_CELL,
            cell: (row) => <>{date(row.effectiveOn)}</>,
            sortKey: "effective",
            sortValue: (row) => row.effectiveOn,
          },
          {
            key: "reserved",
            header: <>{t("plans.columns.reserved")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <>{shares(row.reserved)}</>,
            sortKey: "reserved",
            sortType: "decimal",
            sortValue: (row) => row.reserved,
          },
          {
            key: "used",
            header: <>{t("plans.columns.used")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <>{shares(row.used)}</>,
            sortKey: "used",
            sortType: "decimal",
            sortValue: (row) => row.used,
          },
          {
            key: "returned",
            header: <>{t("plans.columns.returned")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <>{shares(row.returned)}</>,
            sortKey: "returned",
            sortType: "decimal",
            sortValue: (row) => row.returned,
          },
          {
            key: "available",
            header: <>{t("plans.columns.available")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <strong>{shares(row.available)}</strong>,
            sortKey: "available",
            sortType: "decimal",
            sortValue: (row) => row.available,
          },
          {
            key: "recycling",
            header: <>{t("plans.columns.recycling")}</>,
            headerClassName: HEAD,
            className: `${CELL} text-xs`,
            cell: (row) => (
              <>
                {[
                  row.recycleForfeited && t("plans.recycle.forfeited"),
                  row.recycleExpired && t("plans.recycle.expired"),
                  row.recycleRepurchased && t("plans.recycle.repurchased"),
                ]
                  .filter(Boolean)
                  .join(" · ") || t("plans.recycle.none")}
              </>
            ),
          },
          {
            key: "actions",
            header: <span className="sr-only">{t("capTable.columns.actions")}</span>,
            headerClassName: HEAD,
            className: `${CELL} text-right`,
            cell: (row) =>
              context.canManage ? (
                <Button asChild size="sm" variant="ghost">
                  <Link href={withParams(BASE, context.params, { reserve: row.id })}>
                    {t("plans.changeReserve")}
                  </Link>
                </Button>
              ) : null,
          },
        ]}
      />
      {reservePlan && context.canManage && (
        <ReserveDrawer
          plan={reservePlan}
          context={context}
          closeHref={withParams(BASE, context.params, { reserve: undefined })}
        />
      )}
    </div>
  );
}

function ReserveDrawer({
  plan,
  context,
  closeHref,
}: {
  plan: { id: string; code: string };
  context: EquityContext;
  closeHref: string;
}) {
  const t = useTranslations("equity");
  const router = useRouter();
  const { busy, refusal, execute } = useAppAction();
  const [form, setForm] = useState({ effectiveOn: context.asOf, shareDelta: "", reason: "" });
  async function submit() {
    await execute(
      () =>
        postCommand(`/api/equity/plans/${plan.id}/reserve-changes`, form, t("plans.reserveFailed")),
      {
        fallbackMessage: t("plans.reserveFailed"),
        onOk: (result) => {
          toastGoverned(result, t("plans.reserveSaved"), t("approval.submitted"));
          router.push(closeHref as never);
          router.refresh();
        },
      },
    );
  }
  return (
    <UrlDrawer
      open
      openKey={plan.id}
      closeHref={closeHref}
      title={t("plans.reserveTitle", { code: plan.code })}
      description={t("plans.reserveDescription")}
      footer={
        <div className="flex justify-end gap-2">
          <Button asChild variant="ghost">
            <Link href={closeHref}>{t("actions.cancel")}</Link>
          </Button>
          <Button
            onClick={submit}
            disabled={busy || !form.shareDelta || form.reason.trim().length < 5}
          >
            {t("actions.save")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("fields.effectiveOn")}>
            <DateField
              value={form.effectiveOn}
              onChange={(value) => setForm({ ...form, effectiveOn: value })}
            />
          </Field>
          <Field label={t("fields.shareDelta")} hint={t("plans.deltaHelp")}>
            <Input
              inputMode="numeric"
              value={form.shareDelta}
              onChange={(e) => setForm({ ...form, shareDelta: e.target.value })}
            />
          </Field>
        </div>
        <Field label={t("fields.reason")}>
          <Textarea
            rows={3}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          />
        </Field>
        <CommandRefusal refusal={refusal} fallback={t("plans.reserveFailed")} />
      </div>
    </UrlDrawer>
  );
}

/** Holders on the cap table with their directory details and ownership; each opens their securities. */
export function EquityStakeholdersPanel({ view }: { view: StakeholdersViewData | null }) {
  const t = useTranslations("equity");
  const shares = useShares();
  const percentText = usePercent();
  if (!view) return null;
  return (
    <PagedTable
      prepared
      searchable
      source="equity_stakeholders"
      rows={view.table.holders}
      rowKey={(row) => row.holderPartyId}
      empty={t("stakeholders.empty")}
      emptyFiltered={t("stakeholders.emptyFiltered")}
      urlState={{
        pageKey: "page",
        page: view.context.list.page,
        searchKey: "q",
        query: view.context.list.query,
      }}
      {...listSort(view.context)}
      toolbarAfter={<EquityAsOfControl control={view.asOfControl} />}
      columns={[
        {
          key: "name",
          header: <>{t("stakeholders.columns.name")}</>,
          headerClassName: HEAD,
          className: CELL,
          cell: (row) => (
            <Link
              className={LINK}
              href={withParams(BASE, view.context.params, {
                view: "securities",
                holder: row.holderPartyId,
              })}
            >
              {view.parties[row.holderPartyId]?.name ?? row.holderPartyId}
            </Link>
          ),
          search: (row) =>
            `${view.parties[row.holderPartyId]?.name ?? ""} ${view.parties[row.holderPartyId]?.email ?? ""}`,
          sortKey: "name",
          sortValue: (row) => view.parties[row.holderPartyId]?.name ?? null,
        },
        {
          key: "kind",
          header: <>{t("stakeholders.columns.kind")}</>,
          headerClassName: HEAD,
          className: CELL,
          cell: (row) => (
            <>
              {view.parties[row.holderPartyId]?.kind
                ? t(`partyKind.${view.parties[row.holderPartyId]!.kind}`)
                : "—"}
            </>
          ),
        },
        {
          key: "email",
          header: <>{t("stakeholders.columns.email")}</>,
          headerClassName: HEAD,
          className: CELL,
          cell: (row) => <>{view.parties[row.holderPartyId]?.email ?? "—"}</>,
        },
        {
          key: "shares",
          header: <>{t("stakeholders.columns.shares")}</>,
          headerClassName: NUM_HEAD,
          className: NUM_CELL,
          cell: (row) => <>{shares(row.asConvertedOutstanding)}</>,
          sortKey: "shares",
          sortType: "decimal",
          sortValue: (row) => row.asConvertedOutstanding,
        },
        {
          key: "vested",
          header: <>{t("stakeholders.columns.vestedAwards")}</>,
          headerClassName: NUM_HEAD,
          className: NUM_CELL,
          cell: (row) => <>{shares(row.vestedAwards)}</>,
          sortKey: "vested",
          sortType: "decimal",
          sortValue: (row) => row.vestedAwards,
        },
        {
          key: "fullyDiluted",
          header: <>{t("stakeholders.columns.fullyDiluted")}</>,
          headerClassName: NUM_HEAD,
          className: NUM_CELL,
          cell: (row) => <>{shares(row.fullyDiluted)}</>,
          sortKey: "fullyDiluted",
          sortType: "decimal",
          sortValue: (row) => row.fullyDiluted,
        },
        {
          key: "percent",
          header: <>{t("stakeholders.columns.percent")}</>,
          headerClassName: NUM_HEAD,
          className: NUM_CELL,
          cell: (row) => <>{percentText(row.fullyDilutedPercent)}</>,
          sortKey: "percent",
          sortType: "decimal",
          sortValue: (row) => row.fullyDilutedPercent,
        },
      ]}
    />
  );
}
