"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge, Button, Label, Select, Textarea, UrlDrawer } from "@openbooks/ui";
import { promptDialog } from "../../../lib/prompt";
import { readApiErrorMessage } from "../../../lib/api-error";

/**
 * Client controls of the pairing workspace: generate or link a counterpart
 * for an unpaired document, and the pair drawer with both documents and the
 * unlink action. Every refusal the server answers is shown with its reason.
 */

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
    >
      {message}
    </p>
  );
}

export function IntercompanyUnpairedActions({
  actions,
}: {
  actions: { documentId: string; linkHref: string; canManage: boolean };
}) {
  const t = useTranslations("intercompany");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();
  if (!actions.canManage) return null;

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/intercompany/counterparts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: actions.documentId }),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t("errors.generateFailed")));
        return;
      }
      const pair = (await res.json()) as { id: string };
      startTransition(() => router.push(`/intercompany?view=paired&pair=${pair.id}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.linkFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={generate}>
          {t("actions.generate")}
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link href={actions.linkHref as never}>{t("actions.link")}</Link>
        </Button>
      </div>
      {error ? (
        <span role="alert" className="max-w-xs text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface PairSide {
  side: "seller" | "buyer";
  entity: string;
  documentNumber: string;
  href: string;
  kindLabel: string;
  date: string;
  total: string;
  statusLabel: string;
}

export function IntercompanyPairDrawer({
  pair,
  closeHref,
  canManage,
}: {
  pair: {
    id: string;
    status: "linked" | "unlinked";
    kindLabel: string;
    originLabel: string;
    stateLabel: string;
    stateVariant: "success" | "warning" | "destructive";
    issues: string[];
    linkReason: string | null;
    linkedAt: string;
    unlinkReason: string | null;
    sides: PairSide[];
  };
  closeHref: string;
  canManage: boolean;
}) {
  const t = useTranslations("intercompany");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function unlink() {
    const reason = await promptDialog({
      title: t("pair.unlinkTitle"),
      label: t("pair.unlinkReason"),
    });
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/intercompany/pairs/${pair.id}/unlink`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t("errors.unlinkFailed")));
        return;
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.linkFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <UrlDrawer
      open
      openKey={pair.id}
      closeHref={closeHref}
      size="lg"
      title={pair.kindLabel}
      description={pair.originLabel}
      headerActions={
        <div className="flex items-center gap-2">
          {pair.status === "unlinked" ? (
            <Badge variant="secondary">{t("pair.unlinked")}</Badge>
          ) : (
            <Badge variant={pair.stateVariant}>{pair.stateLabel}</Badge>
          )}
          {canManage && pair.status === "linked" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={unlink}>
              {t("pair.unlink")}
            </Button>
          ) : null}
        </div>
      }
    >
      <ErrorNote message={error} />
      {pair.issues.length > 0 ? (
        <ul className="mb-4 list-disc space-y-1 rounded-lg bg-amber-50 py-2 pl-6 pr-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {pair.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {pair.sides.map((side) => (
          <section
            key={side.side}
            className="rounded-xl border border-slate-200 p-3 dark:border-slate-800"
          >
            <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              {t(side.side === "seller" ? "pair.seller" : "pair.buyer")} · {side.entity}
            </h3>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500 dark:text-slate-400">{side.kindLabel}</dt>
                <dd>
                  <Link
                    className="font-medium underline-offset-2 hover:underline"
                    href={side.href as never}
                  >
                    {side.documentNumber}
                  </Link>
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500 dark:text-slate-400">{t("columns.date")}</dt>
                <dd className="tabular-nums">{side.date}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500 dark:text-slate-400">{t("columns.amount")}</dt>
                <dd className="tabular-nums">{side.total}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500 dark:text-slate-400">{t("columns.status")}</dt>
                <dd>{side.statusLabel}</dd>
              </div>
            </dl>
          </section>
        ))}
      </div>
      <dl className="mt-4 space-y-1 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500 dark:text-slate-400">{t("pair.linkedOn")}</dt>
          <dd className="tabular-nums">{pair.linkedAt}</dd>
        </div>
        {pair.linkReason ? (
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500 dark:text-slate-400">{t("pair.linkReason")}</dt>
            <dd>{pair.linkReason}</dd>
          </div>
        ) : null}
        {pair.unlinkReason ? (
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500 dark:text-slate-400">{t("pair.unlinkReason")}</dt>
            <dd>{pair.unlinkReason}</dd>
          </div>
        ) : null}
      </dl>
    </UrlDrawer>
  );
}

export function IntercompanyLinkDrawer({
  source,
  candidates,
  closeHref,
  pairHrefBase,
  canManage,
}: {
  source: {
    documentId: string;
    documentNumber: string;
    side: "seller" | "buyer";
    kindLabel: string;
    entity: string;
    counterparty: string;
    amount: string;
  };
  candidates: { documentId: string; label: string }[];
  closeHref: string;
  pairHrefBase: string;
  canManage: boolean;
}) {
  const t = useTranslations("intercompany");
  const router = useRouter();
  const [counterpart, setCounterpart] = useState(candidates[0]?.documentId ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function link() {
    if (!counterpart) return;
    setBusy(true);
    setError(null);
    try {
      const body =
        source.side === "seller"
          ? { sellerDocumentId: source.documentId, buyerDocumentId: counterpart, reason }
          : { sellerDocumentId: counterpart, buyerDocumentId: source.documentId, reason };
      const res = await fetch("/api/intercompany/pairs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t("errors.linkFailed")));
        return;
      }
      const pair = (await res.json()) as { id: string };
      const separator = pairHrefBase.includes("?") ? "&" : "?";
      router.push(`${pairHrefBase}${separator}pair=${pair.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.linkFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <UrlDrawer
      open
      openKey={source.documentId}
      closeHref={closeHref}
      size="md"
      title={t("link.title", { document: source.documentNumber })}
      description={`${source.kindLabel} · ${source.entity} → ${source.counterparty} · ${source.amount}`}
      footer={
        canManage ? (
          <div className="flex justify-end">
            <Button disabled={busy || !counterpart || !reason.trim()} onClick={link}>
              {t("link.submit")}
            </Button>
          </div>
        ) : undefined
      }
    >
      <ErrorNote message={error} />
      {candidates.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">{t("link.noCandidates")}</p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="intercompany-link-counterpart">{t("link.counterpart")}</Label>
            <Select
              id="intercompany-link-counterpart"
              value={counterpart}
              onChange={(event) => setCounterpart(event.target.value)}
              disabled={!canManage}
            >
              {candidates.map((candidate) => (
                <option key={candidate.documentId} value={candidate.documentId}>
                  {candidate.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="intercompany-link-reason">{t("link.reason")}</Label>
            <Textarea
              id="intercompany-link-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={!canManage}
              rows={3}
            />
          </div>
        </div>
      )}
    </UrlDrawer>
  );
}
