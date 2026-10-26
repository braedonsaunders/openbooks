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
  Select,
  Textarea,
  UrlDrawer,
} from "@openbooks/ui";
import { CalendarDays, ChevronRight, Plus } from "lucide-react";
import { pickString } from "../../../../../lib/list-params";
import {
  Check,
  ConfigListControls,
  EmptyList,
  Field,
  RowLink,
  SectionHeading,
  dataText,
  drawerHref,
  post,
} from "./close-setup-shared";
import type { CalendarDraft, CalendarRow, Props } from "./close-setup-types";
import { DateField } from "@/components/date-field";

export function CalendarsTab(props: Props) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const selected = pickString(props.currentParams.calendar);
  const row =
    selected && selected !== "new"
      ? props.calendars.find((item) => item.id === selected)
      : undefined;
  return (
    <div className="space-y-4">
      <SectionHeading
        icon={<CalendarDays size={18} />}
        title={t("calendars.title")}
        description={t("calendars.description")}
        action={
          <Button size="sm" asChild>
            <Link href={drawerHref(props.currentParams, "calendars", "calendar", "new")}>
              <Plus size={14} />
              {t("actions.newCalendar")}
            </Link>
          </Button>
        }
      />
      <ConfigListControls
        listKey="calendar"
        list={props.configLists.calendar}
        currentParams={props.currentParams}
        perPage={props.configPerPage}
      />
      <div className="grid gap-3 md:grid-cols-2">
        {props.calendars.map((item) => (
          <RowLink
            key={item.id}
            href={drawerHref(props.currentParams, "calendars", "calendar", item.id)}
          >
            <CardHeader className="p-4">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">{dataText(td, item.name)}</CardTitle>
                <div className="flex gap-1">
                  {item.is_default ? <Badge variant="success">{t("labels.default")}</Badge> : null}
                  {!item.is_active ? <Badge variant="outline">{t("labels.inactive")}</Badge> : null}
                  <ChevronRight size={16} className="text-slate-400" />
                </div>
              </div>
              <CardDescription>
                {t(`cadences.${item.cadence}`)} ·{" "}
                {t("calendars.startsMonth", { month: item.year_start_month })}
              </CardDescription>
            </CardHeader>
          </RowLink>
        ))}
      </div>
      {props.calendars.length === 0 ? <EmptyList>{t("empty.calendars")}</EmptyList> : null}
      {selected ? <CalendarDrawer key={selected} row={row} params={props.currentParams} /> : null}
    </div>
  );
}

export function CalendarDrawer({
  row,
  params,
}: {
  row?: CalendarRow;
  params: Props["currentParams"];
}) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const router = useRouter();
  const closeHref = drawerHref(params, "calendars", "calendar", null);
  const [draft, setDraft] = useState<CalendarDraft>(
    row
      ? {
          id: row.id,
          name: dataText(td, row.name),
          cadence: row.cadence,
          yearStartMonth: row.year_start_month,
          weekStartsOn: row.week_starts_on,
          timeZone: row.time_zone,
          adjustmentPeriodEnabled: row.adjustment_period_enabled,
          isDefault: row.is_default,
          isActive: row.is_active,
          anchorDate: row.anchor_date ?? "",
          configText: JSON.stringify(row.config ?? {}, null, 2),
        }
      : {
          name: "",
          cadence: "monthly",
          yearStartMonth: 1,
          weekStartsOn: 1,
          timeZone: "UTC",
          adjustmentPeriodEnabled: false,
          isDefault: false,
          isActive: true,
          anchorDate: "",
          configText: "{}",
        },
  );
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await post(
        {
          action: "save-calendar",
          ...draft,
          config: JSON.parse(draft.configText || "{}"),
        },
        t("errors.actionFailed"),
      );
      toast.success(t("messages.calendarSaved"));
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
      title={row ? t("calendars.editTitle") : t("calendars.newTitle")}
      description={t("calendars.formDescription")}
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
        <Field label={t("fields.name")}>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("fields.cadence")}>
            <Select
              value={draft.cadence}
              onChange={(e) => setDraft({ ...draft, cadence: e.target.value })}
            >
              {[
                "monthly",
                "four_four_five",
                "four_five_four",
                "five_four_four",
                "thirteen_period",
                "custom",
              ].map((value) => (
                <option key={value} value={value}>
                  {t(`cadences.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("fields.yearStartMonth")}>
            <Input
              type="number"
              min={1}
              max={12}
              value={draft.yearStartMonth}
              onChange={(e) => setDraft({ ...draft, yearStartMonth: Number(e.target.value) })}
            />
          </Field>
          <Field label={t("fields.weekStartsOn")}>
            <Select
              value={draft.weekStartsOn}
              onChange={(e) => setDraft({ ...draft, weekStartsOn: Number(e.target.value) })}
            >
              {[0, 1, 2, 3, 4, 5, 6].map((value) => (
                <option key={value} value={value}>
                  {t(`weekdays.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("fields.timeZone")}>
            <Input
              value={draft.timeZone}
              onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })}
            />
          </Field>
        </div>
        {draft.cadence !== "monthly" && draft.cadence !== "custom" ? (
          <Field label={t("fields.anchorDate")} hint={t("calendars.anchorHint")}>
            <DateField
              value={draft.anchorDate}
              onChange={(value) => setDraft({ ...draft, anchorDate: value })}
            />
          </Field>
        ) : null}
        <Field label={t("fields.configuration")} hint={t("calendars.configurationHint")}>
          <Textarea
            className="font-mono text-xs"
            rows={6}
            value={draft.configText}
            onChange={(e) => setDraft({ ...draft, configText: e.target.value })}
          />
        </Field>
        <div className="space-y-2">
          <Check
            checked={draft.adjustmentPeriodEnabled}
            onChange={(value) => setDraft({ ...draft, adjustmentPeriodEnabled: value })}
          >
            {t("fields.adjustmentPeriod")}
          </Check>
          <Check
            checked={draft.isDefault}
            onChange={(value) => setDraft({ ...draft, isDefault: value })}
          >
            {t("fields.defaultCalendar")}
          </Check>
          <Check
            checked={draft.isActive}
            onChange={(value) => setDraft({ ...draft, isActive: value })}
          >
            {t("fields.active")}
          </Check>
        </div>
      </div>
    </UrlDrawer>
  );
}
