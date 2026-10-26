"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, MapPin, Phone } from "lucide-react";
import { Button, EmptyState, cn } from "@openbooks/ui";
import type { MyVisit, ServiceVisitDetail } from "@openbooks/engine/service/reads";
import { useDocumentHidden } from "../../lib/use-document-hidden";
import { serviceRequest } from "./api";
import { Refusal, VisitStatusBadge, useServiceFormat } from "./format";
import { ServiceVisitBody } from "./VisitDrawer";
import { useServiceRecord } from "./use-record";

const POLL_MS = 30_000;

function shift(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * A technician's own visits for a day, built for a phone: the day's route in
 * booking order, and the open visit's status buttons, parts, photos, sign-off
 * and completion one tap away. Re-reads while visible so dispatch changes
 * appear without a reload.
 */
export function MyVisits({
  today,
  initial,
  refusal: initialRefusal = null,
}: {
  today: string;
  initial: { personName: string; visits: MyVisit[] } | null;
  refusal?: { message: string; remedy: string | null } | null;
}) {
  const t = useTranslations("service.myVisits");
  const f = useServiceFormat();
  const hidden = useDocumentHidden();
  const [date, setDate] = useState(today);
  const [data, setData] = useState(initial ? { date: today, ...initial } : null);
  const [refusal, setRefusal] = useState<{ message: string; remedy: string | null } | null>(
    initialRefusal,
  );
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await serviceRequest<{ personName: string; visits: MyVisit[] }>(
        `/api/service/my-visits?from=${date}&through=${date}`,
        undefined,
        t("loadFailed"),
      );
      setData({ date, ...result });
      setRefusal(null);
    } catch (error) {
      setRefusal({
        message: error instanceof Error ? error.message : t("loadFailed"),
        remedy: null,
      });
    }
  }, [date, t]);

  useEffect(() => {
    if (hidden) return;
    const first = setTimeout(() => void load(), data?.date === date ? POLL_MS : 0);
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [hidden, load, data?.date, date]);

  const visits = data?.date === date ? data.visits : [];
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDate((current) => shift(current, -1))}
          aria-label={t("previous")}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDate(today)}
          disabled={date === today}
        >
          {t("today")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDate((current) => shift(current, 1))}
          aria-label={t("next")}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <span className="ml-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
          {f.date(date)}
        </span>
      </div>
      <Refusal refusal={refusal} />
      {data?.date !== date && !refusal ? (
        <p className="text-sm text-slate-500" aria-busy="true">
          {t("loading")}
        </p>
      ) : visits.length === 0 ? (
        <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : (
        <ol className="space-y-3">
          {visits.map((visit) => (
            <li
              key={visit.id}
              className={cn(
                "rounded-xl border bg-white shadow-sm dark:bg-slate-950",
                openId === visit.id ? "border-teal-400" : "border-slate-200 dark:border-slate-800",
              )}
            >
              <button
                type="button"
                className="w-full p-4 text-left"
                onClick={() => setOpenId((current) => (current === visit.id ? null : visit.id))}
                aria-expanded={openId === visit.id}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-base font-semibold text-slate-900 dark:text-slate-100">
                      {f.time(visit.startsAt)} · {visit.customerName}
                    </p>
                    <p className="truncate text-sm text-slate-600 dark:text-slate-300">
                      {visit.number} · {visit.title}
                    </p>
                  </div>
                  <VisitStatusBadge status={visit.status} />
                </div>
                {visit.address ? (
                  <p className="mt-1 flex items-center gap-1 text-sm text-slate-600 dark:text-slate-300">
                    <MapPin className="h-4 w-4 shrink-0" />
                    {visit.address}
                  </p>
                ) : null}
              </button>
              {visit.address || visit.contactPhone ? (
                <div className="flex gap-2 px-4 pb-3">
                  {visit.address ? (
                    <a
                      className="text-sm font-medium text-teal-700 dark:text-teal-300"
                      href={`https://maps.google.com/?q=${encodeURIComponent(visit.address)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("directions")}
                    </a>
                  ) : null}
                  {visit.contactPhone ? (
                    <a
                      className="inline-flex items-center gap-1 text-sm font-medium text-teal-700 dark:text-teal-300"
                      href={`tel:${visit.contactPhone}`}
                    >
                      <Phone className="h-4 w-4" />
                      {visit.contactName ?? visit.contactPhone}
                    </a>
                  ) : null}
                </div>
              ) : null}
              {openId === visit.id ? (
                <OpenVisit visitId={visit.id} onChanged={() => void load()} />
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function OpenVisit({ visitId, onChanged }: { visitId: string; onChanged: () => void }) {
  const t = useTranslations("service.myVisits");
  const record = useServiceRecord<ServiceVisitDetail>(
    `/api/service/visits/${visitId}`,
    t("loadFailed"),
  );
  return (
    <div className="border-t border-slate-200 p-4 dark:border-slate-800">
      {record.data ? (
        <ServiceVisitBody
          compact
          detail={record.data}
          reload={() => {
            record.reload();
            onChanged();
          }}
        />
      ) : record.error ? (
        <Refusal refusal={{ message: record.error, remedy: null }} />
      ) : (
        <p className="text-sm text-slate-500">{t("loading")}</p>
      )}
    </div>
  );
}
