"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@openbooks/ui";
import { PagedTable } from "@/components/paged-table";
import { useMoney } from "@/components/money-provider";
import { useBusinessToday } from "@/components/business-date-provider";
import { readApiErrorMessage } from "@/lib/api-error";
import { useAppAction } from "@/lib/use-app-action";
import { postJson } from "./depth-client";
import { DateField } from "@/components/date-field";

interface CompoundMember {
  id: string;
  assetNumber: string;
  name: string;
  status: string;
  categoryName: string | null;
  isParent: boolean;
  books: { bookId: string; cost: string; accumulated: string; carryingValue: string }[];
}

interface CompoundPayload {
  parent: { id: string; assetNumber: string; name: string; parentAssetId: string | null };
  members: CompoundMember[];
  rollup: {
    bookId: string;
    bookName: string;
    isPrimary: boolean;
    cost: string;
    accumulated: string;
    carryingValue: string;
    assets: number;
  }[];
  candidates: { id: string; label: string }[];
}

/**
 * The asset drawer's Components tab: the compound family (parent and its
 * components) with each member's primary-book values, the per-book roll-up,
 * and — for maintainers — attach, detach, new component and disposal of
 * the whole family.
 */
export function AssetComponentsPanel({
  assetId,
  canManage,
  categories,
  accountOptions,
}: {
  assetId: string;
  canManage: boolean;
  categories: { id: string; name: string }[];
  accountOptions: { value: string; label: string }[];
}) {
  const t = useTranslations("assets");
  const { money } = useMoney();
  const router = useRouter();
  const action = useAppAction();
  const today = useBusinessToday();
  const [payload, setPayload] = useState<CompoundPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attachId, setAttachId] = useState("");
  const [detachReason, setDetachReason] = useState("");
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState(categories[0]?.id ?? "");
  const [newCost, setNewCost] = useState("");
  const [disposeDate, setDisposeDate] = useState(today);
  const [writeOff, setWriteOff] = useState(true);
  const [proceeds, setProceeds] = useState("");
  const [proceedsAccountId, setProceedsAccountId] = useState("");
  const [disposeReason, setDisposeReason] = useState("");

  const [version, setVersion] = useState(0);
  const load = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    let live = true;
    void fetch(`/api/assets/${encodeURIComponent(assetId)}/components`).then(async (response) => {
      if (!response.ok) {
        const message = await readApiErrorMessage(response, t("components.loadFailed"));
        if (live) setLoadError(message);
        return;
      }
      const body = (await response.json()) as CompoundPayload;
      if (live) {
        setLoadError(null);
        setPayload(body);
      }
    });
    return () => {
      live = false;
    };
  }, [assetId, version, t]);

  const run = (
    body: unknown,
    success: string,
    url = `/api/assets/${payload?.parent.id ?? assetId}/components`,
  ) =>
    action.execute(() => postJson(url, body, t("components.actionFailed")), {
      fallbackMessage: t("components.actionFailed"),
      successMessage: success,
      onOk: () => {
        load();
        router.refresh();
      },
    });

  if (loadError) return <p className="p-1 text-sm text-red-600 dark:text-red-400">{loadError}</p>;
  if (!payload)
    return (
      <p className="p-1 text-sm text-slate-500 dark:text-slate-400">{t("components.loading")}</p>
    );
  const isParentView = payload.parent.id === assetId;
  const components = payload.members.filter((member) => !member.isParent);
  const primary = (member: CompoundMember) =>
    member.books.find(
      (book) => payload.rollup.find((entry) => entry.bookId === book.bookId)?.isPrimary,
    ) ?? member.books[0];
  const field = (id: string, label: string, control: ReactNode) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {control}
    </div>
  );

  return (
    <div className="space-y-5 p-1">
      <ActionAlert error={action.refusal} fallbackMessage={t("components.actionFailed")} />
      {!isParentView ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t("components.memberOf")}{" "}
          <Link
            href={`/assets?asset=${payload.parent.id}&assetTab=components`}
            className="font-mono text-teal-700 hover:underline dark:text-teal-300"
          >
            {payload.parent.assetNumber}
          </Link>{" "}
          {payload.parent.name}
        </p>
      ) : null}
      <PagedTable
        rows={payload.members}
        source="asset_components"
        rowKey={(row) => row.id}
        columns={[
          {
            key: "number",
            header: t("labels.number"),
            cell: (row) => (
              <Link
                href={`/assets?asset=${row.id}`}
                className="font-mono text-teal-700 hover:underline dark:text-teal-300"
              >
                {row.assetNumber}
              </Link>
            ),
          },
          {
            key: "name",
            header: t("components.columns.name"),
            cell: (row) => (
              <span>
                {row.name}
                {row.isParent ? (
                  <Badge variant="outline" className="ml-2">
                    {t("components.parent")}
                  </Badge>
                ) : null}
              </span>
            ),
          },
          { key: "category", header: t("labels.category"), cell: (row) => row.categoryName ?? "—" },
          {
            key: "status",
            header: t("components.columns.status"),
            cell: (row) => t(`status.${row.status}`),
          },
          {
            key: "cost",
            header: t("labels.cost"),
            align: "right",
            cell: (row) => <span className="tabular-nums">{money(primary(row)?.cost ?? "0")}</span>,
          },
          {
            key: "accumulated",
            header: t("labels.accumulated"),
            align: "right",
            cell: (row) => (
              <span className="tabular-nums">{money(primary(row)?.accumulated ?? "0")}</span>
            ),
          },
          {
            key: "nbv",
            header: t("labels.nbv"),
            align: "right",
            cell: (row) => (
              <span className="tabular-nums">{money(primary(row)?.carryingValue ?? "0")}</span>
            ),
          },
          {
            key: "actions",
            header: "",
            cell: (row) =>
              canManage && !row.isParent ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={action.busy || !detachReason.trim()}
                  onClick={() =>
                    run(
                      { action: "detach", componentAssetId: row.id, reason: detachReason },
                      t("components.detached"),
                    )
                  }
                >
                  {t("components.detach")}
                </Button>
              ) : null,
          },
        ]}
        empty={
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            {t("components.empty")}
          </p>
        }
        emptyAsRow
      />
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t("components.rollupTitle")}
        </h3>
        <Table
          containerClassName="overflow-visible rounded-none border-0 bg-transparent shadow-none"
          className="w-full text-sm"
        >
          <TableHeader>
            <TableRow noAnimate className="text-left text-slate-500 dark:text-slate-400">
              <TableHead className="py-1 font-medium">{t("run.book")}</TableHead>
              <TableHead className="py-1 text-right font-medium">{t("labels.cost")}</TableHead>
              <TableHead className="py-1 text-right font-medium">
                {t("labels.accumulated")}
              </TableHead>
              <TableHead className="py-1 text-right font-medium">{t("labels.nbv")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payload.rollup.map((book) => (
              <TableRow
                noAnimate
                key={book.bookId}
                className="border-t border-slate-100 dark:border-slate-800"
              >
                <TableCell className="py-1">
                  {book.bookName}
                  {book.isPrimary ? (
                    <Badge variant="outline" className="ml-2">
                      {t("components.primary")}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="py-1 text-right tabular-nums">{money(book.cost)}</TableCell>
                <TableCell className="py-1 text-right tabular-nums">
                  {money(book.accumulated)}
                </TableCell>
                <TableCell className="py-1 text-right font-semibold tabular-nums">
                  {money(book.carryingValue)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      {canManage ? (
        <>
          {components.length > 0
            ? field(
                "detach-reason",
                t("components.fields.detachReason"),
                <Input
                  id="detach-reason"
                  value={detachReason}
                  onChange={(event) => setDetachReason(event.target.value)}
                />,
              )
            : null}
          <section className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-[1fr_auto] sm:items-end dark:border-slate-800">
            {field(
              "attach-asset",
              t("components.fields.attach"),
              <Select
                id="attach-asset"
                value={attachId}
                onChange={(event) => setAttachId(event.target.value)}
              >
                <option value="">{t("components.fields.choose")}</option>
                {payload.candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ))}
              </Select>,
            )}
            <Button
              variant="outline"
              disabled={action.busy || !attachId}
              onClick={() =>
                run({ action: "attach", componentAssetId: attachId }, t("components.attached"))
              }
            >
              {t("components.attach")}
            </Button>
          </section>
          <section className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-[1fr_1fr_9rem_auto] sm:items-end dark:border-slate-800">
            {field(
              "new-component-name",
              t("components.fields.name"),
              <Input
                id="new-component-name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />,
            )}
            {field(
              "new-component-category",
              t("labels.category"),
              <Select
                id="new-component-category"
                value={newCategory}
                onChange={(event) => setNewCategory(event.target.value)}
              >
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>,
            )}
            {field(
              "new-component-cost",
              t("labels.cost"),
              <Input
                id="new-component-cost"
                inputMode="decimal"
                value={newCost}
                onChange={(event) => setNewCost(event.target.value)}
              />,
            )}
            <Button
              variant="outline"
              disabled={action.busy || !newName.trim() || !newCategory || !newCost.trim()}
              onClick={() =>
                run(
                  {
                    action: "create",
                    name: newName,
                    categoryId: newCategory,
                    acquisitionCost: newCost,
                  },
                  t("components.created"),
                )
              }
            >
              {t("components.create")}
            </Button>
          </section>
          {components.length > 0 ? (
            <section className="space-y-3 rounded-lg border border-red-200 p-3 dark:border-red-900/60">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {t("components.disposeTitle")}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("components.disposeHelp")}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {field(
                  "compound-date",
                  t("dispose.date"),
                  <DateField
                    id="compound-date"
                    value={disposeDate}
                    onChange={(value) => setDisposeDate(value)}
                  />,
                )}
                <label className="flex items-center gap-2 self-end text-sm">
                  <input
                    type="checkbox"
                    checked={writeOff}
                    onChange={(event) => setWriteOff(event.target.checked)}
                  />
                  {t("dispose.writeOff")}
                </label>
                {!writeOff
                  ? field(
                      "compound-proceeds",
                      t("dispose.proceeds"),
                      <Input
                        id="compound-proceeds"
                        inputMode="decimal"
                        value={proceeds}
                        onChange={(event) => setProceeds(event.target.value)}
                      />,
                    )
                  : null}
                {!writeOff
                  ? field(
                      "compound-account",
                      t("dispose.account"),
                      <Select
                        id="compound-account"
                        value={proceedsAccountId}
                        onChange={(event) => setProceedsAccountId(event.target.value)}
                      >
                        <option value="">{t("dispose.selectAccount")}</option>
                        {accountOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>,
                    )
                  : null}
              </div>
              {field(
                "compound-reason",
                t("components.fields.disposeReason"),
                <Input
                  id="compound-reason"
                  value={disposeReason}
                  onChange={(event) => setDisposeReason(event.target.value)}
                />,
              )}
              <Button
                variant="outline"
                disabled={
                  action.busy ||
                  !disposeReason.trim() ||
                  (!writeOff && (!proceeds.trim() || !proceedsAccountId))
                }
                onClick={() =>
                  run(
                    {
                      date: disposeDate,
                      writeOff,
                      proceeds: writeOff ? undefined : proceeds,
                      proceedsAccountId: writeOff ? undefined : proceedsAccountId,
                      reason: disposeReason,
                    },
                    t("components.disposed"),
                    `/api/assets/${payload.parent.id}/dispose-compound`,
                  )
                }
              >
                {t("components.dispose")}
              </Button>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
