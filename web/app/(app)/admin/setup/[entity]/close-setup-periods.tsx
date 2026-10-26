"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useViewerFormat } from "@/lib/viewer-format";
import {
  Badge,
  Button,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
import { ChevronRight, LockKeyhole, Plus } from "lucide-react";
import { SearchInput } from "../../../../../components/search-input";
import { Pagination } from "../../../../../components/pagination";
import { mergeHref, pickString } from "../../../../../lib/list-params";
import { PeriodDrawer } from "./close-setup-period-drawer";
import { ReopenDrawer, ReopenList } from "./close-setup-reopen";
import {
  BASE,
  EmptyList,
  Field,
  MODULES,
  SectionHeading,
  dataText,
  drawerHref,
} from "./close-setup-shared";
import type { Props } from "./close-setup-types";

export function PeriodsTab(props: Props) {
  const { number, civilDate } = useViewerFormat();
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const router = useRouter();
  const selected = pickString(props.currentParams.period);
  const reopenId = pickString(props.currentParams.reopen);
  const period =
    selected && selected !== "new" ? props.periods.find((item) => item.id === selected) : undefined;
  const reopen = reopenId
    ? ((props.liveReopenRequests ?? []).find((item) => item.id === reopenId) ??
      props.reopenRequests.find((item) => item.id === reopenId))
    : undefined;
  return (
    <div className="space-y-5">
      <SectionHeading
        icon={<LockKeyhole size={18} />}
        title={t("periods.title")}
        description={t("periods.description")}
        action={
          <Button size="sm" asChild>
            <Link href={drawerHref(props.currentParams, "periods", "period", "new")}>
              <Plus size={14} />
              {t("actions.generate")}
            </Link>
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <SearchInput
          paramKey="periodQ"
          pageParamKey="periodPage"
          placeholder={t("periods.searchPlaceholder")}
        />
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("fields.book")}>
            {props.books.length > 1 ? (
              <Select
                className="h-9 w-44"
                value={props.selectedBookId}
                onChange={(e) =>
                  router.push(
                    mergeHref(BASE, props.currentParams, {
                      tab: "periods",
                      book: e.target.value,
                      periodPage: 1,
                    }),
                  )
                }
              >
                {props.books.map((book) => (
                  <option key={book.id} value={book.id}>
                    {book.name}
                  </option>
                ))}
              </Select>
            ) : (
              <div className="flex h-9 w-44 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
                {props.books[0]?.name ?? "—"}
              </div>
            )}
          </Field>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/setup/accounting-books">{t("actions.manageBooks")}</Link>
          </Button>
          <Field label={t("fields.fiscalYear")}>
            <Input
              className="h-9 w-28"
              type="number"
              value={props.fiscalYear}
              onChange={(e) =>
                router.push(
                  mergeHref(BASE, props.currentParams, {
                    tab: "periods",
                    fy: e.target.value,
                    periodPage: 1,
                  }),
                )
              }
            />
          </Field>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("table.period")}</TableHead>
                <TableHead>{t("table.range")}</TableHead>
                <TableHead className="text-right">{t("table.entries")}</TableHead>
                <TableHead>{t("table.status")}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.periods.map((item) => {
                const states = MODULES.map((module) => item.locks?.[module]?.state ?? "open");
                const closed = states.filter((state) => state === "closed").length;
                const soft = states.filter((state) => state === "soft_closed").length;
                const overall =
                  closed === MODULES.length
                    ? "closed"
                    : soft > 0
                      ? "soft_closed"
                      : closed > 0
                        ? "partial"
                        : "open";
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="font-medium">{item.name}</div>
                      <div className="text-xs text-slate-500">
                        {dataText(td, item.calendar_name)}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-slate-500">
                      {civilDate(item.starts_on)} → {civilDate(item.ends_on)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {number(Number(item.entries))}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            overall === "closed"
                              ? "success"
                              : overall === "soft_closed" || overall === "partial"
                                ? "warning"
                                : "outline"
                          }
                        >
                          {t(`states.${overall}`)}
                        </Badge>
                        <span className="hidden text-xs text-slate-500 lg:inline">
                          {t("periods.moduleSummary", {
                            closed,
                            total: MODULES.length,
                          })}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" asChild>
                        <Link
                          href={drawerHref(props.currentParams, "periods", "period", item.id)}
                          aria-label={t("actions.managePeriod", {
                            period: item.name,
                          })}
                        >
                          <ChevronRight size={16} />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <Pagination
          basePath={BASE}
          currentParams={props.currentParams}
          total={props.periodTotal}
          page={props.periodPage}
          perPage={props.periodPerPage}
          pageParamKey="periodPage"
        />
      </div>
      {props.periods.length === 0 ? <EmptyList>{t("empty.periods")}</EmptyList> : null}
      {props.reopenTotal > 0 || pickString(props.currentParams.reopenQ) ? (
        <ReopenList {...props} />
      ) : null}
      {selected ? (
        <PeriodDrawer key={`${selected}-${props.selectedBookId}`} row={period} props={props} />
      ) : null}
      {reopenId && reopen ? <ReopenDrawer key={reopenId} row={reopen} props={props} /> : null}
    </div>
  );
}
