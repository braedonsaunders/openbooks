"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  UrlDrawer,
} from "@openbooks/ui";
import { SearchInput } from "../../../../../components/search-input";
import { Pagination } from "../../../../../components/pagination";
import { mergeHref } from "../../../../../lib/list-params";

export interface BillCardRow {
  id: string;
  rate_book_id: string;
  code: string;
  name: string;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  status: string;
  derivation_policy: string;
  is_latest: boolean;
  line_count: number;
  assignment_count: number;
}

export interface BillCardDetail extends BillCardRow {
  scopes: {
    id: string;
    scopeType: string;
    scopeValueId: string | null;
    scopeValueText: string | null;
    includeChildren: boolean;
  }[];
  adjustments: {
    id: string;
    itemId: string | null;
    code: string;
    name: string;
    category: string;
    calculation: string;
    value: string | null;
    unit: string | null;
    presentation: string;
    threshold: string | null;
    thresholdUnit: string | null;
    referenceText: string | null;
  }[];
  terms: {
    id: string;
    code: string;
    label: string;
    content: string;
    placement: string;
  }[];
  lines: {
    id: string;
    itemId: string;
    itemName: string;
    regular: string | null;
    timeTypeRates: Record<string, string>;
  }[];
}

function amount(value: string | null, currency: string): string {
  if (value == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      currencyDisplay: "code",
    }).format(Number(value));
  } catch {
    return `${currency} ${value}`;
  }
}

export function LaborBillRateCards(props: {
  cards: BillCardRow[];
  selected: BillCardDetail | null;
  creating: boolean;
  total: number;
  page: number;
  perPage: number;
  currentParams: Record<string, string | string[] | undefined>;
  laborItems: { id: string; name: string }[];
  timeTypes: { id: string; name: string; bill_multiplier: string }[];
}) {
  const t = useTranslations("admin.setup.laborCosting.billing");
  const common = useTranslations("common");
  const router = useRouter();
  const base = "/admin/setup/labor-costing";
  const closeHref = mergeHref(base, props.currentParams, { card: undefined });
  const newHref = mergeHref(base, props.currentParams, {
    card: "new",
    rate: undefined,
    guide: undefined,
  });
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t("title")}
        </h3>
        <p className="mt-0.5 max-w-4xl text-xs text-slate-500 dark:text-slate-400">
          {t("hint")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={t("search")} />
        <Button asChild size="sm" className="ml-auto">
          <Link href={newHref as never}>
            <Plus size={14} />
            {t("add")}
          </Link>
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("card")}</TableHead>
              <TableHead>{t("currency")}</TableHead>
              <TableHead>{t("period")}</TableHead>
              <TableHead className="text-right">{t("items")}</TableHead>
              <TableHead className="text-right">{t("assignments")}</TableHead>
              <TableHead>{t("status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.cards.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-10 text-center text-slate-500"
                >
                  {t("empty")}
                </TableCell>
              </TableRow>
            ) : null}
            {props.cards.map((card) => {
              const href = mergeHref(base, props.currentParams, {
                card: card.id,
                rate: undefined,
                guide: undefined,
              });
              return (
                <TableRow
                  key={card.id}
                  className="cursor-pointer"
                  onClick={() => router.push(href)}
                >
                  <TableCell>
                    <Link
                      href={href as never}
                      onClick={(e) => e.stopPropagation()}
                      className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {card.name}
                    </Link>
                    <div className="font-mono text-xs text-slate-400">
                      {card.code}
                    </div>
                  </TableCell>
                  <TableCell>{card.currency}</TableCell>
                  <TableCell className="tabular-nums">
                    {card.effective_from} – {card.effective_to ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {card.line_count}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {card.assignment_count}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        card.status === "active" ? "success" : "secondary"
                      }
                    >
                      {common(
                        card.status === "retired"
                          ? "status.inactive"
                          : `status.${card.status}`,
                      )}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {props.total > 0 ? (
          <Pagination
            basePath={base}
            currentParams={props.currentParams}
            total={props.total}
            page={props.page}
            perPage={props.perPage}
          />
        ) : null}
      </div>
      {props.selected || props.creating ? (
        <UrlDrawer
          open
          closeHref={closeHref}
          title={props.creating ? t("newTitle") : props.selected!.name}
          description={
            props.creating
              ? t("newDescription")
              : `${props.selected!.code} · ${props.selected!.currency}`
          }
        >
          {props.creating ? (
            <div className="rounded-lg border border-dashed border-slate-300 p-5 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">
              {t("createInItemHint")}
              <div className="mt-3">
                <Button asChild>
                  <Link href="/items?view=rate-books">
                    {t("openRateBooks")}
                  </Link>
                </Button>
              </div>
            </div>
          ) : (
            <CardDetail
              card={props.selected!}
              timeTypes={props.timeTypes}
              laborItems={props.laborItems}
              t={t}
              common={common}
              onSaved={(id) =>
                router.push(mergeHref(base, props.currentParams, { card: id }))
              }
            />
          )}
        </UrlDrawer>
      ) : null}
    </section>
  );
}

function CardDetail({
  card,
  timeTypes,
  laborItems,
  t,
  common,
  onSaved,
}: {
  card: BillCardDetail;
  timeTypes: { id: string; name: string; bill_multiplier: string }[];
  laborItems: { id: string; name: string }[];
  t: ReturnType<typeof useTranslations>;
  common: ReturnType<typeof useTranslations>;
  onSaved: (id: string) => void;
}) {
  const [revising, setRevising] = useState(false);
  return (
    <div className="space-y-5 p-1">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <Info label={t("effectiveFrom")} value={card.effective_from} />
        <Info label={t("effectiveTo")} value={card.effective_to ?? "—"} />
        <Info
          label={t("derivation")}
          value={t(`derivations.${card.derivation_policy}`)}
        />
        <Info
          label={t("status")}
          value={common(
            card.status === "retired"
              ? "status.inactive"
              : `status.${card.status}`,
          )}
        />
      </div>
      <Section title={t("scopes")}>
        {card.scopes.length ? (
          card.scopes.map((s) => (
            <div
              key={s.id}
              className="rounded-md bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800"
            >
              {t(`scopeTypes.${s.scopeType}`)} ·{" "}
              {s.scopeValueText ?? s.scopeValueId}
            </div>
          ))
        ) : (
          <Empty text={t("allScopes")} />
        )}
      </Section>
      <Section title={t("itemRates")}>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("item")}</TableHead>
                <TableHead className="text-right">{t("regular")}</TableHead>
                {timeTypes
                  .filter((x) => Number(x.bill_multiplier) !== 1)
                  .map((tt) => (
                    <TableHead key={tt.id} className="text-right">
                      {tt.name}
                    </TableHead>
                  ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {card.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.itemName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {amount(l.regular, card.currency)}
                  </TableCell>
                  {timeTypes
                    .filter((x) => Number(x.bill_multiplier) !== 1)
                    .map((tt) => (
                      <TableCell
                        key={tt.id}
                        className="text-right tabular-nums"
                      >
                        {amount(
                          l.timeTypeRates?.[tt.id] ?? null,
                          card.currency,
                        )}
                      </TableCell>
                    ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>
      <Section title={t("adjustments")}>
        {card.adjustments.length ? (
          card.adjustments.map((a) => (
            <div
              key={a.id}
              className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium text-slate-900 dark:text-slate-100">
                    {a.name}
                  </div>
                  <div className="text-xs text-slate-500">
                    {t("appliesTo")}:{" "}
                    {a.itemId
                      ? (laborItems.find((i) => i.id === a.itemId)?.name ??
                        a.itemId)
                      : t("wholeCard")}
                  </div>
                </div>
                <Badge variant="outline">{t(`categories.${a.category}`)}</Badge>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {t(`calculations.${a.calculation}`)}
                {a.value != null ? ` · ${a.value}` : ""}
                {a.unit ? ` ${a.unit}` : ""} ·{" "}
                {t(`presentations.${a.presentation}`)}
              </div>
              {a.referenceText ? (
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                  {a.referenceText}
                </p>
              ) : null}
            </div>
          ))
        ) : (
          <Empty text={t("none")} />
        )}
      </Section>
      <Section title={t("terms")}>
        {card.terms.length ? (
          card.terms.map((term) => (
            <div key={term.id}>
              <div className="text-xs font-medium text-slate-500">
                {term.label}
              </div>
              <div className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-200">
                {term.content}
              </div>
            </div>
          ))
        ) : (
          <Empty text={t("none")} />
        )}
      </Section>
      {revising ? (
        <RevisionEditor
          card={card}
          laborItems={laborItems}
          t={t}
          onCancel={() => setRevising(false)}
          onSaved={onSaved}
        />
      ) : card.is_latest ? (
        <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
          <Button variant="outline" onClick={() => setRevising(true)}>
            {t("revise")}
          </Button>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t("reviseHint")}
          </p>
        </div>
      ) : (
        <p className="border-t border-slate-200 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {t("historicalHint")}
        </p>
      )}
    </div>
  );
}

type AdjustmentDraft = {
  itemId: string;
  code: string;
  name: string;
  category: string;
  calculation: string;
  value: string;
  unit: string;
  presentation: string;
  referenceText: string;
};
const blankAdjustment = (): AdjustmentDraft => ({
  itemId: "",
  code: "",
  name: "",
  category: "surcharge",
  calculation: "percent",
  value: "0",
  unit: "",
  presentation: "separate",
  referenceText: "",
});
function nextRevisionDate(date: string): string {
  const tomorrow = new Date(`${date}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const today = new Date().toISOString().slice(0, 10);
  return tomorrow.toISOString().slice(0, 10) > today
    ? tomorrow.toISOString().slice(0, 10)
    : today;
}
function RevisionEditor({
  card,
  laborItems,
  t,
  onCancel,
  onSaved,
}: {
  card: BillCardDetail;
  laborItems: { id: string; name: string }[];
  t: ReturnType<typeof useTranslations>;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const [effectiveFrom, setEffectiveFrom] = useState(
    nextRevisionDate(card.effective_from),
  );
  const [adjustments, setAdjustments] = useState<AdjustmentDraft[]>(
    card.adjustments.map((a) => ({
      itemId: a.itemId ?? "",
      code: a.code,
      name: a.name,
      category: a.category,
      calculation: a.calculation,
      value: a.value ?? "",
      unit: a.unit ?? "",
      presentation: a.presentation,
      referenceText: a.referenceText ?? "",
    })),
  );
  const [busy, setBusy] = useState(false);
  const common = useTranslations("common");
  const setAdjustment = (index: number, patch: Partial<AdjustmentDraft>) =>
    setAdjustments((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  async function save() {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/labor-rate-cards/${card.id}/revisions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ effectiveFrom, adjustments }),
        },
      );
      const result = (await response.json()) as {
        id?: string;
        errorCode?: string;
      };
      if (!response.ok || !result.id) {
        toast.error(t(`errors.${result.errorCode ?? "save"}`));
        return;
      }
      toast.success(t("revisionSaved"));
      onSaved(result.id);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800">
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t("revisionTitle")}
        </h4>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t("revisionDescription")}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="bill-card-revision-date">
          {t("revisionEffectiveFrom")}
        </Label>
        <Input
          id="bill-card-revision-date"
          type="date"
          min={nextRevisionDate(card.effective_from)}
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
        />
      </div>
      <div className="space-y-3">
        {adjustments.map((adjustment, index) => (
          <div
            key={index}
            className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
          >
            <div className="flex items-center justify-between gap-3">
              <h5 className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {t("adjustmentNumber", { number: index + 1 })}
              </h5>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("removeAdjustment")}
                onClick={() =>
                  setAdjustments((rows) => rows.filter((_, i) => i !== index))
                }
              >
                <Trash2 size={14} />
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>{t("adjustmentName")}</Label>
                <Input
                  aria-label={t("adjustmentName")}
                  value={adjustment.name}
                  onChange={(e) =>
                    setAdjustment(index, { name: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>{t("adjustmentCode")}</Label>
                <Input
                  aria-label={t("adjustmentCode")}
                  value={adjustment.code}
                  onChange={(e) =>
                    setAdjustment(index, { code: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t("appliesTo")}</Label>
              <Select
                aria-label={t("appliesTo")}
                value={adjustment.itemId}
                onChange={(e) =>
                  setAdjustment(index, { itemId: e.target.value })
                }
              >
                <option value="">{t("wholeCard")}</option>
                {laborItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label>{t("category")}</Label>
                <Select
                  aria-label={t("category")}
                  value={adjustment.category}
                  onChange={(e) =>
                    setAdjustment(index, { category: e.target.value })
                  }
                >
                  {[
                    "markup",
                    "travel",
                    "allowance",
                    "minimum",
                    "surcharge",
                    "other",
                  ].map((value) => (
                    <option key={value} value={value}>
                      {t(`categories.${value}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t("calculation")}</Label>
                <Select
                  aria-label={t("calculation")}
                  value={adjustment.calculation}
                  onChange={(e) =>
                    setAdjustment(index, { calculation: e.target.value })
                  }
                >
                  {[
                    "percent",
                    "fixed",
                    "per_hour",
                    "per_day",
                    "distance",
                    "time",
                    "text",
                  ].map((value) => (
                    <option key={value} value={value}>
                      {t(`calculations.${value}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t("presentation")}</Label>
                <Select
                  aria-label={t("presentation")}
                  value={adjustment.presentation}
                  onChange={(e) =>
                    setAdjustment(index, { presentation: e.target.value })
                  }
                >
                  {["included", "separate", "informational"].map((value) => (
                    <option key={value} value={value}>
                      {t(`presentations.${value}`)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            {adjustment.calculation !== "text" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>{t("adjustmentValue")}</Label>
                  <Input
                    aria-label={t("adjustmentValue")}
                    inputMode="decimal"
                    value={adjustment.value}
                    onChange={(e) =>
                      setAdjustment(index, { value: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t("adjustmentUnit")}</Label>
                  <Input
                    aria-label={t("adjustmentUnit")}
                    value={adjustment.unit}
                    onChange={(e) =>
                      setAdjustment(index, { unit: e.target.value })
                    }
                  />
                </div>
              </div>
            ) : null}
            <div className="space-y-1">
              <Label>{t("referenceText")}</Label>
              <Textarea
                aria-label={t("referenceText")}
                rows={2}
                value={adjustment.referenceText}
                onChange={(e) =>
                  setAdjustment(index, { referenceText: e.target.value })
                }
              />
            </div>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAdjustments((rows) => [...rows, blankAdjustment()])}
        >
          <Plus size={14} />
          {t("addAdjustment")}
        </Button>
      </div>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={save}>
          {busy ? common("actions.saving") : t("saveRevision")}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          {common("actions.cancel")}
        </Button>
      </div>
    </section>
  );
}
function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="font-medium text-slate-900 dark:text-slate-100">
        {value}
      </div>
    </div>
  );
}
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </h4>
      {children}
    </section>
  );
}
function Empty({ text }: { text: string }) {
  return <p className="text-sm text-slate-500 dark:text-slate-400">{text}</p>;
}
