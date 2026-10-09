"use client";
import { useEffect, useState } from "react";
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button, Drawer, Input, Select, Textarea } from "@openbooks/ui";
import type { SchedulePdfLayout } from "@openbooks/forms-core";
import type { BoardWindow } from './model'
import type { ScheduleDistributionPreview } from '@openbooks/engine/src/schedule-boards/distribution.ts'
import { SchedulingAlert } from './SchedulingAlert'
import { SchedulingRequestError } from './api'
import { scheduleDistributionEmail } from '@openbooks/emails/schedule-distribution'

export function EmailScheduleDrawer({
  window: initialWindow,
  onClose,
}: {
  window: BoardWindow
  onClose: () => void
}) {
  // Keep the reviewed drawer window stable while the board refreshes behind it.
  const [board] = useState(initialWindow)
  const t = useTranslations('scheduling.distribution')
  const [recipientMode, setRecipientMode] = useState<
    "automatic" | "selected" | "combined"
  >("selected");
  const [visibility, setVisibility] = useState<"personal" | "board">(
    "personal",
  );
  const [cohort, setCohort] = useState<
    "scope" | "scheduled" | "supervisors" | "self"
  >("scope");
  const [includePdf, setIncludePdf] = useState(true),
    [message, setMessage] = useState(""),
    [extras, setExtras] = useState<{ id: string; name: string }[]>([]),
    [contactQuery, setContactQuery] = useState(""),
    [contacts, setContacts] = useState<
      { id: string; name: string; email: string | null }[]
    >([]),
    [moreContacts, setMoreContacts] = useState(false);
  const [everyone, setEveryone] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [reason, setReason] = useState('')
  const [preview, setPreview] = useState<ScheduleDistributionPreview | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<{
      message: string
      remedy: string | null
    } | null>(null),
    [queued, setQueued] = useState<{
      id: string
      flowId: string
      runId: string
    } | null>(null)
  const [key, setKey] = useState(() => crypto.randomUUID()),
    [recipientId, setRecipientId] = useState('')
  const [pdfLayout, setPdfLayout] = useState<SchedulePdfLayout>({
    paperSize: "tabloid",
    orientation: "landscape",
    marginMm: 8,
    density: "compact",
    daysPerSection: 14,
    detail: "assignments",
  });
  const [roleKeys, setRoleKeys] = useState<string[]>([]),
    [roles, setRoles] = useState<{ key: string; name: string }[]>([]);
  const rows = board.rows;
  useEffect(() => {
    const abort = new AbortController();
    void fetch(
      `/api/scheduling/boards/${board.board.id}/distribution?q=${encodeURIComponent(contactQuery)}`,
      { signal: abort.signal, cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) {
          const refusal = await response.json().catch(() => ({}));
          throw new Error(refusal.error ?? t("refused"));
        }
        return response.json();
      })
      .then((body) => {
        if (!abort.signal.aborted) {
          setContacts(body.contacts);
          setMoreContacts(body.more);
          setRoles(body.roles);
        }
      })
      .catch((cause) => {
        if (!abort.signal.aborted)
          setError({
            message: cause instanceof Error ? cause.message : t("refused"),
            remedy: null,
          });
      });
    return () => abort.abort();
  }, [board.board.id, contactQuery, t]);
  function reset() {
    setPreview(null)
    setQueued(null)
    setKey(crypto.randomUUID())
    setError(null)
  }
  async function submit(command: "preview" | "send" | "pdf") {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/scheduling/boards/${board.board.id}/distribution`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            command,
            from: board.from,
            through: board.through,
            audience: {
              visibility,
              recipientMode,
              cohort,
              additionalRoleKeys: visibility === "board" ? roleKeys : [],
              additionalPartyIds:
                visibility === "board" ? extras.map((e) => e.id) : [],
              includePdf,
              pdfLayout: includePdf ? pdfLayout : undefined,
              message,
              everyone: recipientMode === "selected" ? false : everyone,
              subjectIds: everyone ? [] : [...selected].sort(),
            },
            ...(command === "pdf"
              ? { version: preview?.version, partyId: recipientId }
              : {}),
            ...(command === 'send'
              ? { version: preview?.version, reason, key }
              : {}),
          }),
        },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new SchedulingRequestError(
          body.error ?? t('refused'),
          body.remedy ?? null,
          body.code ?? null,
        )
      }
      if (command === "pdf") {
        const url = URL.createObjectURL(await response.blob());
        const a = document.createElement("a");
        a.href = url;
        a.download = "Schedule.pdf";
        a.click();
        URL.revokeObjectURL(url);
        return;
      }
      const result = await response.json()
      if (command === 'preview') {
        setPreview(result)
        setRecipientId(result.recipients[0]?.partyId ?? '')
      } else setQueued(result)
    } catch (cause) {
      setError({
        message: cause instanceof Error ? cause.message : t('refused'),
        remedy: cause instanceof SchedulingRequestError ? cause.remedy : null,
      })
    } finally {
      setBusy(false)
    }
  }
  const recipient = preview?.recipients.find((r) => r.partyId === recipientId)
  const report =
    preview && recipient
      ? scheduleDistributionEmail({
          message: preview.audience.message,
          recipient: recipient.name,
          board: preview.boardName,
          from: preview.from,
          through: preview.through,
          timeZone: preview.timeZone,
          version: preview.version,
          lines:
            preview.audience.visibility === "board"
              ? (preview.sharedLines ?? recipient.lines)
              : recipient.lines,
        })
      : null
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={t('title')}
      description={`${board.board.name} · ${board.from} – ${board.through} · ${board.board.timeZone}`}
      footer={
        <div className="flex flex-nowrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('close')}
          </Button>
          <Button
            variant="outline"
            disabled={busy || queued !== null}
            onClick={() => void submit('preview')}
          >
            {t('preview')}
          </Button>
          <Button
            disabled={
              busy ||
              !preview ||
              preview.refusals.length > 0 ||
              !reason.trim() ||
              queued !== null
            }
            onClick={() => void submit('send')}
          >
            {busy ? t('working') : t('send')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-500">{t('explanation')}</p>
        <label className="block text-sm">
          {t('sharing')}
          <Select
            aria-label={t('sharing')}
            value={visibility}
            disabled={busy || queued !== null}
            onChange={(event) => {
              setVisibility(event.target.value as 'personal' | 'board')
              reset()
            }}
            className="mt-1 w-full rounded border p-2 dark:bg-slate-950"
          >
            <option value="personal">{t('personal')}</option>
            <option value="board">{t('wholeBoard')}</option>
          </Select>
        </label>
        {visibility === 'board' ? (
          <SchedulingAlert tone="info" message={t('wholeBoardReview')} />
        ) : null}
        <label className="block text-sm">
          {t("recipientMode")}
          <Select
            aria-label={t("recipientMode")}
            value={recipientMode}
            disabled={busy || queued !== null}
            onChange={(event) => {
              setRecipientMode(event.target.value as typeof recipientMode);
              setEveryone(event.target.value !== "selected");
              setSelected([]);
              setExtras([]);
              setRoleKeys([]);
              reset();
            }}
          >
            {(["selected", "automatic", "combined"] as const).map((mode) => (
              <option key={mode} value={mode}>
                {t(`modes.${mode}`)}
              </option>
            ))}
          </Select>
        </label>
        {board.board.rowKind === "people" && recipientMode !== "selected" ? (
          <label className="block text-sm">
            {t("cohort")}
            <Select
              aria-label={t("cohort")}
              value={cohort}
              disabled={busy || queued !== null}
              onChange={(e) => {
                setCohort(e.target.value as typeof cohort);
                reset();
              }}
            >
              {(["scope", "scheduled", "supervisors", "self"] as const).map(
                (value) => (
                  <option key={value} value={value}>
                    {t(`cohorts.${value}`)}
                  </option>
                ),
              )}
            </Select>
          </label>
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includePdf}
            disabled={busy || queued !== null}
            onChange={(e) => {
              setIncludePdf(e.target.checked);
              reset();
            }}
          />
          {t("includePdf")}
        </label>
        {includePdf ? (
          <fieldset className="grid grid-cols-2 gap-3 rounded border p-3">
            <legend>{t("pdfLayout")}</legend>
            {(
              [
                "paperSize",
                "orientation",
                "density",
                "daysPerSection",
                "detail",
              ] as const
            ).map((field) => {
              const choices = {
                paperSize: ["letter", "a4", "legal", "tabloid"],
                orientation: ["portrait", "landscape"],
                density: ["standard", "compact"],
                daysPerSection: ["7", "14"],
                detail: ["assignments", "hours", "full"],
              }[field];
              return (
                <label key={field} className="text-sm">
                  {t(`pdfFields.${field}`)}
                  <Select
                    aria-label={t(`pdfFields.${field}`)}
                    value={String(pdfLayout[field])}
                    disabled={busy || queued !== null}
                    onChange={(event) => {
                      setPdfLayout(
                        (layout) =>
                          ({
                            ...layout,
                            [field]:
                              field === "daysPerSection"
                                ? Number(event.target.value)
                                : event.target.value,
                          }) as SchedulePdfLayout,
                      );
                      reset();
                    }}
                  >
                    {choices.map((value) => (
                      <option key={value} value={value}>
                        {field === "daysPerSection"
                          ? value
                          : t(`pdfOptions.${field}.${value}`)}
                      </option>
                    ))}
                  </Select>
                </label>
              );
            })}
            <label className="text-sm">
              {t("pdfFields.marginMm")}
              <Input
                aria-label={t("pdfFields.marginMm")}
                type="number"
                min={5}
                max={30}
                value={pdfLayout.marginMm}
                disabled={busy || queued !== null}
                onChange={(event) => {
                  setPdfLayout((layout) => ({
                    ...layout,
                    marginMm: Number(event.target.value),
                  }));
                  reset();
                }}
              />
            </label>
          </fieldset>
        ) : null}
        <Textarea
          aria-label={t("message")}
          value={message}
          maxLength={4000}
          disabled={busy || queued !== null}
          onChange={(e) => {
            setMessage(e.target.value);
            reset();
          }}
          placeholder={t("message")}
        />
        {visibility === "board" && recipientMode !== "automatic" ? (
          <fieldset className="space-y-2">
            <legend>{t("nativeContacts")}</legend>
            <p className="text-xs text-slate-500">{t("additionalHelp")}</p>
            <Input
              aria-label={t("contactSearch")}
              value={contactQuery}
              onChange={(e) => setContactQuery(e.target.value)}
              disabled={busy || queued !== null}
            />
            <Select
              aria-label={t("nativeContacts")}
              value=""
              disabled={busy || queued !== null}
              onChange={(e) => {
                const contact = contacts.find((c) => c.id === e.target.value);
                if (contact && !extras.some((c) => c.id === contact.id)) {
                  setExtras((previous) => [...previous, contact]);
                  reset();
                }
              }}
            >
              <option value="">{t("chooseContact")}</option>
              {contacts
                .filter((c) => !extras.some((x) => x.id === c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.email ?? t("missingEmail")}
                  </option>
                ))}
            </Select>
            {moreContacts ? (
              <p className="text-xs">{t("refineSearch")}</p>
            ) : null}
            {extras.map((contact) => (
              <Button
                key={contact.id}
                variant="outline"
                size="sm"
                disabled={busy || queued !== null}
                onClick={() => {
                  setExtras((all) => all.filter((c) => c.id !== contact.id));
                  reset();
                }}
              >
                {contact.name} ×
              </Button>
            ))}
          </fieldset>
        ) : null}
        {visibility === "board" &&
        recipientMode !== "automatic" &&
        roles.length ? (
          <fieldset className="space-y-2">
            <legend>{t("additionalRoles")}</legend>
            <p className="text-xs text-slate-500">{t("roleHelp")}</p>
            <Select
              aria-label={t("additionalRoles")}
              value=""
              disabled={busy || queued !== null}
              onChange={(event) => {
                if (
                  event.target.value &&
                  !roleKeys.includes(event.target.value)
                ) {
                  setRoleKeys((keys) => [...keys, event.target.value]);
                  reset();
                }
              }}
            >
              <option value="">{t("chooseRole")}</option>
              {roles
                .filter((role) => !roleKeys.includes(role.key))
                .map((role) => (
                  <option key={role.key} value={role.key}>
                    {role.name}
                  </option>
                ))}
            </Select>
            {roleKeys.map((key) => (
              <Button
                key={key}
                variant="outline"
                size="sm"
                disabled={busy || queued !== null}
                onClick={() => {
                  setRoleKeys((keys) => keys.filter((value) => value !== key));
                  reset();
                }}
              >
                {roles.find((role) => role.key === key)?.name ?? key} ×
              </Button>
            ))}
          </fieldset>
        ) : null}
        {recipientMode !== "selected" ? (
          <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={everyone}
            disabled={busy || queued !== null}
            onChange={(event) => {
              setEveryone(event.target.checked)
              reset()
            }}
          />
          {t('everyone')}
        </label>
        ) : null}
        {recipientMode === "selected" || !everyone ? (
          <div className="max-h-48 overflow-auto rounded-lg border p-3">
            {rows.map((row) => (
              <label
                key={row.subjectId}
                className="flex items-center gap-2 py-1 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(row.subjectId)}
                  disabled={busy || queued !== null}
                  onChange={(event) => {
                    setSelected((ids) =>
                      event.target.checked
                        ? [...ids, row.subjectId]
                        : ids.filter((id) => id !== row.subjectId),
                    )
                    reset()
                  }}
                />
                {row.name}
              </label>
            ))}
          </div>
        ) : null}
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={busy || queued !== null}
          placeholder={t('reason')}
          aria-label={t('reason')}
        />
        {error ? (
          <SchedulingAlert message={error.message} remedy={error.remedy} />
        ) : null}
        {queued ? (
          <>
            <SchedulingAlert
              tone="info"
              message={t('queued')}
              remedy={t('deliveryStatus')}
            />
            <Link
              href={`/admin/flows/${queued.flowId}`}
              className="text-sm text-teal-700 underline"
            >
              {t('flows')} · <code>{queued.runId}</code>
            </Link>
          </>
        ) : null}
        {preview ? (
          <>
            <p className="text-xs text-slate-500">
              {t('version')}{' '}
              <code className="break-all">{preview.version}</code>
            </p>
            {preview.refusals.map((message) => (
              <SchedulingAlert key={message} message={message} />
            ))}
            <label className="block text-sm">
              {t('recipients')}
              <Select
                aria-label={t('recipients')}
                value={recipientId}
                onChange={(event) => setRecipientId(event.target.value)}
                className="mt-1 w-full rounded border p-2 dark:bg-slate-950"
              >
                {preview.recipients.map((r) => (
                  <option key={r.partyId} value={r.partyId}>
                    {r.contacts?.map((contact) => contact.name).join(", ") ??
                      r.name}{" "}
                    · {r.email ?? t("missingEmail")} ·{" "}
                    {r.subjects.map((s) => s.name).join(', ')}
                  </option>
                ))}
              </Select>
            </label>
            {includePdf && recipient ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void submit("pdf")}
              >
                {t("downloadPdf")}
              </Button>
            ) : null}
            {preview.excludedHistoricalSubjects?.length ? (
              <SchedulingAlert
                tone="info"
                message={t("historicalExcluded", {
                  count: preview.excludedHistoricalSubjects.length,
                })}
              />
            ) : null}
            {report ? (
              <iframe
                title={t('report')}
                srcDoc={report.html}
                sandbox=""
                className="h-96 w-full rounded-lg border bg-white"
              />
            ) : null}
          </>
        ) : null}
        <div className="flex gap-3 text-xs">
          <Link href="/admin/flows" className="text-teal-700 underline">
            {t('flows')}
          </Link>
          {board.board.rowKind === 'resources' ? (
            <Link
              href={`${board.board.projectId ? `/projects/${board.board.projectId}/schedule` : '/scheduling'}/recipients?board=${encodeURIComponent(board.board.code)}`}
              className="text-teal-700 underline"
            >
              {t('contacts')}
            </Link>
          ) : null}
        </div>
      </div>
    </Drawer>
  )
}
