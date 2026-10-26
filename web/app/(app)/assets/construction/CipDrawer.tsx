"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Badge, Button, Input, Label, Select, Textarea, UrlDrawer } from "@openbooks/ui";
import { DrawerTabStrip } from "@/components/drawer-tab-strip";
import { JournalEntryLink } from "@/components/journal-entry-link";
import { PagedTable } from "@/components/paged-table";
import { useMoney } from "@/components/money-provider";
import { useAppAction } from "@/lib/use-app-action";
import { useDirtyClose } from "@/lib/use-dirty-close";
import { mergeHref } from "@/lib/list-params";
import { newRequestKey, postJson, sumCents, toCents } from "../depth-client";
import type { CipDetail, ConstructionData } from "./_data";
import { DateField } from "@/components/date-field";

type Tab = "costs" | "link" | "capitalize" | "history";
type Line =
  | { kind: "asset"; name: string; categoryId: string; amount: string; placeInService: boolean }
  | {
      kind: "component";
      parentAssetId: string;
      name: string;
      categoryId: string;
      amount: string;
      placeInService: boolean;
    }
  | { kind: "expense"; expenseAccountId: string; amount: string; memo: string };

export function CipDrawer({
  record,
  data,
  closeHref,
  createMode = false,
}: {
  record: CipDetail | null;
  data: ConstructionData;
  closeHref: string;
  createMode?: boolean;
}) {
  if (createMode) return <CipCreateDrawer data={data} closeHref={closeHref} />;
  return record ? <CipRecordDrawer record={record} data={data} closeHref={closeHref} /> : null;
}

function CipCreateDrawer({ data, closeHref }: { data: ConstructionData; closeHref: string }) {
  const t = useTranslations("assets");
  const tc = useTranslations("common");
  const router = useRouter();
  const action = useAppAction();
  const [form, setForm] = useState(() => ({
    name: "",
    subsidiaryId: data.subsidiaries[0]?.id ?? "",
    categoryId: data.categories[0]?.id ?? "",
    cipAccountId: "",
    startedOn: data.today,
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
  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function create() {
    await action.execute(
      () =>
        postJson<{ id: string }>("/api/assets/construction", form, t("construction.createFailed")),
      {
        fallbackMessage: t("construction.createFailed"),
        successMessage: t("construction.created"),
        onOk: (created) => {
          router.push(
            mergeHref("/assets/construction", data.currentParams, {
              tab: "records",
              cip: created.id,
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
      size="lg"
      title={t("construction.new")}
      headerActions={
        <Button
          disabled={
            action.busy ||
            !form.name.trim() ||
            !form.subsidiaryId ||
            !form.categoryId ||
            !form.cipAccountId
          }
          onClick={() => void create()}
        >
          {t("construction.create")}
        </Button>
      }
    >
      <div className="space-y-4 p-1">
        <ActionAlert error={action.refusal} fallbackMessage={t("construction.createFailed")} />
        <div className="space-y-1.5">
          <Label htmlFor="cip-name">{t("construction.fields.name")}</Label>
          <Input
            id="cip-name"
            value={form.name}
            onChange={(event) => set("name", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cip-subsidiary">{t("construction.fields.legalEntity")}</Label>
          <Select
            id="cip-subsidiary"
            value={form.subsidiaryId}
            onChange={(event) => set("subsidiaryId", event.target.value)}
          >
            {data.subsidiaries.map((subsidiary) => (
              <option key={subsidiary.id} value={subsidiary.id}>
                {subsidiary.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cip-account">{t("construction.fields.cipAccount")}</Label>
          <Select
            id="cip-account"
            value={form.cipAccountId}
            onChange={(event) => set("cipAccountId", event.target.value)}
          >
            <option value="">{t("construction.fields.choose")}</option>
            {data.cipAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cip-category">{t("construction.fields.expectedCategory")}</Label>
          <Select
            id="cip-category"
            value={form.categoryId}
            onChange={(event) => set("categoryId", event.target.value)}
          >
            {data.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cip-started">{t("construction.fields.startedOn")}</Label>
          <DateField
            id="cip-started"
            value={form.startedOn}
            onChange={(value) => set("startedOn", value)}
          />
        </div>
      </div>
    </UrlDrawer>
  );
}

/**
 * One construction-in-progress record: its linked GL costs, the posted lines
 * still waiting to be linked, the capitalization form and the history of
 * capitalizations with their reversal.
 */
function CipRecordDrawer({
  record,
  data,
  closeHref,
}: {
  record: CipDetail;
  data: ConstructionData;
  closeHref: string;
}) {
  const t = useTranslations("assets");
  const { money } = useMoney();
  const router = useRouter();
  const action = useAppAction();
  const open = record.status === "construction";
  const manage = data.canCapitalize;
  const tabs: Tab[] = [
    "costs",
    ...(open && manage ? (["link", "capitalize"] as const) : []),
    "history",
  ];
  const [tab, setTab] = useState<Tab>("costs");
  const [picked, setPicked] = useState<string[]>([]);
  const [unlinkReason, setUnlinkReason] = useState("");
  const [capitalizedOn, setCapitalizedOn] = useState(data.today);
  const [reason, setReason] = useState("");
  const [closeWhenEmpty, setCloseWhenEmpty] = useState(true);
  const [lines, setLines] = useState<Line[]>([
    {
      kind: "asset",
      name: record.name,
      categoryId: data.categories[0]?.id ?? "",
      amount: record.open.replace(/(\.\d\d)00$/, "$1"),
      placeInService: false,
    },
  ]);
  const [reverseDate, setReverseDate] = useState(data.today);
  const [reverseReason, setReverseReason] = useState("");
  const total = sumCents(lines.map((line) => line.amount));
  const withinBalance =
    total !== null && toCents(total)! > 0n && toCents(total)! <= (toCents(record.open) ?? 0n);
  const done = () => router.refresh();

  const run = (url: string, body: unknown, success: string, after?: () => void) =>
    action.execute(() => postJson(url, body, t("construction.actionFailed")), {
      fallbackMessage: t("construction.actionFailed"),
      successMessage: success,
      onOk: () => {
        after?.();
        done();
      },
    });

  const update = (index: number, patch: Partial<Line>) =>
    setLines((current) =>
      current.map((line, position) =>
        position === index ? ({ ...line, ...patch } as Line) : line,
      ),
    );

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
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500 dark:text-slate-400">
            {record.assetNumber}
          </span>
          <span>{record.name}</span>
          <Badge variant={open ? "warning" : "success"}>{t(`status.${record.status}`)}</Badge>
        </span>
      }
      description={`${record.subsidiaryName} · ${record.accountLabel}`}
      subtabs={
        <DrawerTabStrip
          ariaLabel={t("construction.tabsAria")}
          activeKey={tab}
          onSelect={setTab}
          tabs={tabs.map((key) => ({ key, label: t(`construction.drawerTabs.${key}`) }))}
        />
      }
      footer={
        <div className="flex w-full justify-end gap-4 text-sm tabular-nums text-slate-600 dark:text-slate-300">
          <span>
            {t("construction.columns.linked")} {money(record.linked)}
          </span>
          <span>
            {t("construction.columns.capitalized")} {money(record.capitalized)}
          </span>
          <span>
            {t("construction.columns.expensed")} {money(record.expensed)}
          </span>
          <strong className="text-slate-900 dark:text-slate-100">
            {t("construction.columns.open")} {money(record.open)}
          </strong>
        </div>
      }
    >
      <div className="space-y-4 p-1">
        <ActionAlert error={action.refusal} fallbackMessage={t("construction.actionFailed")} />
        {tab === "costs" ? (
          <div className="space-y-3">
            <PagedTable
              rows={record.costs}
              source="asset_cip_costs"
              rowKey={(row) => row.id}
              columns={[
                {
                  key: "date",
                  header: t("construction.columns.date"),
                  cell: (row) => row.postingDate,
                },
                {
                  key: "entry",
                  header: t("construction.columns.entry"),
                  cell: (row) => (
                    <JournalEntryLink
                      entryId={row.entryId}
                      className="font-mono text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {row.entryNumber}
                    </JournalEntryLink>
                  ),
                },
                {
                  key: "memo",
                  header: t("construction.columns.memo"),
                  cell: (row) => row.memo ?? "—",
                },
                {
                  key: "amount",
                  header: t("construction.columns.amount"),
                  align: "right",
                  cell: (row) => <span className="tabular-nums">{money(row.amount)}</span>,
                },
                {
                  key: "status",
                  header: t("construction.columns.status"),
                  cell: (row) =>
                    row.status === "linked" ? (
                      <Badge variant="success">{t("construction.linked")}</Badge>
                    ) : (
                      <span title={row.unlinkReason ?? undefined}>
                        <Badge variant="secondary">{t("construction.unlinked")}</Badge>
                      </span>
                    ),
                },
                {
                  key: "actions",
                  header: "",
                  cell: (row) =>
                    manage && open && row.status === "linked" && !row.fromAcceptance ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={action.busy || !unlinkReason.trim()}
                        onClick={() =>
                          run(
                            `/api/assets/construction/${record.id}/costs`,
                            { action: "unlink", costId: row.id, reason: unlinkReason },
                            t("construction.unlinkedDone"),
                          )
                        }
                      >
                        {t("construction.unlink")}
                      </Button>
                    ) : null,
                },
              ]}
              empty={
                <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                  {t("construction.noCosts")}
                </p>
              }
              emptyAsRow
            />
            {manage &&
            open &&
            record.costs.some((row) => row.status === "linked" && !row.fromAcceptance)
              ? field(
                  "unlink-reason",
                  t("construction.fields.unlinkReason"),
                  <Input
                    id="unlink-reason"
                    value={unlinkReason}
                    onChange={(event) => setUnlinkReason(event.target.value)}
                  />,
                )
              : null}
          </div>
        ) : null}

        {tab === "link" ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t("construction.linkHelp")}
            </p>
            <PagedTable
              rows={record.candidates}
              source="asset_cip_candidates"
              rowKey={(row) => row.journalLineId}
              searchable
              selection={{
                getId: (row) => row.journalLineId,
                selectedIds: picked,
                onToggle: (id) =>
                  setPicked((current) =>
                    current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
                  ),
                onToggleAll: (ids) =>
                  setPicked((current) =>
                    ids.every((id) => current.includes(id))
                      ? current.filter((id) => !ids.includes(id))
                      : [...new Set([...current, ...ids])],
                  ),
              }}
              columns={[
                {
                  key: "date",
                  header: t("construction.columns.date"),
                  cell: (row) => row.postingDate,
                  search: (row) => row.postingDate,
                },
                {
                  key: "entry",
                  header: t("construction.columns.entry"),
                  cell: (row) => (
                    <span className="font-mono text-[13px]">
                      {row.documentNumber ?? row.entryNumber}
                    </span>
                  ),
                  search: (row) => `${row.documentNumber ?? ""} ${row.entryNumber}`,
                },
                {
                  key: "memo",
                  header: t("construction.columns.memo"),
                  cell: (row) => row.memo ?? "—",
                  search: (row) => row.memo ?? "",
                },
                {
                  key: "amount",
                  header: t("construction.columns.amount"),
                  align: "right",
                  cell: (row) => <span className="tabular-nums">{money(row.amount)}</span>,
                },
              ]}
              empty={
                <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                  {t("construction.noCandidates")}
                </p>
              }
              emptyAsRow
            />
            <Button
              disabled={action.busy || picked.length === 0}
              onClick={() =>
                run(
                  `/api/assets/construction/${record.id}/costs`,
                  { action: "link", journalLineIds: picked },
                  t("construction.linkedDone"),
                  () => setPicked([]),
                )
              }
            >
              {t("construction.link", { count: picked.length })}
            </Button>
          </div>
        ) : null}

        {tab === "capitalize" ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t("construction.capitalizeHelp")}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {field(
                "cap-date",
                t("construction.fields.capitalizedOn"),
                <DateField
                  id="cap-date"
                  value={capitalizedOn}
                  onChange={(value) => setCapitalizedOn(value)}
                />,
              )}
              <label className="flex items-center gap-2 self-end text-sm">
                <input
                  type="checkbox"
                  checked={closeWhenEmpty}
                  onChange={(event) => setCloseWhenEmpty(event.target.checked)}
                />
                {t("construction.fields.closeWhenEmpty")}
              </label>
            </div>
            {lines.map((line, index) => (
              <div
                key={index}
                className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
              >
                <div className="flex items-center justify-between gap-2">
                  <Select
                    aria-label={t("construction.fields.lineKind")}
                    value={line.kind}
                    onChange={(event) => {
                      const kind = event.target.value as Line["kind"];
                      setLines((current) =>
                        current.map((item, position) => {
                          if (position !== index) return item;
                          if (kind === "expense")
                            return {
                              kind,
                              expenseAccountId: data.expenseAccounts[0]?.id ?? "",
                              amount: item.amount,
                              memo: "",
                            };
                          const base = {
                            name: "name" in item ? item.name : record.name,
                            categoryId:
                              "categoryId" in item
                                ? item.categoryId
                                : (data.categories[0]?.id ?? ""),
                            amount: item.amount,
                            placeInService: false,
                          };
                          return kind === "component"
                            ? {
                                kind,
                                parentAssetId:
                                  data.parents.find(
                                    (parent) => parent.subsidiaryId === record.subsidiaryId,
                                  )?.id ?? "",
                                ...base,
                              }
                            : { kind, ...base };
                        }),
                      );
                    }}
                  >
                    <option value="asset">{t("construction.kinds.asset")}</option>
                    {data.componentsEnabled ? (
                      <option value="component">{t("construction.kinds.component")}</option>
                    ) : null}
                    <option value="expense">{t("construction.kinds.expense")}</option>
                  </Select>
                  {lines.length > 1 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setLines((current) => current.filter((_, position) => position !== index))
                      }
                    >
                      {t("construction.removeLine")}
                    </Button>
                  ) : null}
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_9rem]">
                  {line.kind === "expense" ? (
                    <>
                      <Select
                        aria-label={t("construction.fields.expenseAccount")}
                        value={line.expenseAccountId}
                        onChange={(event) =>
                          update(index, { expenseAccountId: event.target.value })
                        }
                      >
                        {data.expenseAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.label}
                          </option>
                        ))}
                      </Select>
                      <Input
                        aria-label={t("construction.fields.memo")}
                        placeholder={t("construction.fields.memo")}
                        value={line.memo}
                        onChange={(event) => update(index, { memo: event.target.value })}
                      />
                    </>
                  ) : (
                    <>
                      <Input
                        aria-label={t("construction.fields.assetName")}
                        placeholder={t("construction.fields.assetName")}
                        value={line.name}
                        onChange={(event) => update(index, { name: event.target.value })}
                      />
                      <Select
                        aria-label={t("construction.fields.category")}
                        value={line.categoryId}
                        onChange={(event) => update(index, { categoryId: event.target.value })}
                      >
                        {data.categories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </Select>
                    </>
                  )}
                  <Input
                    aria-label={t("construction.columns.amount")}
                    inputMode="decimal"
                    className="text-right tabular-nums"
                    value={line.amount}
                    onChange={(event) => update(index, { amount: event.target.value })}
                  />
                </div>
                {line.kind === "component" ? (
                  <Select
                    aria-label={t("construction.fields.parent")}
                    value={line.parentAssetId}
                    onChange={(event) => update(index, { parentAssetId: event.target.value })}
                  >
                    <option value="">{t("construction.fields.choose")}</option>
                    {data.parents
                      .filter((parent) => parent.subsidiaryId === record.subsidiaryId)
                      .map((parent) => (
                        <option key={parent.id} value={parent.id}>
                          {parent.label}
                        </option>
                      ))}
                  </Select>
                ) : null}
                {line.kind !== "expense" ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={line.placeInService}
                      onChange={(event) => update(index, { placeInService: event.target.checked })}
                    />
                    {t("construction.fields.placeInService")}
                  </label>
                ) : null}
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setLines((current) => [
                  ...current,
                  {
                    kind: "asset",
                    name: record.name,
                    categoryId: data.categories[0]?.id ?? "",
                    amount: "",
                    placeInService: false,
                  },
                ])
              }
            >
              {t("construction.addLine")}
            </Button>
            <p
              className={
                withinBalance
                  ? "text-xs text-slate-500 dark:text-slate-400"
                  : "text-xs text-red-600 dark:text-red-400"
              }
            >
              {t("construction.capitalizeTotal", {
                total: total === null ? "—" : money(total),
                open: money(record.open),
              })}
            </p>
            {field(
              "cap-reason",
              t("construction.fields.reason"),
              <Textarea
                id="cap-reason"
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />,
            )}
            <Button
              disabled={
                action.busy ||
                !withinBalance ||
                !reason.trim() ||
                lines.some(
                  (line) =>
                    (line.kind === "component" && !line.parentAssetId) ||
                    (line.kind !== "expense" && !line.name.trim()),
                )
              }
              onClick={() =>
                run(
                  `/api/assets/construction/${record.id}/capitalize`,
                  {
                    idempotencyKey: newRequestKey(),
                    capitalizedOn,
                    reason,
                    closeWhenEmpty,
                    lines: lines.map((line) =>
                      line.kind === "expense"
                        ? {
                            kind: "expense",
                            expenseAccountId: line.expenseAccountId,
                            amount: line.amount,
                            memo: line.memo || null,
                          }
                        : { ...line },
                    ),
                  },
                  t("construction.capitalizedDone"),
                  () => setTab("history"),
                )
              }
            >
              {t("construction.capitalize")}
            </Button>
          </div>
        ) : null}

        {tab === "history" ? (
          <div className="space-y-3">
            {record.capitalizations.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t("construction.noCapitalizations")}
              </p>
            ) : null}
            {record.capitalizations.map((entry) => (
              <section
                key={entry.id}
                className="space-y-2 rounded-xl border border-slate-200 p-4 dark:border-slate-800"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-slate-900 dark:text-slate-100">
                    {entry.capitalizedOn}
                  </h3>
                  <Badge variant={entry.status === "posted" ? "success" : "secondary"}>
                    {t(`construction.capitalizationStatus.${entry.status}`)}
                  </Badge>
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-300">{entry.reason}</p>
                <ul className="space-y-1 text-sm">
                  {entry.lines.map((line, index) => (
                    <li key={index} className="flex justify-between gap-4">
                      <span>
                        {line.kind === "expense" ? (
                          t("construction.kinds.expense")
                        ) : line.assetId ? (
                          <Link
                            href={`/assets?asset=${line.assetId}`}
                            className="font-mono text-teal-700 hover:underline dark:text-teal-300"
                          >
                            {line.assetNumber}
                          </Link>
                        ) : (
                          <span className="font-mono text-slate-500">{line.assetNumber}</span>
                        )}
                      </span>
                      <span className="tabular-nums">{money(line.amount)}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-sm">
                  <JournalEntryLink
                    entryId={entry.entryId}
                    className="text-teal-700 hover:underline dark:text-teal-300"
                  >
                    {t("construction.capitalizationEntry")}
                  </JournalEntryLink>
                </p>
                {entry.status === "posted" && manage ? (
                  <div className="grid gap-3 border-t border-slate-200 pt-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end dark:border-slate-800">
                    {field(
                      `rev-date-${entry.id}`,
                      t("construction.fields.reversalDate"),
                      <DateField
                        id={`rev-date-${entry.id}`}
                        value={reverseDate}
                        onChange={(value) => setReverseDate(value)}
                      />,
                    )}
                    {field(
                      `rev-reason-${entry.id}`,
                      t("construction.fields.reason"),
                      <Input
                        id={`rev-reason-${entry.id}`}
                        value={reverseReason}
                        onChange={(event) => setReverseReason(event.target.value)}
                      />,
                    )}
                    <Button
                      variant="outline"
                      disabled={action.busy || !reverseReason.trim()}
                      onClick={() =>
                        run(
                          `/api/assets/construction/capitalizations/${entry.id}/reverse`,
                          { date: reverseDate, reason: reverseReason },
                          t("construction.reversedDone"),
                        )
                      }
                    >
                      {t("construction.reverse")}
                    </Button>
                  </div>
                ) : null}
              </section>
            ))}
          </div>
        ) : null}
      </div>
    </UrlDrawer>
  );
}
