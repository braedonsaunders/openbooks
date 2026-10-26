"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Badge, Button, Input, Label, Select, Textarea, UrlDrawer } from "@openbooks/ui";
import { DrawerTabStrip } from "@/components/drawer-tab-strip";
import { JournalEntryLink } from "@/components/journal-entry-link";
import { useMoney } from "@/components/money-provider";
import { useAppAction } from "@/lib/use-app-action";
import { evenSplit, newRequestKey, postJson, sumCents, toCents } from "../depth-client";
import type { ProposalRow, ProposalsData } from "./_data";
import { DateField } from "@/components/date-field";

type Mode = "asset" | "split" | "component" | "cip" | "reject";
type SplitLine = { name: string; amount: string };

/**
 * One proposal: its source line and, while pending, the decision —
 * capitalize as one asset, split it, add it as a component or to
 * construction in progress, or reject it with a reason. An accepted
 * proposal shows the assets it became and can be reversed; a rejected one
 * can return to the queue.
 */
export function ProposalDrawer({
  proposal,
  data,
  closeHref,
}: {
  proposal: ProposalRow;
  data: ProposalsData;
  closeHref: string;
}) {
  const t = useTranslations("assets");
  const { money } = useMoney(proposal.currency);
  const router = useRouter();
  const action = useAppAction();
  const pending = proposal.status === "pending" && data.canCapitalize;
  const modes: Mode[] = [
    "asset",
    "split",
    ...(data.componentsEnabled ? ["component" as const] : []),
    ...(data.cipEnabled ? ["cip" as const] : []),
    "reject",
  ];
  const [mode, setMode] = useState<Mode>("asset");
  const [acceptedOn, setAcceptedOn] = useState(
    proposal.postingDate > data.today ? proposal.postingDate : data.today,
  );
  const [name, setName] = useState(proposal.description ?? "");
  const [categoryId, setCategoryId] = useState(
    proposal.suggestedCategoryId ?? data.categories[0]?.id ?? "",
  );
  const [placeInService, setPlaceInService] = useState(false);
  const [inServiceOn, setInServiceOn] = useState(acceptedOn);
  const [parts, setParts] = useState(
    String(Math.max(2, Math.min(50, Number.parseInt(proposal.quantity ?? "2", 10) || 2))),
  );
  const [split, setSplit] = useState<SplitLine[]>(() =>
    (evenSplit(proposal.amount, 2) ?? ["", ""]).map((amount, index) => ({
      name: `${proposal.description ?? t("proposals.fields.asset")} ${index + 1}`,
      amount,
    })),
  );
  const [parentAssetId, setParentAssetId] = useState(
    data.parents.find((parent) => parent.subsidiaryId === proposal.subsidiaryId)?.id ?? "",
  );
  const [cipAssetId, setCipAssetId] = useState(
    data.cipRecords.find((record) => record.subsidiaryId === proposal.subsidiaryId)?.id ?? "",
  );
  const [reason, setReason] = useState("");
  const [reverseDate, setReverseDate] = useState(data.today);
  const [reverseReason, setReverseReason] = useState("");
  const splitTotal = sumCents(split.map((line) => line.amount));
  const splitBalanced = splitTotal !== null && toCents(splitTotal) === toCents(proposal.amount);

  const done = () => router.refresh();

  async function accept() {
    const target = {
      name,
      categoryId,
      amount: proposal.amount,
      ...(placeInService ? { placeInService: true, inServiceOn } : {}),
    };
    const body =
      mode === "asset"
        ? { operation: "asset", targets: [target] }
        : mode === "split"
          ? {
              operation: "split",
              targets: split.map((line) => ({ name: line.name, categoryId, amount: line.amount })),
            }
          : mode === "component"
            ? { operation: "component", parentAssetId, targets: [target] }
            : { operation: "cip", cipAssetId, targets: [] };
    await action.execute(
      () =>
        postJson(
          "/api/assets/proposals/accept",
          {
            idempotencyKey: newRequestKey(),
            proposalIds: [proposal.id],
            acceptedOn,
            reason: reason.trim() || null,
            ...body,
          },
          t("proposals.acceptFailed"),
        ),
      {
        fallbackMessage: t("proposals.acceptFailed"),
        successMessage: t("proposals.accepted"),
        onOk: done,
      },
    );
  }

  async function decide(kind: "reject" | "restore", text: string) {
    await action.execute(
      () =>
        postJson(
          `/api/assets/proposals/${proposal.id}`,
          { action: kind, reason: text },
          t("proposals.actionFailed"),
        ),
      {
        fallbackMessage: t("proposals.actionFailed"),
        successMessage: kind === "reject" ? t("proposals.rejected") : t("proposals.restored"),
        onOk: done,
      },
    );
  }

  async function reverse() {
    if (!proposal.acceptance) return;
    await action.execute(
      () =>
        postJson(
          `/api/assets/proposals/acceptances/${proposal.acceptance!.id}/reverse`,
          { date: reverseDate, reason: reverseReason },
          t("proposals.actionFailed"),
        ),
      {
        fallbackMessage: t("proposals.actionFailed"),
        successMessage: t("proposals.reversed"),
        onOk: done,
      },
    );
  }

  const field = (id: string, label: string, control: ReactNode) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {control}
    </div>
  );
  const categorySelect = (id: string) => (
    <Select id={id} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
      {data.categories.map((category) => (
        <option key={category.id} value={category.id}>
          {category.name}
        </option>
      ))}
    </Select>
  );

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500 dark:text-slate-400">
            {proposal.sourceLabel}
          </span>
          <span>{proposal.description ?? t("proposals.untitled")}</span>
          <Badge
            variant={
              proposal.status === "pending"
                ? "warning"
                : proposal.status === "accepted"
                  ? "success"
                  : "secondary"
            }
          >
            {t(`proposals.status.${proposal.status}`)}
          </Badge>
        </span>
      }
      description={t("proposals.drawerDescription", {
        amount: money(proposal.amount),
        date: proposal.postingDate,
      })}
      subtabs={
        pending ? (
          <DrawerTabStrip
            ariaLabel={t("proposals.modesAria")}
            activeKey={mode}
            onSelect={setMode}
            tabs={modes.map((key) => ({ key, label: t(`proposals.modes.${key}`) }))}
          />
        ) : undefined
      }
    >
      <div className="space-y-5 p-1">
        <ActionAlert error={action.refusal} fallbackMessage={t("proposals.actionFailed")} />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <dt className="text-slate-500 dark:text-slate-400">{t("proposals.columns.source")}</dt>
          <dd>
            <JournalEntryLink
              entryId={proposal.sourceEntryId}
              className="font-mono text-teal-700 hover:underline dark:text-teal-300"
            >
              {proposal.sourceLabel}
            </JournalEntryLink>
          </dd>
          <dt className="text-slate-500 dark:text-slate-400">{t("proposals.columns.account")}</dt>
          <dd>{proposal.accountLabel}</dd>
          <dt className="text-slate-500 dark:text-slate-400">{t("proposals.columns.vendor")}</dt>
          <dd>{proposal.vendorName ?? "—"}</dd>
          <dt className="text-slate-500 dark:text-slate-400">
            {t("proposals.fields.legalEntity")}
          </dt>
          <dd>{proposal.subsidiaryName}</dd>
          <dt className="text-slate-500 dark:text-slate-400">{t("proposals.columns.rule")}</dt>
          <dd>{proposal.ruleName ?? t("proposals.manual")}</dd>
          {proposal.quantity ? (
            <>
              <dt className="text-slate-500 dark:text-slate-400">
                {t("proposals.fields.quantity")}
              </dt>
              <dd className="tabular-nums">{proposal.quantity}</dd>
            </>
          ) : null}
          {proposal.resolutionReason ? (
            <>
              <dt className="text-slate-500 dark:text-slate-400">{t("proposals.fields.reason")}</dt>
              <dd>{proposal.resolutionReason}</dd>
            </>
          ) : null}
        </dl>

        {pending && mode !== "reject" ? (
          <section className="space-y-4 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t(`proposals.modeHelp.${mode}`)}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {field(
                "accept-date",
                t("proposals.fields.acceptedOn"),
                <DateField
                  id="accept-date"
                  value={acceptedOn}
                  onChange={(value) => setAcceptedOn(value)}
                />,
              )}
              {mode === "asset" || mode === "component"
                ? field(
                    "accept-name",
                    t("proposals.fields.assetName"),
                    <Input
                      id="accept-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />,
                  )
                : null}
              {mode !== "cip"
                ? field(
                    "accept-category",
                    t("proposals.fields.category"),
                    categorySelect("accept-category"),
                  )
                : null}
              {mode === "component"
                ? field(
                    "accept-parent",
                    t("proposals.fields.parent"),
                    <Select
                      id="accept-parent"
                      value={parentAssetId}
                      onChange={(event) => setParentAssetId(event.target.value)}
                    >
                      <option value="">{t("proposals.fields.choose")}</option>
                      {data.parents
                        .filter((parent) => parent.subsidiaryId === proposal.subsidiaryId)
                        .map((parent) => (
                          <option key={parent.id} value={parent.id}>
                            {parent.label}
                          </option>
                        ))}
                    </Select>,
                  )
                : null}
              {mode === "cip"
                ? field(
                    "accept-cip",
                    t("proposals.fields.cip"),
                    <Select
                      id="accept-cip"
                      value={cipAssetId}
                      onChange={(event) => setCipAssetId(event.target.value)}
                    >
                      <option value="">{t("proposals.fields.choose")}</option>
                      {data.cipRecords
                        .filter((record) => record.subsidiaryId === proposal.subsidiaryId)
                        .map((record) => (
                          <option key={record.id} value={record.id}>
                            {record.label}
                          </option>
                        ))}
                    </Select>,
                  )
                : null}
            </div>
            {mode === "split" ? (
              <div className="space-y-3">
                <div className="flex items-end gap-2">
                  {field(
                    "split-parts",
                    t("proposals.fields.parts"),
                    <Input
                      id="split-parts"
                      inputMode="numeric"
                      className="w-24"
                      value={parts}
                      onChange={(event) => setParts(event.target.value)}
                    />,
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const count = Number.parseInt(parts, 10);
                      const amounts = evenSplit(proposal.amount, count);
                      if (amounts)
                        setSplit(
                          amounts.map((amount, index) => ({
                            name:
                              split[index]?.name ??
                              `${proposal.description ?? t("proposals.fields.asset")} ${index + 1}`,
                            amount,
                          })),
                        );
                    }}
                  >
                    {t("proposals.splitEvenly")}
                  </Button>
                </div>
                {split.map((line, index) => (
                  <div key={index} className="grid grid-cols-[1fr_9rem] gap-2">
                    <Input
                      aria-label={t("proposals.fields.assetName")}
                      value={line.name}
                      onChange={(event) =>
                        setSplit((current) =>
                          current.map((item, position) =>
                            position === index ? { ...item, name: event.target.value } : item,
                          ),
                        )
                      }
                    />
                    <Input
                      aria-label={t("proposals.columns.amount")}
                      inputMode="decimal"
                      className="text-right tabular-nums"
                      value={line.amount}
                      onChange={(event) =>
                        setSplit((current) =>
                          current.map((item, position) =>
                            position === index ? { ...item, amount: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </div>
                ))}
                <p
                  className={
                    splitBalanced
                      ? "text-xs text-slate-500 dark:text-slate-400"
                      : "text-xs text-red-600 dark:text-red-400"
                  }
                >
                  {t("proposals.splitTotal", {
                    total: splitTotal === null ? "—" : money(splitTotal),
                    amount: money(proposal.amount),
                  })}
                </p>
              </div>
            ) : null}
            {mode === "asset" || mode === "component" ? (
              <div className="flex flex-wrap items-end gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={placeInService}
                    onChange={(event) => setPlaceInService(event.target.checked)}
                  />
                  {t("proposals.fields.placeInService")}
                </label>
                {placeInService
                  ? field(
                      "accept-in-service",
                      t("proposals.fields.inServiceOn"),
                      <DateField
                        id="accept-in-service"
                        value={inServiceOn}
                        onChange={(value) => setInServiceOn(value)}
                      />,
                    )
                  : null}
              </div>
            ) : null}
            {field(
              "accept-reason",
              t("proposals.fields.note"),
              <Textarea
                id="accept-reason"
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />,
            )}
            <Button
              disabled={
                action.busy ||
                (mode === "split" && !splitBalanced) ||
                (mode === "component" && !parentAssetId) ||
                (mode === "cip" && !cipAssetId) ||
                ((mode === "asset" || mode === "component") && !name.trim())
              }
              onClick={accept}
            >
              {t(`proposals.confirm.${mode}`)}
            </Button>
          </section>
        ) : null}

        {pending && mode === "reject" ? (
          <section className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            {field(
              "reject-reason",
              t("proposals.fields.rejectReason"),
              <Textarea
                id="reject-reason"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />,
            )}
            <Button
              variant="outline"
              disabled={action.busy || !reason.trim()}
              onClick={() => decide("reject", reason)}
            >
              {t("proposals.confirm.reject")}
            </Button>
          </section>
        ) : null}

        {proposal.acceptance ? (
          <section className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">
              {t("proposals.acceptanceTitle", {
                operation: t(`proposals.modes.${proposal.acceptance.operation}`),
                date: proposal.acceptance.acceptedOn,
              })}
            </h3>
            <ul className="space-y-1 text-sm">
              {proposal.acceptance.assets.map((asset) => (
                <li
                  key={`${asset.assetNumber}-${asset.amount}`}
                  className="flex justify-between gap-4"
                >
                  {asset.id ? (
                    <Link
                      href={`/assets?asset=${asset.id}`}
                      className="font-mono text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {asset.assetNumber}
                    </Link>
                  ) : (
                    <span className="font-mono text-slate-500">{asset.assetNumber}</span>
                  )}
                  <span className="tabular-nums">{money(asset.amount)}</span>
                </li>
              ))}
            </ul>
            {proposal.acceptance.reclassEntryId ? (
              <p className="text-sm">
                <JournalEntryLink
                  entryId={proposal.acceptance.reclassEntryId}
                  className="text-teal-700 hover:underline dark:text-teal-300"
                >
                  {t("proposals.reclassEntry")}
                </JournalEntryLink>
              </p>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("proposals.noReclass")}
              </p>
            )}
            {proposal.acceptance.status === "posted" && data.canCapitalize ? (
              <div className="grid gap-3 border-t border-slate-200 pt-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end dark:border-slate-800">
                {field(
                  "reverse-date",
                  t("proposals.fields.reversalDate"),
                  <DateField
                    id="reverse-date"
                    value={reverseDate}
                    onChange={(value) => setReverseDate(value)}
                  />,
                )}
                {field(
                  "reverse-reason",
                  t("proposals.fields.reason"),
                  <Input
                    id="reverse-reason"
                    value={reverseReason}
                    onChange={(event) => setReverseReason(event.target.value)}
                  />,
                )}
                <Button
                  variant="outline"
                  disabled={action.busy || !reverseReason.trim()}
                  onClick={reverse}
                >
                  {t("proposals.reverse")}
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}

        {proposal.status === "rejected" && data.canCapitalize ? (
          <section className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            {field(
              "restore-reason",
              t("proposals.fields.restoreReason"),
              <Input
                id="restore-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />,
            )}
            <Button
              variant="outline"
              disabled={action.busy || !reason.trim()}
              onClick={() => decide("restore", reason)}
            >
              {t("proposals.restore")}
            </Button>
          </section>
        ) : null}
      </div>
    </UrlDrawer>
  );
}
