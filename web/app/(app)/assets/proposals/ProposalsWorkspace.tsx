"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Badge, Button, Input, Label, Popover, Select } from "@openbooks/ui";
import { PagedTable, type PagedColumn } from "@/components/paged-table";
import { FilterChips } from "@/components/filter-bar";
import { useMoney } from "@/components/money-provider";
import { mergeHref } from "@/lib/list-params";
import { useAppAction } from "@/lib/use-app-action";
import { newRequestKey, postJson, sumCents } from "../depth-client";
import type { ProposalRow, ProposalsData } from "./_data";
import { ProposalDrawer } from "./ProposalDrawer";
import { DateField } from "@/components/date-field";
import { canMergeProposalScopes } from "@openbooks/engine/assets/asset-proposal-merge";

const STATUS_VARIANT: Record<string, "warning" | "success" | "secondary" | "outline"> = {
  pending: "warning",
  accepted: "success",
  rejected: "secondary",
  voided: "outline",
};

export function ProposalsWorkspace({
  data,
  currentParams,
}: {
  data: ProposalsData;
  currentParams: Record<string, string | string[] | undefined>;
}) {
  const t = useTranslations("assets");
  const { money } = useMoney();
  const router = useRouter();
  const action = useAppAction();
  const [selected, setSelected] = useState<string[]>([]);
  const [scanFrom, setScanFrom] = useState(`${data.today.slice(0, 4)}-01-01`);
  const [scanTo, setScanTo] = useState(data.today);
  const [scanOpen, setScanOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeName, setMergeName] = useState("");
  const [mergeCategory, setMergeCategory] = useState(data.categories[0]?.id ?? "");
  const [mergeDate, setMergeDate] = useState(data.today);

  const pendingSelected = useMemo(
    () => data.rows.filter((row) => selected.includes(row.id) && row.status === "pending"),
    [data.rows, selected],
  );
  const mergeCompatible = canMergeProposalScopes(pendingSelected);
  const mergeCurrency = pendingSelected[0]?.currency;
  const mergeTotal = mergeCompatible ? sumCents(pendingSelected.map((row) => row.amount)) : null;

  function updateSelection(next: string[]) {
    setSelected(next);
    setMergeOpen(false);
  }

  const open = (row: ProposalRow) =>
    router.push(mergeHref("/assets/proposals", currentParams, { proposal: row.id }));

  const columns: PagedColumn<ProposalRow>[] = [
    {
      key: "date",
      header: t("proposals.columns.date"),
      cell: (row) => row.postingDate,
      search: (row) => row.postingDate,
    },
    {
      key: "source",
      header: t("proposals.columns.source"),
      cell: (row) => <span className="font-mono text-[13px]">{row.sourceLabel}</span>,
      search: (row) => row.sourceLabel,
    },
    {
      key: "description",
      header: t("proposals.columns.description"),
      cell: (row) => row.description ?? "—",
      search: (row) => row.description ?? "",
    },
    {
      key: "vendor",
      header: t("proposals.columns.vendor"),
      cell: (row) => row.vendorName ?? "—",
      search: (row) => row.vendorName ?? "",
    },
    {
      key: "account",
      header: t("proposals.columns.account"),
      cell: (row) => row.accountLabel,
      search: (row) => row.accountLabel,
    },
    {
      key: "rule",
      header: t("proposals.columns.rule"),
      cell: (row) => row.ruleName ?? t("proposals.manual"),
    },
    {
      key: "amount",
      header: t("proposals.columns.amount"),
      align: "right",
      cell: (row) => (
        <span className="tabular-nums">{money(row.amount, { currency: row.currency })}</span>
      ),
    },
    {
      key: "status",
      header: t("proposals.columns.status"),
      cell: (row) => (
        <Badge variant={STATUS_VARIANT[row.status] ?? "secondary"}>
          {t(`proposals.status.${row.status}`)}
        </Badge>
      ),
    },
  ];

  async function scan() {
    await action.execute(
      () =>
        postJson<{ entriesScanned: number; created: number }>(
          "/api/assets/proposals/scan",
          { action: "scan", from: scanFrom, to: scanTo },
          t("proposals.scanFailed"),
        ),
      {
        fallbackMessage: t("proposals.scanFailed"),
        successMessage: t("proposals.scanDone"),
        onOk: () => {
          setScanOpen(false);
          router.refresh();
        },
      },
    );
  }

  async function merge() {
    if (!mergeCompatible || !mergeTotal) return;
    await action.execute(
      () =>
        postJson(
          "/api/assets/proposals/accept",
          {
            idempotencyKey: newRequestKey(),
            operation: "merge",
            proposalIds: pendingSelected.map((row) => row.id),
            acceptedOn: mergeDate,
            targets: [{ name: mergeName, categoryId: mergeCategory, amount: mergeTotal }],
          },
          t("proposals.acceptFailed"),
        ),
      {
        fallbackMessage: t("proposals.acceptFailed"),
        successMessage: t("proposals.accepted"),
        onOk: () => {
          setMergeOpen(false);
          setSelected([]);
          router.refresh();
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      <ActionAlert error={action.refusal} fallbackMessage={t("proposals.acceptFailed")} />
      {!data.hasRules ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100">
          {t("proposals.noRules")}{" "}
          <Link href="/admin/setup/asset-capitalization-rules" className="font-medium underline">
            {t("proposals.openRules")}
          </Link>
        </div>
      ) : null}
      <PagedTable
        rows={data.rows}
        columns={columns}
        source="asset_proposals"
        searchable
        pageSize={25}
        rowKey={(row) => row.id}
        onRowClick={open}
        rowLabel={(row) => `${row.sourceLabel} ${row.description ?? ""}`}
        rowSelected={(row) => row.id === data.selected?.id}
        empty={
          <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            {t("proposals.empty")}
          </p>
        }
        emptyAsRow
        selection={
          data.canCapitalize
            ? {
                getId: (row) => row.id,
                selectedIds: selected,
                onToggle: (id) =>
                  updateSelection(
                    selected.includes(id)
                      ? selected.filter((item) => item !== id)
                      : [...selected, id],
                  ),
                onToggleAll: (ids) =>
                  updateSelection(
                    ids.every((id) => selected.includes(id))
                      ? selected.filter((id) => !ids.includes(id))
                      : [...new Set([...selected, ...ids])],
                  ),
              }
            : undefined
        }
        toolbarAfter={
          <div className="flex flex-wrap items-center gap-2">
            <FilterChips
              basePath="/assets/proposals"
              currentParams={currentParams}
              paramKey="status"
              label={t("proposals.columns.status")}
              defaultValue="pending"
              allLabel={t("proposals.status.all")}
              options={(["pending", "accepted", "rejected", "voided"] as const).map((value) => ({
                value,
                label: t(`proposals.status.${value}`),
              }))}
            />
            {data.canCapitalize && pendingSelected.length >= 2 ? (
              <Popover
                open={mergeOpen && mergeCompatible}
                onOpenChange={setMergeOpen}
                trigger={
                  <Button
                    size="sm"
                    disabled={!mergeCompatible}
                    onClick={() => setMergeOpen((value) => !value)}
                  >
                    {t("proposals.merge.action", { count: pendingSelected.length })}
                  </Button>
                }
              >
                <div className="w-80 space-y-3 p-3">
                  {mergeTotal && mergeCurrency ? (
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                      {t("proposals.merge.summary", {
                        count: pendingSelected.length,
                        total: money(mergeTotal, { currency: mergeCurrency }),
                      })}
                    </p>
                  ) : null}
                  <div className="space-y-1.5">
                    <Label htmlFor="merge-name">{t("proposals.fields.assetName")}</Label>
                    <Input
                      id="merge-name"
                      value={mergeName}
                      onChange={(event) => setMergeName(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="merge-category">{t("proposals.fields.category")}</Label>
                    <Select
                      id="merge-category"
                      value={mergeCategory}
                      onChange={(event) => setMergeCategory(event.target.value)}
                    >
                      {data.categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="merge-date">{t("proposals.fields.acceptedOn")}</Label>
                    <DateField
                      id="merge-date"
                      value={mergeDate}
                      onChange={(value) => setMergeDate(value)}
                    />
                  </div>
                  <Button
                    className="w-full"
                    disabled={
                      !mergeCompatible ||
                      action.busy ||
                      !mergeName.trim() ||
                      !mergeCategory ||
                      !mergeTotal
                    }
                    onClick={merge}
                  >
                    {t("proposals.merge.confirm")}
                  </Button>
                </div>
              </Popover>
            ) : null}
            {data.canCapitalize ? (
              <Popover
                open={scanOpen}
                onOpenChange={setScanOpen}
                trigger={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setScanOpen((value) => !value)}
                  >
                    {t("proposals.scan")}
                  </Button>
                }
              >
                <div className="w-72 space-y-3 p-3">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t("proposals.scanHelp")}
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="scan-from">{t("proposals.fields.from")}</Label>
                    <DateField
                      id="scan-from"
                      value={scanFrom}
                      onChange={(value) => setScanFrom(value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="scan-to">{t("proposals.fields.to")}</Label>
                    <DateField id="scan-to" value={scanTo} onChange={(value) => setScanTo(value)} />
                  </div>
                  <Button className="w-full" disabled={action.busy} onClick={scan}>
                    {t("proposals.scanRun")}
                  </Button>
                </div>
              </Popover>
            ) : null}
          </div>
        }
      />
      {data.selected ? (
        <ProposalDrawer
          key={data.selected.id}
          proposal={data.selected}
          data={data}
          closeHref={mergeHref("/assets/proposals", currentParams, { proposal: undefined })}
        />
      ) : null}
    </div>
  );
}
