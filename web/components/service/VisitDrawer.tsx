"use client";

import { useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Camera, ExternalLink, Mail, Phone, Trash2 } from "lucide-react";
import { Button, Input, Label, Select, Textarea } from "@openbooks/ui";
import type { ServiceVisitDetail } from "@openbooks/engine/service/reads";
import { AsyncDrawer } from "../async-url-drawer";
import { promptDialog } from "../../lib/prompt";
import { postJson, refusalText, serviceRequest } from "./api";
import {
  Field,
  Refusal,
  Section,
  VisitStatusBadge,
  plainDecimal,
  useServiceFormat,
} from "./format";
import { RemotePicker } from "./pickers";
import { useServiceRecord } from "./use-record";

type AttachedFile = { id: string; name: string; contentType: string; createdAt: string };
type Refused = { message: string; remedy: string | null } | null;

/** A visit opened from a board or a list in a locally controlled drawer. */
export function ServiceVisitDrawer({ visitId, onClose }: { visitId: string; onClose: () => void }) {
  const t = useTranslations("service.visit");
  const record = useServiceRecord<ServiceVisitDetail>(
    `/api/service/visits/${visitId}`,
    t("loadFailed"),
  );
  return (
    <AsyncDrawer
      open
      onClose={onClose}
      size="lg"
      title={
        record.data
          ? `${record.data.parent.number} · ${t("sequence", { sequence: record.data.visit.sequence })}`
          : t("title")
      }
      description={record.data?.parent.title}
      pending={record.pending}
      error={record.error}
      onRetry={record.reload}
    >
      {record.data ? <ServiceVisitBody detail={record.data} reload={record.reload} /> : null}
    </AsyncDrawer>
  );
}

/** Everything about one visit and the work a technician or dispatcher may do on it. */
export function ServiceVisitBody({
  detail,
  reload,
  compact = false,
}: {
  detail: ServiceVisitDetail;
  reload: () => void;
  compact?: boolean;
}) {
  const t = useTranslations("service.visit");
  const ts = useTranslations("service");
  const f = useServiceFormat();
  const { visit, parent } = detail;
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refused>(null);
  const staff = detail.mode === "staff";
  const active = ["scheduled", "dispatched", "en_route", "on_site"].includes(visit.status);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setRefusal(null);
    try {
      await action();
      reload();
    } catch (error) {
      setRefusal(refusalText(error, t("actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function moveTo(to: string) {
    let reason: string | null = null;
    if (to === "unable_to_complete") {
      reason = await promptDialog({
        title: t("unable.title"),
        label: t("unable.reason"),
        multiline: true,
        confirmLabel: t("unable.confirm"),
      });
      if (!reason) return;
    }
    await run(() =>
      postJson(
        `/api/service/visits/${visit.id}/status`,
        { expectedRevision: visit.revision, to, reason },
        t("actionFailed"),
      ),
    );
  }

  async function cancel() {
    const reason = await promptDialog({
      title: t("cancel.title"),
      label: t("cancel.reason"),
      multiline: true,
      confirmLabel: t("cancel.confirm"),
    });
    if (!reason) return;
    await run(() =>
      postJson(
        `/api/service/visits/${visit.id}/cancel`,
        { expectedRevision: visit.revision, reason },
        t("actionFailed"),
      ),
    );
  }

  const fieldMoves = detail.nextStatuses.filter(
    (status) =>
      status === "dispatched" ||
      status === "en_route" ||
      status === "on_site" ||
      status === "unable_to_complete",
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <VisitStatusBadge status={visit.status} />
        <span className="text-xs text-slate-500">{ts(`visitKind.${visit.kind}`)}</span>
        {visit.reviewStatus && visit.reviewStatus !== "not_required" ? (
          <span className="text-xs font-medium text-amber-700">
            {t(`review.${visit.reviewStatus}`)}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-1.5">
          {fieldMoves.map((status) => (
            <Button
              key={status}
              size={compact ? "md" : "sm"}
              variant={status === "unable_to_complete" ? "outline" : "default"}
              disabled={busy}
              onClick={() => void moveTo(status)}
            >
              {t(`move.${status}`)}
            </Button>
          ))}
          {staff && detail.canDispatch && !["completed", "cancelled"].includes(visit.status) ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>
              {t("cancel.action")}
            </Button>
          ) : null}
        </div>
      </div>
      <Refusal refusal={refusal} />

      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label={t("customer")}>{parent.customerName}</Field>
        <Field label={t(parent.kind === "job" ? "job" : "request")}>
          {staff ? (
            <Link
              className="text-teal-700 hover:underline dark:text-teal-300"
              href={
                parent.kind === "job"
                  ? `/service/jobs?job=${parent.id}`
                  : `/service/requests?request=${parent.id}`
              }
            >
              {parent.number}
            </Link>
          ) : (
            parent.number
          )}{" "}
          · {parent.title}
        </Field>
        <Field label={t("address")}>{parent.address ?? "—"}</Field>
        <Field label={t("contact")}>
          {parent.contactName ?? "—"}
          {parent.contactPhone ? (
            <a
              className="ml-2 inline-flex items-center gap-1 text-teal-700 dark:text-teal-300"
              href={`tel:${parent.contactPhone}`}
            >
              <Phone className="h-3.5 w-3.5" />
              {parent.contactPhone}
            </a>
          ) : null}
        </Field>
        <Field label={t("arrivalWindow")}>
          {f.window(visit.windowStartsAt, visit.windowEndsAt)}
        </Field>
        <Field label={t("duration")}>{f.minutes(visit.estimatedMinutes)}</Field>
        {staff ? <Field label={t("responseDue")}>{f.instant(visit.slaDueAt)}</Field> : null}
        <Field label={t("technicians")}>
          {detail.technicians.length
            ? detail.technicians.map((tech) => (
                <span key={tech.entryId} className="block">
                  {tech.name} · {f.instant(tech.startsAt)} – {f.time(tech.endsAt)}
                </span>
              ))
            : t("unassigned")}
        </Field>
      </dl>
      {visit.instructions ? (
        <Section title={t("instructions")}>
          <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
            {visit.instructions}
          </p>
        </Section>
      ) : null}
      {visit.workNotes ? (
        <Section title={t("workNotes")}>
          <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
            {visit.workNotes}
          </p>
        </Section>
      ) : null}
      {visit.outcomeReason ? (
        <Section title={t("outcome")}>
          <p className="text-sm text-slate-700 dark:text-slate-200">{visit.outcomeReason}</p>
        </Section>
      ) : null}

      <PartsSection detail={detail} active={active} onChanged={reload} />
      {visit.status === "on_site" ? <CompletionForm detail={detail} onCompleted={reload} /> : null}
      <PhotosSection visitId={visit.id} canAdd={visit.status !== "cancelled"} />
      <SignatureSection detail={detail} onChanged={reload} />

      {detail.labor.length ? (
        <Section title={t("labor")}>
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {detail.labor.map((entry) => (
              <li key={entry.id} className="flex justify-between py-1.5">
                <span>
                  {entry.workerName} · {f.date(entry.workedOn)}
                </span>
                <span className="tabular-nums">
                  {t("hours", { hours: plainDecimal(entry.hours) })} ·{" "}
                  {t(`laborStatus.${entry.status}`)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {staff && detail.invoice ? (
        <Section title={t("invoice")}>
          <Link
            className="text-sm text-teal-700 hover:underline dark:text-teal-300"
            href={`/ar/invoices?doc=${detail.invoice.id}`}
          >
            {detail.invoice.documentNumber}
          </Link>
        </Section>
      ) : null}
      {staff && detail.notices.length ? (
        <Section title={t("notices")}>
          <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
            {detail.notices.map((notice, index) => (
              <li key={index}>
                {f.instant(notice.createdAt)} · {t(`noticeKind.${notice.kind}`)} ·{" "}
                {t(`noticeStatus.${notice.status}`)}
                {notice.recipient ? ` · ${notice.recipient}` : ""}
                {notice.detail ? ` — ${notice.detail}` : ""}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title={t("history")}>
        <ol className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
          {detail.events.map((event, index) => (
            <li key={index}>
              {f.instant(event.occurredAt)} ·{" "}
              {event.fromStatus ? `${ts(`visitStatus.${event.fromStatus}`)} → ` : ""}
              {ts(`visitStatus.${event.toStatus}`)}
              {event.actorName ? ` · ${event.actorName}` : ""}
              {event.reason ? ` — ${event.reason}` : ""}
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

function PartsSection({
  detail,
  active,
  onChanged,
}: {
  detail: ServiceVisitDetail;
  active: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations("service.visit");
  const [adding, setAdding] = useState(false);
  const [itemId, setItemId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [billable, setBillable] = useState(detail.parent.billingMode !== "not_billable");
  const [locations, setLocations] = useState<Array<{
    id: string;
    code: string;
    name: string;
  }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refused>(null);

  async function open() {
    setAdding(true);
    if (locations) return;
    try {
      const result = await serviceRequest<{
        options: Array<{ id: string; code: string; name: string }>;
      }>("/api/service/options?kind=stock-locations", undefined, t("actionFailed"));
      setLocations(result.options);
      setLocationId((current) => current || result.options[0]?.id || "");
    } catch (error) {
      setRefusal(refusalText(error, t("actionFailed")));
    }
  }

  async function save() {
    setBusy(true);
    setRefusal(null);
    try {
      await postJson(
        `/api/service/visits/${detail.visit.id}/parts`,
        {
          expectedRevision: detail.visit.revision,
          itemId,
          stockLocationId: locationId,
          quantity: quantity.trim(),
          billable,
        },
        t("actionFailed"),
      );
      setAdding(false);
      setItemId("");
      setQuantity("1");
      onChanged();
    } catch (error) {
      setRefusal(refusalText(error, t("actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function remove(partId: string) {
    setBusy(true);
    setRefusal(null);
    try {
      await postJson(
        `/api/service/visits/${detail.visit.id}/parts/${partId}`,
        { expectedRevision: detail.visit.revision },
        t("actionFailed"),
        "DELETE",
      );
      onChanged();
    } catch (error) {
      setRefusal(refusalText(error, t("actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title={t("parts")}
      action={
        active && !adding ? (
          <Button size="sm" variant="outline" onClick={() => void open()}>
            {t("addPart")}
          </Button>
        ) : null
      }
    >
      <Refusal refusal={refusal} />
      {detail.parts.length === 0 && !adding ? (
        <p className="text-sm text-slate-500">{t("noParts")}</p>
      ) : null}
      {detail.parts.length ? (
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {detail.parts.map((part) => (
            <li key={part.id} className="flex items-center justify-between gap-2 py-1.5">
              <span className="min-w-0 truncate">
                {part.itemName} · {part.stockLocation}
              </span>
              <span className="flex shrink-0 items-center gap-2 tabular-nums text-slate-600 dark:text-slate-300">
                {plainDecimal(part.quantity)}
                {part.unitPrice !== null && part.billable
                  ? ` × ${plainDecimal(part.unitPrice)}`
                  : ""}
                {!part.billable ? (
                  <span className="text-xs text-slate-400">{t("notBilled")}</span>
                ) : null}
                {part.issued ? (
                  <span className="text-xs text-emerald-700">{t("issued")}</span>
                ) : active ? (
                  <button
                    type="button"
                    onClick={() => void remove(part.id)}
                    disabled={busy}
                    aria-label={t("removePart")}
                  >
                    <Trash2 className="h-4 w-4 text-slate-400 hover:text-rose-600" />
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {adding ? (
        <div className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 dark:border-slate-800">
          <div className="sm:col-span-2">
            <Label>{t("part")}</Label>
            <RemotePicker
              kind="part-items"
              value={itemId}
              ariaLabel={t("part")}
              onChange={(value) => setItemId(value)}
            />
          </div>
          <div>
            <Label>{t("stockLocation")}</Label>
            <Select
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
              aria-label={t("stockLocation")}
            >
              {(locations ?? []).map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name} · {location.code}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t("quantity")}</Label>
            <Input
              inputMode="decimal"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              aria-label={t("quantity")}
            />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={billable}
              onChange={(event) => setBillable(event.target.checked)}
            />
            {t("billable")}
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <Button
              size="sm"
              disabled={busy || !itemId || !locationId || !quantity.trim()}
              onClick={() => void save()}
            >
              {t("savePart")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {t("discard")}
            </Button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}

function CompletionForm({
  detail,
  onCompleted,
}: {
  detail: ServiceVisitDetail;
  onCompleted: () => void;
}) {
  const t = useTranslations("service.visit");
  const staff = detail.mode === "staff";
  // Labor starts from the recorded arrival; the hours default to the time on
  // site so far, rounded to the quarter hour, and stay editable.
  const [arrived] = useState(() => detail.visit.arrivedAt ?? new Date().toISOString());
  const [rows, setRows] = useState(() => {
    const onSite = Math.max(
      0.25,
      Math.round(((Date.now() - Date.parse(arrived)) / 3600_000) * 4) / 4,
    ).toFixed(2);
    return staff
      ? detail.technicians.map((tech) => ({
          workerPartyId: tech.partyId,
          name: tech.name,
          hours: onSite,
        }))
      : [{ workerPartyId: "", name: "", hours: onSite }];
  });
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refused>(null);

  async function complete() {
    setBusy(true);
    setRefusal(null);
    try {
      const labor = rows
        .filter((row) => /[1-9]/.test(row.hours.trim()))
        .map((row) => ({
          workerPartyId: row.workerPartyId || null,
          startedAt: arrived,
          hours: row.hours.trim(),
        }));
      const result = await postJson<{ reviewStatus: string }>(
        `/api/service/visits/${detail.visit.id}/complete`,
        { expectedRevision: detail.visit.revision, workNotes: notes, labor },
        t("actionFailed"),
      );
      if (result.reviewStatus === "pending")
        setRefusal({ message: t("review.pending"), remedy: t("review.pendingRemedy") });
      onCompleted();
    } catch (error) {
      setRefusal(refusalText(error, t("actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={t("complete.title")}>
      <div className="space-y-3 rounded-lg border border-teal-200 bg-teal-50/40 p-3 dark:border-teal-900 dark:bg-teal-950/20">
        <div>
          <Label>{t("workNotes")}</Label>
          <Textarea
            rows={4}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            aria-label={t("workNotes")}
            placeholder={t("complete.notesPlaceholder")}
          />
        </div>
        <div className="space-y-2">
          <Label>{t("complete.labor")}</Label>
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{row.name || t("complete.myLabor")}</span>
              <Input
                className="w-24"
                inputMode="decimal"
                value={row.hours}
                aria-label={t("complete.hoursFor", { name: row.name || t("complete.myLabor") })}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setRows((current) =>
                    current.map((candidate, at) =>
                      at === index ? { ...candidate, hours: event.target.value } : candidate,
                    ),
                  )
                }
              />
              <span className="text-xs text-slate-500">{t("complete.hoursUnit")}</span>
            </div>
          ))}
          <p className="text-xs text-slate-500">{t("complete.laborHelp")}</p>
        </div>
        <Refusal refusal={refusal} />
        <Button disabled={busy || !notes.trim()} onClick={() => void complete()}>
          {t("complete.action")}
        </Button>
      </div>
    </Section>
  );
}

function PhotosSection({ visitId, canAdd }: { visitId: string; canAdd: boolean }) {
  const t = useTranslations("service.visit");
  const files = useServiceRecord<{ files: AttachedFile[] }>(
    `/api/service/visits/${visitId}/files`,
    t("actionFailed"),
  );
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refused>(null);
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setRefusal(null);
    try {
      const form = new FormData();
      form.append("file", file);
      await serviceRequest(
        `/api/service/visits/${visitId}/files`,
        { method: "POST", body: form },
        t("actionFailed"),
      );
      files.reload();
    } catch (error) {
      setRefusal(refusalText(error, t("actionFailed")));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section
      title={t("photos")}
      action={
        canAdd ? (
          <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200">
            <Camera className="h-3.5 w-3.5" />
            {busy ? t("uploading") : t("addPhoto")}
            <input
              type="file"
              accept="image/*,application/pdf"
              capture="environment"
              className="sr-only"
              disabled={busy}
              onChange={(event) => void upload(event)}
            />
          </label>
        ) : null
      }
    >
      <Refusal refusal={refusal} />
      {files.data?.files.length ? (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {files.data.files.map((file) => (
            <li key={file.id}>
              <a
                href={`/api/service/visits/${visitId}/files/${file.id}`}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-md border border-slate-200 dark:border-slate-800"
                title={file.name}
              >
                {file.contentType.startsWith("image/") ? (
                  // Authorized visit files stream from the service route; the image optimizer cannot carry the session.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/service/visits/${visitId}/files/${file.id}`}
                    alt={file.name}
                    className="h-24 w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <span className="flex h-24 items-center justify-center p-2 text-center text-xs text-slate-600">
                    {file.name}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">{files.pending ? t("loading") : t("noPhotos")}</p>
      )}
    </Section>
  );
}

function SignatureSection({
  detail,
  onChanged,
}: {
  detail: ServiceVisitDetail;
  onChanged: () => void;
}) {
  const t = useTranslations("service.visit");
  const f = useServiceFormat();
  const [link, setLink] = useState<{
    link: string;
    emailed: boolean;
    emailDetail: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refused>(null);
  const signable = detail.visit.status === "on_site" || detail.visit.status === "completed";

  async function issue(email: boolean) {
    let recipient: string | null = null;
    if (email) {
      recipient = await promptDialog({
        title: t("signature.emailTitle"),
        label: t("signature.recipient"),
        initialValue: detail.parent.contactEmail ?? detail.parent.customerEmail ?? "",
        confirmLabel: t("signature.send"),
      });
      if (!recipient) return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      const result = await postJson<{ link: string; emailed: boolean; emailDetail: string | null }>(
        `/api/service/visits/${detail.visit.id}/signature-link`,
        { recipient, email },
        t("actionFailed"),
      );
      setLink(result);
      if (!email) window.open(result.link, "_blank", "noopener");
      onChanged();
    } catch (error) {
      setRefusal(refusalText(error, t("actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (detail.signature) {
    return (
      <Section title={t("signature.title")}>
        <div className="flex items-center gap-3">
          {/* The signature image streams from the authorized visit file route. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/service/visits/${detail.visit.id}/files/${detail.signature.fileId}`}
            alt={t("signature.image", { name: detail.signature.signerName })}
            className="h-16 rounded border border-slate-200 bg-white dark:border-slate-700"
          />
          <div className="text-sm">
            <p className="font-medium">{detail.signature.signerName}</p>
            <p className="text-xs text-slate-500">{f.instant(detail.signature.signedAt)}</p>
            {detail.signature.comment ? (
              <p className="text-xs text-slate-600">{detail.signature.comment}</p>
            ) : null}
          </div>
        </div>
      </Section>
    );
  }
  if (!signable) return null;
  return (
    <Section title={t("signature.title")}>
      <Refusal refusal={refusal} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void issue(false)}>
          <ExternalLink className="mr-1 h-3.5 w-3.5" />
          {t("signature.inPerson")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void issue(true)}>
          <Mail className="mr-1 h-3.5 w-3.5" />
          {t("signature.email")}
        </Button>
      </div>
      {link ? (
        <p className="text-xs text-slate-600 dark:text-slate-300">
          {link.emailed
            ? t("signature.emailed")
            : link.emailDetail
              ? t("signature.notEmailed", { detail: link.emailDetail })
              : null}{" "}
          <a
            className="break-all text-teal-700 underline dark:text-teal-300"
            href={link.link}
            target="_blank"
            rel="noreferrer"
          >
            {t("signature.openLink")}
          </a>
        </p>
      ) : detail.signatureLink ? (
        <p className="text-xs text-slate-500">
          {t("signature.open", { expires: f.instant(detail.signatureLink.expiresAt) })}
        </p>
      ) : null}
    </Section>
  );
}
