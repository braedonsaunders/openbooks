"use client";

import { useMoney } from "@/components/money-provider";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fetchAction } from "@braedonsaunders/appkit-errors";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Badge, Button, Input, Label, Select, Textarea, UrlDrawer } from "@openbooks/ui";
import { DrawerTabStrip } from "@/components/drawer-tab-strip";
import { JournalEntryLink } from "@/components/journal-entry-link";
import { ApprovalActions } from "@/components/approval-actions";
import { ApprovalHistory } from "@/components/approval-history";
import { DateField } from "@/components/date-field";
import { confirmDialog } from "@/lib/confirm";
import { useAppAction } from "@/lib/use-app-action";
import type { ReleaseDrawerData, ReleaseCreateDrawerData } from "./view";

type ReleaseTab = "details" | "approvals";

const STATUS_VARIANT: Record<string, "success" | "secondary" | "warning" | "outline"> = {
  draft: "outline",
  pending_approval: "warning",
  posted: "success",
  void: "secondary",
};

/**
 * Fund-release record drawer — the approval deep-link landing surface. The
 * details read the same row the flow adapter resolves; the approvals tab
 * carries the native decision controls and history bound to the
 * `fund_release` subject, and authorized operators can create, submit, and
 * reverse releases through the guarded nonprofit command routes.
 */
export function ReleaseDrawer({ drawer }: { drawer: ReleaseDrawerData | ReleaseCreateDrawerData }) {
  const { money } = useMoney();
  const t = useTranslations("nonprofit");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const action = useAppAction();
  const [tab, setTab] = useState<ReleaseTab>("details");
  const [createForm, setCreateForm] = useState({
    fromFundId: "",
    toFundId: "",
    releaseAccountId: "",
    releaseDate: drawer.today,
    amount: "",
    purpose: "",
    satisfactionRef: "",
  });
  const [voidDate, setVoidDate] = useState(drawer.today);
  const [voidReason, setVoidReason] = useState("");

  async function createRelease() {
    await action.execute(
      () =>
        fetchAction<{ release: { id: string } }>("/api/fund-releases/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "create", ...createForm }),
        }),
      {
        fallbackMessage: tCommon("feedback.createFailed"),
        successMessage: tCommon("feedback.saved"),
        onOk: ({ release }) => {
          router.push(`/nonprofit/releases?release=${release.id}`);
          router.refresh();
        },
      },
    );
  }

  async function runPosting(payload: Record<string, unknown>) {
    await action.execute(
      () =>
        fetchAction("/api/fund-releases/postings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      {
        fallbackMessage: tCommon("feedback.saveFailed"),
        successMessage: tCommon("feedback.saved"),
        onOk: () => router.refresh(),
      },
    );
  }

  async function confirmVoidRelease(releaseId: string, purpose: string) {
    if (
      !(await confirmDialog({
        title: tCommon("amendment.voidTitle"),
        message: purpose,
        confirmLabel: tCommon("actions.void"),
        tone: "danger",
      }))
    )
      return;
    await runPosting({ action: "void", releaseId, voidDate, reason: voidReason });
  }

  if (drawer.mode === "create") {
    return (
      <UrlDrawer
        open
        closeHref={drawer.closeHref}
        size="2xl"
        title={tCommon("actions.newRecord")}
        description={t("releases.details")}
      >
        <ActionAlert error={action.refusal} fallbackMessage={tCommon("feedback.createFailed")} />
        <div className="grid gap-4 p-1 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="release-from-fund">{t("releases.fromFund")}</Label>
            <Select
              id="release-from-fund"
              value={createForm.fromFundId}
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, fromFundId: event.target.value }))
              }
            >
              <option value="">{tCommon("actions.select")}</option>
              {drawer.funds.map((fund) => (
                <option key={fund.id} value={fund.id}>
                  {fund.code ? `${fund.code} · ` : ""}
                  {fund.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="release-to-fund">{t("releases.toFund")}</Label>
            <Select
              id="release-to-fund"
              value={createForm.toFundId}
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, toFundId: event.target.value }))
              }
            >
              <option value="">{tCommon("actions.select")}</option>
              {drawer.funds.map((fund) => (
                <option key={fund.id} value={fund.id}>
                  {fund.code ? `${fund.code} · ` : ""}
                  {fund.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="release-account">{tCommon("labels.account")}</Label>
            <Select
              id="release-account"
              value={createForm.releaseAccountId}
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, releaseAccountId: event.target.value }))
              }
            >
              <option value="">{tCommon("actions.select")}</option>
              {drawer.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.number ? `${account.number} · ` : ""}
                  {account.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{tCommon("labels.date")}</Label>
            <DateField
              value={createForm.releaseDate}
              onChange={(value) => setCreateForm((current) => ({ ...current, releaseDate: value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="release-amount">{tCommon("labels.amount")}</Label>
            <Input
              id="release-amount"
              inputMode="decimal"
              value={createForm.amount}
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, amount: event.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="release-purpose">{t("releases.purpose")}</Label>
            <Input
              id="release-purpose"
              value={createForm.purpose}
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, purpose: event.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="release-satisfaction">{t("releases.satisfactionRef")}</Label>
            <Input
              id="release-satisfaction"
              value={createForm.satisfactionRef}
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, satisfactionRef: event.target.value }))
              }
            />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          <Button
            variant="outline"
            disabled={action.busy}
            onClick={() => router.push(drawer.closeHref)}
          >
            {tCommon("actions.cancel")}
          </Button>
          <Button
            disabled={
              action.busy ||
              !createForm.fromFundId ||
              !createForm.toFundId ||
              !createForm.releaseAccountId ||
              !createForm.releaseDate ||
              !createForm.amount.trim() ||
              !createForm.purpose.trim() ||
              !createForm.satisfactionRef.trim()
            }
            onClick={() => void createRelease()}
          >
            {tCommon("actions.create")}
          </Button>
        </div>
      </UrlDrawer>
    );
  }

  const release = drawer.release;

  return (
    <UrlDrawer
      open
      closeHref={drawer.closeHref}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500 dark:text-slate-400">
            {release.number}
          </span>
          <span>
            {release.fromCode} → {release.toCode}
          </span>
          <Badge variant={STATUS_VARIANT[release.status] ?? "secondary"}>{release.status}</Badge>
        </span>
      }
      description={t("releases.details")}
      subtabs={
        <DrawerTabStrip
          ariaLabel={t("releases.tabsAria")}
          activeKey={tab}
          onSelect={setTab}
          tabs={
            [
              { key: "details", label: tCommon("auditTrail.tabs.details") },
              { key: "approvals", label: t("releases.approvals") },
            ] as const
          }
        />
      }
      headerActions={
        <div className="flex items-center gap-1.5">
          {tab === "approvals" ? (
            <ApprovalActions subjectKind="fund_release" subjectId={release.id} />
          ) : null}
          {drawer.canCustomize ? (
            <Button asChild variant="outline" size="sm" className="h-8 px-2.5 text-xs">
              <Link href="/admin/customization?recordType=fund_release&tab=forms">
                {tCommon("actions.customize")}
              </Link>
            </Button>
          ) : null}
        </div>
      }
    >
      <ActionAlert error={action.refusal} fallbackMessage={tCommon("feedback.saveFailed")} />
      {tab === "details" ? (
        <div className="space-y-5 p-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {t("releases.fromFund")}
              </p>
              <p className="font-mono text-sm">
                {release.fromCode}{" "}
                <span className="font-sans text-slate-500">· {release.fromName}</span>
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {t("releases.toFund")}
              </p>
              <p className="font-mono text-sm">
                {release.toCode}{" "}
                <span className="font-sans text-slate-500">· {release.toName}</span>
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {t("releases.amount")}
              </p>
              <p className="text-sm tabular-nums">{money(release.amount)}</p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {t("releases.releaseDate")}
              </p>
              <p className="font-mono text-sm">{release.releaseDate}</p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {t("releases.purpose")}
              </p>
              <p className="text-sm">{release.purpose}</p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {t("releases.satisfactionRef")}
              </p>
              <p className="text-sm">{release.satisfactionRef}</p>
            </div>
          </div>
          <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">
              {t("releases.evidence")}
            </h3>
            {release.postedEntryId || release.voidEntryId ? (
              <div className="mt-2 space-y-1.5 text-sm">
                {release.postedEntryId ? (
                  <p>
                    {t("releases.postedEntry")}:{" "}
                    <JournalEntryLink
                      entryId={release.postedEntryId}
                      className="font-mono text-[13px] text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {release.postedEntryId.slice(0, 8)}
                    </JournalEntryLink>
                  </p>
                ) : null}
                {release.voidEntryId ? (
                  <p>
                    {t("releases.voidEntry")}:{" "}
                    <JournalEntryLink
                      entryId={release.voidEntryId}
                      className="font-mono text-[13px] text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {release.voidEntryId.slice(0, 8)}
                    </JournalEntryLink>
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {t("releases.noEvidence")}
              </p>
            )}
          </section>
          {drawer.canManage && release.status === "draft" ? (
            drawer.canPost ? (
              <Button
                disabled={action.busy}
                onClick={() => void runPosting({ action: "submit", releaseId: release.id })}
              >
                {tCommon("actions.submit")}
              </Button>
            ) : (
              <p className="text-sm text-slate-500">
                {tCommon("permissionHint", {
                  permission: "gl.post",
                  action: tCommon("actions.submit"),
                })}
              </p>
            )
          ) : null}
          {drawer.canManage && release.status === "posted" ? (
            drawer.canPost ? (
              <div className="grid gap-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label>{tCommon("labels.date")}</Label>
                  <DateField value={voidDate} onChange={setVoidDate} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="release-void-reason">{tCommon("amendment.reason")}</Label>
                  <Textarea
                    id="release-void-reason"
                    value={voidReason}
                    onChange={(event) => setVoidReason(event.target.value)}
                  />
                </div>
                <Button
                  variant="outline"
                  disabled={action.busy || !voidDate || !voidReason.trim()}
                  onClick={() => void confirmVoidRelease(release.id, release.purpose)}
                >
                  {tCommon("actions.void")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                {tCommon("permissionHint", {
                  permission: "gl.post",
                  action: tCommon("actions.void"),
                })}
              </p>
            )
          ) : null}
        </div>
      ) : (
        <div className="p-1">
          <ApprovalHistory subjectKind="fund_release" subjectId={release.id} showEmptyState />
        </div>
      )}
    </UrlDrawer>
  );
}
