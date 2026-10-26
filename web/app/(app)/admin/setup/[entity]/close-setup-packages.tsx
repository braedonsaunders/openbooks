"use client";

import Link from "next/link";
import { ApiResponseError } from "@/lib/api-error";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Badge,
  Button,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  SearchSelect,
  Select,
  Textarea,
  UrlDrawer,
} from "@openbooks/ui";
import { ChevronRight, FileOutput, Plus, Send } from "lucide-react";
import { pickString } from "../../../../../lib/list-params";
import { ReportAttachmentCard } from "./close-setup-report-attachment";
import {
  Check,
  ConfigListControls,
  EmptyList,
  Field,
  KeyValueRows,
  type Option,
  RowLink,
  SectionHeading,
  dataText,
  drawerHref,
  normalizeAttachments,
  objectToRows,
  post,
  pruneEmpty,
  rowsToObject,
} from "./close-setup-shared";
import type { PackageDraft, PackageRow, Props, ReportAttachment } from "./close-setup-types";

export function PackagesTab(props: Props) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const selected = pickString(props.currentParams.package);
  const row =
    selected && selected !== "new"
      ? props.packages.find((item) => item.id === selected)
      : undefined;
  return (
    <div className="space-y-4">
      <SectionHeading
        icon={<FileOutput size={18} />}
        title={t("packages.title")}
        description={t("packages.description")}
        action={
          <Button size="sm" asChild>
            <Link href={drawerHref(props.currentParams, "packages", "package", "new")}>
              <Plus size={14} />
              {t("actions.newPackage")}
            </Link>
          </Button>
        }
      />
      <ConfigListControls
        listKey="package"
        list={props.configLists.package}
        currentParams={props.currentParams}
        perPage={props.configPerPage}
      />
      <div className="grid gap-3 md:grid-cols-2">
        {props.packages.map((item) => (
          <RowLink
            key={item.id}
            href={drawerHref(props.currentParams, "packages", "package", item.id)}
          >
            <CardHeader className="p-4">
              <div className="flex justify-between gap-2">
                <CardTitle className="text-base">{dataText(td, item.name)}</CardTitle>
                <div className="flex gap-1">
                  {item.is_default ? <Badge variant="success">{t("labels.default")}</Badge> : null}
                  {!item.is_active ? <Badge variant="outline">{t("labels.inactive")}</Badge> : null}
                  <ChevronRight size={16} className="text-slate-400" />
                </div>
              </div>
              <CardDescription>
                {t("packages.reportCount", {
                  count: Array.isArray(item.reports) ? item.reports.length : 0,
                })}
              </CardDescription>
            </CardHeader>
          </RowLink>
        ))}
      </div>
      {props.packages.length === 0 ? <EmptyList>{t("empty.packages")}</EmptyList> : null}
      {selected ? <PackageDrawer key={selected} row={row} props={props} /> : null}
    </div>
  );
}

export function PackageDrawer({ row, props }: { row?: PackageRow; props: Props }) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const router = useRouter();
  const closeHref = drawerHref(props.currentParams, "packages", "package", null);
  const DELIVERY_KNOWN = ["format", "combine", "coverPage", "cadence"];
  const [draft, setDraft] = useState<PackageDraft>(
    row
      ? {
          id: row.id,
          name: dataText(td, row.name),
          description: dataText(td, row.description) ?? "",
          reports: normalizeAttachments(row.reports),
          recipientsText: Array.isArray(row.recipients) ? row.recipients.join("\n") : "",
          delivery: row.delivery ?? {},
          isDefault: row.is_default,
          isActive: row.is_active,
        }
      : {
          name: "",
          description: "",
          reports: [
            "profit-and-loss",
            "balance-sheet",
            "cash-flow",
            "trial-balance",
            "general-ledger",
          ].map((slug) => ({ slug })),
          recipientsText: "",
          delivery: {},
          isDefault: false,
          isActive: true,
        },
  );
  const [advancedDelivery, setAdvancedDelivery] = useState<Array<{ key: string; value: string }>>(
    objectToRows(
      row?.delivery && typeof row.delivery === "object"
        ? Object.fromEntries(
            Object.entries(row.delivery).filter(([key]) => !DELIVERY_KNOWN.includes(key)),
          )
        : {},
    ),
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sendPeriod, setSendPeriod] = useState("");
  const [sendBook, setSendBook] = useState(props.selectedBookId || props.books[0]?.id || "");
  const [sending, setSending] = useState(false);
  // One send-intent key per dialog instance, rotated after success: a
  // double-click reuses the key and dedupes in BullMQ and the email worker.
  const [sendKey, setSendKey] = useState(() => crypto.randomUUID());
  async function sendNow() {
    if (!draft.id || !sendPeriod || !sendBook) return;
    setSending(true);
    setActionError(null);
    try {
      await post(
        {
          action: "send-package",
          packageId: draft.id,
          periodId: sendPeriod,
          bookId: sendBook,
          idempotencyKey: sendKey,
        },
        t("errors.actionFailed"),
      );
      toast.success(t("packages.sendQueued"));
      setSendKey(crypto.randomUUID());
    } catch (error) {
      const message = error instanceof ApiResponseError ? error.message : t("errors.actionFailed");
      setActionError(message);
      toast.error(message);
    } finally {
      setSending(false);
    }
  }
  const delivery = draft.delivery ?? {};
  const setDelivery = (patch: Record<string, unknown>) =>
    setDraft({ ...draft, delivery: { ...delivery, ...patch } });
  const attachments: ReportAttachment[] = draft.reports;
  const metaBySlug = new Map(props.reportDefs.map((r) => [r.slug, r]));
  const attachedSlugs = new Set(attachments.map((item) => item.slug));
  const addOptions: Option[] = props.reportDefs
    .filter((r) => !attachedSlugs.has(r.slug))
    .map((r) => ({
      value: r.slug,
      label: r.name,
      group: t(`reportGroups.${r.kind}`),
    }));
  const setAttachment = (index: number, patch: Partial<ReportAttachment>) =>
    setDraft({
      ...draft,
      reports: attachments.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    });
  async function save() {
    setBusy(true);
    try {
      const composedDelivery = pruneEmpty({
        format: delivery.format,
        combine: delivery.combine,
        coverPage: delivery.coverPage,
        cadence: delivery.cadence,
        ...rowsToObject(advancedDelivery),
      });
      await post(
        {
          action: "save-package",
          id: draft.id,
          name: draft.name,
          description: draft.description,
          reports: attachments,
          recipients: draft.recipientsText
            .split("\n")
            .map((v: string) => v.trim())
            .filter(Boolean),
          delivery: composedDelivery,
          isDefault: draft.isDefault,
          isActive: draft.isActive,
        },
        t("errors.actionFailed"),
      );
      toast.success(t("messages.packageSaved"));
      router.push(closeHref);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof ApiResponseError && error.message
          ? error.message
          : t("errors.invalidConfiguration"),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="lg"
      title={t("packages.formTitle")}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={() => router.push(closeHref)}>
            {t("actions.cancel")}
          </Button>
          <Button disabled={busy || !draft.name} onClick={save}>
            {busy ? t("actions.saving") : t("actions.save")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-1">
        {actionError ? (
          <p role="alert" className="text-sm text-red-600">
            {actionError}
          </p>
        ) : null}
        <Field label={t("fields.name")}>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label={t("fields.description")}>
          <Textarea
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </Field>
        <Field label={t("fields.reports")}>
          <div className="space-y-2">
            <SearchSelect
              value=""
              onChange={(slug) => {
                if (slug && !attachedSlugs.has(slug))
                  setDraft({ ...draft, reports: [...attachments, { slug }] });
              }}
              options={addOptions}
              searchable
              placeholder={t("packages.addReport")}
              emptyLabel={t("reportsEmpty")}
              ariaLabel={t("packages.addReport")}
            />
            {attachments.length === 0 ? (
              <p className="text-xs text-slate-400">{t("packages.noReports")}</p>
            ) : (
              <div className="space-y-2">
                {attachments.map((attachment, index) => (
                  <ReportAttachmentCard
                    key={`${attachment.slug}-${index}`}
                    attachment={attachment}
                    meta={metaBySlug.get(attachment.slug)}
                    props={props}
                    onChange={(patch) => setAttachment(index, patch)}
                    onRemove={() =>
                      setDraft({
                        ...draft,
                        reports: attachments.filter((_, i) => i !== index),
                      })
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </Field>
        <Field label={t("fields.recipients")} hint={t("packages.recipientsHint")}>
          <Textarea
            rows={4}
            value={draft.recipientsText}
            onChange={(e) => setDraft({ ...draft, recipientsText: e.target.value })}
          />
        </Field>
        <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <div>
            <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {t("delivery.title")}
            </h4>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t("delivery.intro")}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("delivery.format")}>
              <Select
                value={String(delivery.format ?? "pdf")}
                onChange={(e) => setDelivery({ format: e.target.value })}
              >
                {["pdf", "xlsx", "both"].map((value) => (
                  <option key={value} value={value}>
                    {t(`delivery.formats.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("delivery.cadence")}>
              <Select
                value={String(delivery.cadence ?? "on_publish")}
                onChange={(e) => setDelivery({ cadence: e.target.value })}
              >
                {["on_publish", "manual"].map((value) => (
                  <option key={value} value={value}>
                    {t(`delivery.cadences.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Check
            checked={delivery.combine === true}
            onChange={(value) => setDelivery({ combine: value })}
          >
            {t("delivery.combine")}
          </Check>
          <Check
            checked={delivery.coverPage === true}
            onChange={(value) => setDelivery({ coverPage: value })}
          >
            {t("delivery.coverPage")}
          </Check>
          <details className="text-sm">
            <summary className="cursor-pointer text-slate-500 dark:text-slate-400">
              {t("delivery.advanced")}
            </summary>
            <div className="pt-2">
              <KeyValueRows rows={advancedDelivery} onChange={setAdvancedDelivery} />
            </div>
          </details>
        </div>
        <div className="space-y-2">
          <Check
            checked={draft.isDefault}
            onChange={(value) => setDraft({ ...draft, isDefault: value })}
          >
            {t("fields.defaultPackage")}
          </Check>
          <Check
            checked={draft.isActive}
            onChange={(value) => setDraft({ ...draft, isActive: value })}
          >
            {t("fields.active")}
          </Check>
        </div>
        {draft.id ? (
          <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
            <div>
              <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {t("packages.sendNowTitle")}
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("packages.sendNowHint")}
              </p>
            </div>
            {props.periods.length === 0 ? (
              <p className="text-xs text-slate-400">{t("packages.sendNoPeriods")}</p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("fields.book")}>
                    <Select value={sendBook} onChange={(e) => setSendBook(e.target.value)}>
                      {props.books.map((book) => (
                        <option key={book.id} value={book.id}>
                          {book.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("packages.sendPeriod")}>
                    <Select value={sendPeriod} onChange={(e) => setSendPeriod(e.target.value)}>
                      <option value="">{t("packages.selectPeriod")}</option>
                      {props.periods.map((period) => (
                        <option key={period.id} value={period.id}>
                          {period.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={sending || !sendPeriod || !sendBook}
                  onClick={sendNow}
                >
                  <Send size={14} />
                  {sending ? t("packages.sending") : t("packages.sendNow")}
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </UrlDrawer>
  );
}
