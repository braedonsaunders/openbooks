"use client";

import Link from "next/link";
import { ApiResponseError } from "@/lib/api-error";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useViewerFormat } from "../../../../../lib/viewer-format";
import { toast } from "sonner";
import { ReopenDecision } from "@/app/(app)/accounting/reopen-requests/ReopenDecision";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Textarea,
  UrlDrawer,
} from "@openbooks/ui";
import { ChevronRight } from "lucide-react";
import { SearchInput } from "../../../../../components/search-input";
import { Pagination } from "../../../../../components/pagination";
import { ReopenDecisionEvidence } from "../../../../../components/reopen-decision-evidence";
import { BASE, Field, MODULES, drawerHref, post } from "./close-setup-shared";
import type { Props, ReopenRow } from "./close-setup-types";

export function ReopenList(props: Props) {
  const t = useTranslations("close.setup");
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("periods.reopenRequests")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SearchInput paramKey="reopenQ" pageParamKey="reopenPage" />
          <Pagination
            basePath={BASE}
            currentParams={props.currentParams}
            total={props.reopenTotal}
            page={props.reopenPage}
            perPage={props.reopenPerPage}
            pageParamKey="reopenPage"
          />
        </div>
        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          {props.reopenRequests.map((item) => (
            <Link
              key={item.id}
              href={drawerHref(props.currentParams, "periods", "reopen", item.id)}
              className="flex items-center justify-between gap-3 py-3 text-sm hover:text-teal-700 dark:hover:text-teal-300"
            >
              <div>
                <span className="font-medium">{item.period_name}</span>
                <span className="text-slate-500">
                  {" "}
                  · {item.book_name} · {t(`modules.${item.modules?.[0] ?? "gl"}`)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    item.status === "approved"
                      ? "success"
                      : item.status === "requested"
                        ? "warning"
                        : "outline"
                  }
                >
                  {t(`reopenStates.${item.status}`)}
                </Badge>
                <ChevronRight size={16} />
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function ReopenDrawer({ row, props }: { row: ReopenRow; props: Props }) {
  const t = useTranslations("close.setup");
  const viewerFormat = useViewerFormat();
  const router = useRouter();
  const closeHref = drawerHref(props.currentParams, "periods", "reopen", null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [endReason, setEndReason] = useState("");
  const [extendReason, setExtendReason] = useState("");
  // Widening and extending are separate choices: no hours are added unless
  // the operator enters them.
  const [extendHours, setExtendHours] = useState("");
  const [extendModules, setExtendModules] = useState<string[]>([]);
  const includedModules = new Set(row.modules.map((module) => String(module)));
  async function endReopen() {
    if (endReason.trim().length < 10) {
      const message = t("periods.endReopenReasonRequired");
      setActionError(message);
      toast.error(message);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await post(
        { action: "reclose-reopen", requestId: row.id, reason: endReason.trim() },
        t("errors.actionFailed"),
      );
      toast.success(t("messages.reopenEnded"));
      router.push(closeHref);
      router.refresh();
    } catch (error) {
      const message = error instanceof ApiResponseError ? error.message : t("errors.actionFailed");
      setActionError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }
  async function extendReopen() {
    if (extendReason.trim().length < 10) {
      const message = t("periods.extendReopenReasonRequired");
      setActionError(message);
      toast.error(message);
      return;
    }
    const hours = Number(extendHours);
    setBusy(true);
    setActionError(null);
    try {
      const result = await post(
        {
          action: "extend-reopen",
          requestId: row.id,
          reason: extendReason.trim(),
          ...(Number.isInteger(hours) && hours >= 1 ? { additionalHours: hours } : {}),
          ...(extendModules.length > 0 ? { addModules: extendModules } : {}),
        },
        t("errors.actionFailed"),
      );
      toast.success(t("messages.reopenRequested"));
      router.push(
        typeof result.requestId === "string"
          ? drawerHref(props.currentParams, "periods", "reopen", result.requestId)
          : closeHref,
      );
      router.refresh();
    } catch (error) {
      const message = error instanceof ApiResponseError ? error.message : t("errors.actionFailed");
      setActionError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="md"
      title={t("periods.reopenTitle")}
      description={`${row.period_name} · ${row.book_name}`}
      footer={
        row.status === "requested" && props.canReopen ? (
          <ReopenDecision requestId={row.id} ownRequest={row.requested_by === props.viewerId} />
        ) : undefined
      }
    >
      <div className="space-y-4 p-1">
        {actionError ? (
          <p role="alert" className="text-sm text-red-600">
            {actionError}
          </p>
        ) : null}
        <div>
          <Label>{t("fields.reason")}</Label>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">{row.reason}</p>
        </div>
        <div>
          <Label>{t("periods.requestedBy", { name: row.requester_name })}</Label>
        </div>
        <ReopenDecisionEvidence
          source={{
            status: row.status,
            requestedById: row.requested_by,
            approvedById: row.approved_by,
            approvedByName: row.approver_name,
            decisionAction: row.decision_action,
            attestation: row.decision_attestation,
            endActorName: row.end_actor_name,
            endReason: row.end_reason,
          }}
        />
        <Badge
          variant={
            row.status === "approved"
              ? "success"
              : row.status === "requested"
                ? "warning"
                : "outline"
          }
        >
          {t(`reopenStates.${row.status}`)}
        </Badge>
        {row.status === "approved" && typeof row.expires_at === "string" ? (
          <p className="mt-1 text-sm text-slate-500">
            {t("periods.reopenActiveUntil", {
              date: viewerFormat.dateTime(new Date(row.expires_at)),
            })}
          </p>
        ) : null}
        {row.status === "requested" && row.impact_snapshot?.amendment ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {t("periods.reopenRequestedUntil", {
              date: viewerFormat.dateTime(new Date(row.impact_snapshot.amendment.expiresAt)),
            })}
          </p>
        ) : null}
        {row.status === "approved" && props.canReopen ? (
          <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <div>
              <h4 className="font-medium">{t("periods.endReopenTitle")}</h4>
              <p className="text-sm text-slate-500">{t("periods.endReopenHint")}</p>
            </div>
            <Field label={t("fields.reason")}>
              <Textarea value={endReason} onChange={(e) => setEndReason(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button
                variant="outline"
                disabled={busy || endReason.trim().length < 10}
                onClick={endReopen}
              >
                {t("actions.endReopen")}
              </Button>
            </div>
          </div>
        ) : null}
        {row.status === "approved" && props.canReopen ? (
          <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <div>
              <h4 className="font-medium">{t("periods.extendReopenTitle")}</h4>
              <p className="text-sm text-slate-500">{t("periods.extendReopenHint")}</p>
            </div>
            <Field label={t("periods.extendHoursLabel")}>
              <Input
                aria-label={t("periods.extendHoursLabel")}
                type="number"
                min={0}
                max={168}
                value={extendHours}
                onChange={(e) => setExtendHours(e.target.value)}
              />
            </Field>
            <div className="space-y-1">
              <Label>{t("periods.extendModulesLabel")}</Label>
              {MODULES.filter((module) => !includedModules.has(module)).map((module) => (
                <label key={module} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={extendModules.includes(module)}
                    onChange={(e) =>
                      setExtendModules((prev) =>
                        e.target.checked
                          ? [...prev, module]
                          : prev.filter((item) => item !== module),
                      )
                    }
                  />
                  {t(`modules.${module}`)}
                </label>
              ))}
            </div>
            <Field label={t("fields.reason")}>
              <Textarea
                value={extendReason}
                maxLength={500}
                onChange={(e) => setExtendReason(e.target.value)}
              />
            </Field>
            <div className="flex justify-end">
              <Button
                variant="outline"
                disabled={
                  busy ||
                  extendReason.trim().length < 10 ||
                  (!extendModules.length && Number(extendHours) === 0) ||
                  !Number.isInteger(Number(extendHours)) ||
                  Number(extendHours) < 0 ||
                  Number(extendHours) > 168
                }
                onClick={extendReopen}
              >
                {t("actions.extendReopen")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </UrlDrawer>
  );
}
