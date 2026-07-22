"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  defaultFormLayout,
  type FormLayoutConfig,
  type HeaderFieldPlacement,
} from "@openbooks/customization";
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
} from "@openbooks/ui";
import { TransactionDrawer } from "../../../../../components/transaction-drawer";
import { HeaderFields } from "../../../../../components/transaction-form/header-fields";
import { CustomFieldInput } from "../../../../../components/custom-field-input";
import type { CustomFieldDefClient } from "../../../../../components/custom-field-inputs";
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
  line_count: number;
  assignment_count: number;
}

export interface ApplicabilityTarget {
  id?: string;
  targetType: string;
  targetValueId: string | null;
  targetValueText: string | null;
  targetLabel?: string | null;
  includeChildren: boolean;
}

export interface BillCardDetail extends BillCardRow {
  custom: Record<string, unknown>;
  scopes: {
    id?: string;
    scopeType: string;
    scopeValueId: string | null;
    scopeValueText: string | null;
    scopeLabel?: string | null;
    includeChildren: boolean;
  }[];
  adjustments: {
    id?: string;
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
    targets: ApplicabilityTarget[];
  }[];
  terms: {
    id?: string;
    code: string;
    label: string;
    content: string;
    placement: string;
  }[];
  lines: {
    id?: string;
    itemId: string;
    itemName: string;
    regular: string | null;
    timeTypeRates: Record<string, string>;
  }[];
}

type NamedOption = { id: string; name: string };
type OptionMap = Record<string, NamedOption[]>;
type ItemOption = NamedOption & { kind: string; category: string | null };
type FormOption = { id: string; name: string };

const TARGET_TYPES = [
  "item",
  "item_kind",
  "item_category",
  "transaction_type",
  "department",
  "subsidiary",
  "location",
  "class",
  "trade",
  "job_title",
  "project",
  "customer",
  "other",
] as const;
const SCOPE_TYPES = [
  "department",
  "subsidiary",
  "location",
  "class",
  "trade",
  "job_title",
  "other",
] as const;
const TEXT_TARGETS = new Set([
  "item_kind",
  "item_category",
  "transaction_type",
  "job_title",
  "other",
]);

function amount(value: string | null, currency: string): string {
  if (value == null || value === "") return "—";
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

function cloneCard(card: BillCardDetail): BillCardDetail {
  return JSON.parse(JSON.stringify(card)) as BillCardDetail;
}

export function LaborBillRateCards(props: {
  cards: BillCardRow[];
  selected: BillCardDetail | null;
  creating: boolean;
  total: number;
  page: number;
  perPage: number;
  currentParams: Record<string, string | string[] | undefined>;
  items: ItemOption[];
  timeTypes: { id: string; name: string; bill_multiplier: string }[];
  options: OptionMap;
  currencies: string[];
  layout?: FormLayoutConfig;
  forms: FormOption[];
  currentFormId: string | null;
  customFieldDefs: CustomFieldDefClient[];
  canCustomize: boolean;
}) {
  const t = useTranslations("laborPricing");
  const common = useTranslations("common");
  const router = useRouter();
  const [creatingCard, setCreatingCard] = useState(false);
  const base = "/admin/setup/labor-pricing";
  const closeHref = mergeHref(base, props.currentParams, {
    card: undefined,
    form: undefined,
    transactionTab: undefined,
  });
  async function createCard() {
    setCreatingCard(true);
    try {
      const response = await fetch("/api/labor-rate-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: t("newTitle"),
          currency: props.currencies[0] ?? "CAD",
        }),
      });
      const result = (await response.json()) as {
        id?: string;
        errorCode?: string;
      };
      if (!response.ok || !result.id) {
        toast.error(t(`errors.${result.errorCode ?? "save"}`));
        return;
      }
      router.push(
        mergeHref(base, props.currentParams, {
          card: result.id,
          form: undefined,
        }),
      );
      router.refresh();
    } finally {
      setCreatingCard(false);
    }
  }
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput placeholder={t("search")} />
        <Button
          size="sm"
          className="ml-auto"
          disabled={creatingCard}
          onClick={createCard}
        >
          <Plus size={14} />
          {t("add")}
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
                form: undefined,
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
      {props.selected ? (
        <RateCardDrawer
          key={`${props.selected.id}:${props.currentFormId ?? "default"}`}
          {...props}
          card={props.selected}
          closeHref={closeHref}
        />
      ) : null}
    </section>
  );
}

function RateCardDrawer(
  props: Omit<
    Parameters<typeof LaborBillRateCards>[0],
    "selected" | "cards" | "creating" | "total" | "page" | "perPage"
  > & { card: BillCardDetail; closeHref: string },
) {
  const { card } = props;
  const t = useTranslations("laborPricing");
  const common = useTranslations("common");
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(() => cloneCard(card));
  const layout = props.layout ?? defaultFormLayout("labor_rate_card");
  const itemOptions = props.items.map((x) => ({ id: x.id, name: x.name }));
  const optionMap = useMemo(
    () => ({ ...props.options, item: itemOptions }),
    [props.options, props.items],
  );
  const update = <K extends keyof BillCardDetail>(
    key: K,
    value: BillCardDetail[K],
  ) => setDraft((row) => ({ ...row, [key]: value }));

  async function save() {
    setBusy(true);
    try {
      const response = await fetch(`/api/labor-rate-cards/${card.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const result = (await response.json()) as { errorCode?: string };
      if (!response.ok) {
        toast.error(t(`errors.${result.errorCode ?? "save"}`));
        return;
      }
      toast.success(t("saved"));
      setEditing(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const actions = (
    <>
      {props.forms.map((form) => (
        <Button key={form.id} asChild variant="ghost" size="sm">
          <Link
            href={
              mergeHref("/admin/setup/labor-pricing", props.currentParams, {
                card: card.id,
                form: form.id,
              }) as never
            }
          >
            {form.id === props.currentFormId ? `${form.name} ✓` : form.name}
          </Link>
        </Button>
      ))}
      {props.canCustomize ? (
        <Button asChild variant="ghost" size="sm">
          <Link
            href={`/admin/customization?recordType=labor_rate_card&tab=forms${props.currentFormId ? `&form=${props.currentFormId}` : ""}`}
          >
            {common("actions.customize")}
          </Link>
        </Button>
      ) : null}
    </>
  );

  return (
    <TransactionDrawer
      closeHref={props.closeHref}
      recordId={card.id}
      targetTable="item_rate_versions"
      canEditAttachments
      title={card.name}
      description={`${card.code} · ${card.currency}`}
      primaryAction={
        !editing ? (
          <Button size="sm" onClick={() => setEditing(true)}>
            {common("actions.edit")}
          </Button>
        ) : undefined
      }
      actions={actions}
      footer={
        editing ? (
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDraft(cloneCard(card));
                setEditing(false);
              }}
            >
              {common("actions.cancel")}
            </Button>
            <Button disabled={busy} onClick={save}>
              {busy ? common("actions.saving") : common("actions.save")}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-6 p-1">
        <HeaderFields
          layout={layout}
          editable={editing}
          renderField={(placement, editable) =>
            renderHeaderField({
              placement,
              editable,
              draft,
              setDraft,
              props,
              t,
              common,
            })
          }
        />
        <ScopeSection
          draft={draft}
          setDraft={setDraft}
          options={props.options}
          editing={editing}
          t={t}
        />
        <LineSection
          draft={draft}
          setDraft={setDraft}
          items={props.items}
          timeTypes={props.timeTypes}
          editing={editing}
          layout={layout}
          t={t}
        />
        <AdjustmentSection
          draft={draft}
          setDraft={setDraft}
          options={optionMap}
          editing={editing}
          t={t}
        />
        <TermsSection
          draft={draft}
          setDraft={setDraft}
          editing={editing}
          t={t}
        />
      </div>
    </TransactionDrawer>
  );
}

function renderHeaderField(args: {
  placement: HeaderFieldPlacement;
  editable: boolean;
  draft: BillCardDetail;
  setDraft: React.Dispatch<React.SetStateAction<BillCardDetail>>;
  props: { currencies: string[]; customFieldDefs: CustomFieldDefClient[] };
  t: ReturnType<typeof useTranslations>;
  common: ReturnType<typeof useTranslations>;
}) {
  const { placement, editable, draft, setDraft, props, t, common } = args;
  const customKey = placement.key.startsWith("cf_")
    ? placement.key.slice(3)
    : null;
  if (customKey) {
    const def = props.customFieldDefs.find((x) => x.key === customKey);
    if (!def) return null;
    return (
      <CustomFieldInput
        def={def}
        value={draft.custom?.[customKey]}
        readOnly={!editable}
        onChange={(value) =>
          setDraft((row) => ({
            ...row,
            custom: { ...row.custom, [customKey]: value },
          }))
        }
      />
    );
  }
  const labels: Record<string, string> = {
    name: t("name"),
    code: t("adjustmentCode"),
    currency: t("currency"),
    effective_from: t("effectiveFrom"),
    effective_to: t("effectiveTo"),
    status: t("status"),
    derivation_policy: t("derivation"),
  };
  const label =
    placement.labelOverride || labels[placement.key] || placement.key;
  const value =
    placement.key === "effective_from"
      ? draft.effective_from
      : placement.key === "effective_to"
        ? (draft.effective_to ?? "")
        : placement.key === "derivation_policy"
          ? draft.derivation_policy
          : placement.key === "rate_book_id"
            ? draft.rate_book_id
            : String(
                (draft as unknown as Record<string, unknown>)[placement.key] ??
                  "",
              );
  const set = (v: string) =>
    setDraft((row) => ({
      ...row,
      [placement.key === "effective_from"
        ? "effective_from"
        : placement.key === "effective_to"
          ? "effective_to"
          : placement.key === "derivation_policy"
            ? "derivation_policy"
            : placement.key]: v || null,
    }));
  if (!editable)
    return (
      <Info
        label={label}
        value={
          placement.key === "status"
            ? common(
                draft.status === "retired"
                  ? "status.inactive"
                  : `status.${draft.status}`,
              )
            : placement.key === "derivation_policy"
              ? t(`derivations.${draft.derivation_policy}`)
              : value || "—"
        }
      />
    );
  return (
    <div className="space-y-1">
      <Label>
        {label}
        {placement.required ? <span className="text-red-500"> *</span> : null}
      </Label>
      {placement.key === "currency" ? (
        <Select value={value} onChange={(e) => set(e.target.value)}>
          {props.currencies.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </Select>
      ) : placement.key === "status" ? (
        <Select value={value} onChange={(e) => set(e.target.value)}>
          {["draft", "active", "retired"].map((x) => (
            <option key={x} value={x}>
              {common(x === "retired" ? "status.inactive" : `status.${x}`)}
            </option>
          ))}
        </Select>
      ) : placement.key === "derivation_policy" ? (
        <Select value={value} onChange={(e) => set(e.target.value)}>
          {["explicit", "time_type_multipliers"].map((x) => (
            <option key={x} value={x}>
              {t(`derivations.${x}`)}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          type={placement.key.startsWith("effective_") ? "date" : "text"}
          value={value}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </div>
  );
}

function ScopeSection({
  draft,
  setDraft,
  options,
  editing,
  t,
}: {
  draft: BillCardDetail;
  setDraft: React.Dispatch<React.SetStateAction<BillCardDetail>>;
  options: OptionMap;
  editing: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const setScope = (
    i: number,
    patch: Partial<BillCardDetail["scopes"][number]>,
  ) =>
    setDraft((row) => ({
      ...row,
      scopes: row.scopes.map((x, n) => (n === i ? { ...x, ...patch } : x)),
    }));
  return (
    <Section title={t("scopes")}>
      {!editing ? (
        draft.scopes.length ? (
          <div className="flex flex-wrap gap-2">
            {draft.scopes.map((s, i) => (
              <Badge key={s.id ?? i} variant="outline">
                {t(`scopeTypes.${s.scopeType}`)} ·{" "}
                {s.scopeLabel ?? s.scopeValueText ?? t("unknownValue")}
              </Badge>
            ))}
          </div>
        ) : (
          <Empty text={t("allScopes")} />
        )
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("scope")}</TableHead>
                <TableHead>{t("valueLabel")}</TableHead>
                <TableHead>{t("children")}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {draft.scopes.map((s, i) => {
                const opts = options[s.scopeType] ?? [];
                const text =
                  SCOPE_TYPES.includes(s.scopeType as never) &&
                  (s.scopeType === "job_title" || s.scopeType === "other");
                return (
                  <TableRow key={s.id ?? i}>
                    <TableCell>
                      <Select
                        value={s.scopeType}
                        onChange={(e) =>
                          setScope(i, {
                            scopeType: e.target.value,
                            scopeValueId: null,
                            scopeValueText: null,
                            scopeLabel: null,
                          })
                        }
                      >
                        {SCOPE_TYPES.map((x) => (
                          <option key={x} value={x}>
                            {t(`scopeTypes.${x}`)}
                          </option>
                        ))}
                      </Select>
                    </TableCell>
                    <TableCell>
                      {text ? (
                        <Input
                          value={s.scopeValueText ?? ""}
                          onChange={(e) =>
                            setScope(i, {
                              scopeValueText: e.target.value,
                              scopeValueId: null,
                              scopeLabel: e.target.value,
                            })
                          }
                        />
                      ) : (
                        <Select
                          value={s.scopeValueId ?? ""}
                          onChange={(e) => {
                            const o = opts.find((x) => x.id === e.target.value);
                            setScope(i, {
                              scopeValueId: e.target.value || null,
                              scopeValueText: null,
                              scopeLabel: o?.name ?? null,
                            });
                          }}
                        >
                          <option value="">{t("chooseValue")}</option>
                          {opts.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </TableCell>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={s.includeChildren}
                        onChange={(e) =>
                          setScope(i, { includeChildren: e.target.checked })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("removeScope")}
                        onClick={() =>
                          setDraft((row) => ({
                            ...row,
                            scopes: row.scopes.filter((_, n) => n !== i),
                          }))
                        }
                      >
                        <Trash2 size={14} />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setDraft((row) => ({
                ...row,
                scopes: [
                  ...row.scopes,
                  {
                    scopeType: "department",
                    scopeValueId: null,
                    scopeValueText: null,
                    scopeLabel: null,
                    includeChildren: true,
                  },
                ],
              }))
            }
          >
            <Plus size={14} />
            {t("addScope")}
          </Button>
        </>
      )}
    </Section>
  );
}

function LineSection({
  draft,
  setDraft,
  items,
  timeTypes,
  editing,
  layout,
  t,
}: {
  draft: BillCardDetail;
  setDraft: React.Dispatch<React.SetStateAction<BillCardDetail>>;
  items: ItemOption[];
  timeTypes: { id: string; name: string; bill_multiplier: string }[];
  editing: boolean;
  layout: FormLayoutConfig;
  t: ReturnType<typeof useTranslations>;
}) {
  const extras = timeTypes.filter((x) => Number(x.bill_multiplier) !== 1);
  const visible = new Set(
    layout.lines.columns.filter((x) => x.visible).map((x) => x.key),
  );
  const showItem = visible.has("item_id"),
    showRate = visible.has("bill_rate");
  const setLine = (
    i: number,
    patch: Partial<BillCardDetail["lines"][number]>,
  ) =>
    setDraft((row) => ({
      ...row,
      lines: row.lines.map((x, n) => (n === i ? { ...x, ...patch } : x)),
    }));
  return (
    <Section title={t("itemRates")}>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {showItem ? <TableHead>{t("item")}</TableHead> : null}
              {showRate ? (
                <TableHead className="text-right">{t("regular")}</TableHead>
              ) : null}
              {extras.map((tt) => (
                <TableHead key={tt.id} className="text-right">
                  {tt.name}
                </TableHead>
              ))}
              {editing ? <TableHead className="w-12" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {draft.lines.map((line, i) => (
              <TableRow key={line.id ?? i}>
                {showItem ? (
                  <TableCell>
                    {editing ? (
                      <Select
                        value={line.itemId}
                        onChange={(e) => {
                          const item = items.find(
                            (x) => x.id === e.target.value,
                          );
                          setLine(i, {
                            itemId: e.target.value,
                            itemName: item?.name ?? "",
                          });
                        }}
                      >
                        {items.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      line.itemName
                    )}
                  </TableCell>
                ) : null}
                {showRate ? (
                  <TableCell className="text-right tabular-nums">
                    {editing ? (
                      <Input
                        className="text-right tabular-nums"
                        inputMode="decimal"
                        value={line.regular ?? ""}
                        onChange={(e) =>
                          setLine(i, { regular: e.target.value })
                        }
                      />
                    ) : (
                      amount(line.regular, draft.currency)
                    )}
                  </TableCell>
                ) : null}
                {extras.map((tt) => (
                  <TableCell key={tt.id} className="text-right tabular-nums">
                    {editing ? (
                      <Input
                        className="text-right tabular-nums"
                        inputMode="decimal"
                        value={line.timeTypeRates?.[tt.id] ?? ""}
                        onChange={(e) =>
                          setLine(i, {
                            timeTypeRates: {
                              ...line.timeTypeRates,
                              [tt.id]: e.target.value,
                            },
                          })
                        }
                      />
                    ) : (
                      amount(
                        line.timeTypeRates?.[tt.id] ?? null,
                        draft.currency,
                      )
                    )}
                  </TableCell>
                ))}
                {editing ? (
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("removeRate")}
                      onClick={() =>
                        setDraft((row) => ({
                          ...row,
                          lines: row.lines.filter((_, n) => n !== i),
                        }))
                      }
                    >
                      <Trash2 size={14} />
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {editing ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const first = items[0];
            if (first)
              setDraft((row) => ({
                ...row,
                lines: [
                  ...row.lines,
                  {
                    itemId: first.id,
                    itemName: first.name,
                    regular: "0",
                    timeTypeRates: {},
                  },
                ],
              }));
          }}
        >
          <Plus size={14} />
          {t("addRate")}
        </Button>
      ) : null}
    </Section>
  );
}

function AdjustmentSection({
  draft,
  setDraft,
  options,
  editing,
  t,
}: {
  draft: BillCardDetail;
  setDraft: React.Dispatch<React.SetStateAction<BillCardDetail>>;
  options: OptionMap;
  editing: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const setAdjustment = (
    i: number,
    patch: Partial<BillCardDetail["adjustments"][number]>,
  ) =>
    setDraft((row) => ({
      ...row,
      adjustments: row.adjustments.map((x, n) =>
        n === i ? { ...x, ...patch } : x,
      ),
    }));
  const targetLabel = (x: ApplicabilityTarget) =>
    `${t(`targetTypes.${x.targetType}`)} · ${x.targetLabel ?? x.targetValueText ?? t("unknownValue")}`;
  return (
    <Section title={t("adjustments")}>
      {!editing ? (
        draft.adjustments.length ? (
          <div className="space-y-2">
            {draft.adjustments.map((a, i) => (
              <div
                key={a.id ?? i}
                className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
              >
                <div className="flex items-center justify-between">
                  <div className="font-medium">{a.name}</div>
                  <Badge variant="outline">
                    {t(`categories.${a.category}`)}
                  </Badge>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {a.targets.length
                    ? a.targets.map(targetLabel).join(" · ")
                    : t("wholeCard")}{" "}
                  · {t(`calculations.${a.calculation}`)}
                  {a.value != null ? ` · ${a.value}` : ""}
                  {a.unit ? ` ${a.unit}` : ""} ·{" "}
                  {t(`presentations.${a.presentation}`)}
                </div>
                {a.referenceText ? (
                  <p className="mt-2 text-sm">{a.referenceText}</p>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <Empty text={t("none")} />
        )
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adjustmentName")}</TableHead>
                  <TableHead>{t("category")}</TableHead>
                  <TableHead className="min-w-80">{t("appliesTo")}</TableHead>
                  <TableHead>{t("calculation")}</TableHead>
                  <TableHead>{t("adjustmentValue")}</TableHead>
                  <TableHead>{t("presentation")}</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {draft.adjustments.map((a, i) => (
                  <TableRow key={a.id ?? i} className="align-top">
                    <TableCell>
                      <Input
                        value={a.name}
                        onChange={(e) =>
                          setAdjustment(i, { name: e.target.value })
                        }
                      />
                      <Input
                        className="mt-1 font-mono text-xs"
                        aria-label={t("adjustmentCode")}
                        value={a.code}
                        onChange={(e) =>
                          setAdjustment(i, { code: e.target.value })
                        }
                      />
                      <Textarea
                        className="mt-1"
                        rows={2}
                        aria-label={t("referenceText")}
                        value={a.referenceText ?? ""}
                        onChange={(e) =>
                          setAdjustment(i, { referenceText: e.target.value })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={a.category}
                        onChange={(e) =>
                          setAdjustment(i, { category: e.target.value })
                        }
                      >
                        {[
                          "markup",
                          "travel",
                          "allowance",
                          "minimum",
                          "surcharge",
                          "other",
                        ].map((x) => (
                          <option key={x} value={x}>
                            {t(`categories.${x}`)}
                          </option>
                        ))}
                      </Select>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-2">
                        {a.targets.map((target, ti) => (
                          <TargetEditor
                            key={target.id ?? ti}
                            target={target}
                            options={options}
                            t={t}
                            onChange={(patch) =>
                              setAdjustment(i, {
                                targets: a.targets.map((x, n) =>
                                  n === ti ? { ...x, ...patch } : x,
                                ),
                              })
                            }
                            onRemove={() =>
                              setAdjustment(i, {
                                targets: a.targets.filter((_, n) => n !== ti),
                              })
                            }
                          />
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setAdjustment(i, {
                              targets: [
                                ...a.targets,
                                {
                                  targetType: "item_category",
                                  targetValueId: null,
                                  targetValueText: null,
                                  targetLabel: null,
                                  includeChildren: false,
                                },
                              ],
                            })
                          }
                        >
                          <Plus size={13} />
                          {t("addTarget")}
                        </Button>
                        {a.targets.length === 0 ? (
                          <div className="text-xs text-slate-500">
                            {t("wholeCard")}
                          </div>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={a.calculation}
                        onChange={(e) =>
                          setAdjustment(i, { calculation: e.target.value })
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
                        ].map((x) => (
                          <option key={x} value={x}>
                            {t(`calculations.${x}`)}
                          </option>
                        ))}
                      </Select>
                    </TableCell>
                    <TableCell>
                      {a.calculation === "text" ? (
                        <span>—</span>
                      ) : (
                        <>
                          <Input
                            inputMode="decimal"
                            className="text-right tabular-nums"
                            value={a.value ?? ""}
                            onChange={(e) =>
                              setAdjustment(i, { value: e.target.value })
                            }
                          />
                          <Input
                            className="mt-1"
                            aria-label={t("adjustmentUnit")}
                            value={a.unit ?? ""}
                            onChange={(e) =>
                              setAdjustment(i, { unit: e.target.value })
                            }
                          />
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={a.presentation}
                        onChange={(e) =>
                          setAdjustment(i, { presentation: e.target.value })
                        }
                      >
                        {["included", "separate", "informational"].map((x) => (
                          <option key={x} value={x}>
                            {t(`presentations.${x}`)}
                          </option>
                        ))}
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("removeAdjustment")}
                        onClick={() =>
                          setDraft((row) => ({
                            ...row,
                            adjustments: row.adjustments.filter(
                              (_, n) => n !== i,
                            ),
                          }))
                        }
                      >
                        <Trash2 size={14} />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setDraft((row) => ({
                ...row,
                adjustments: [
                  ...row.adjustments,
                  {
                    code: "",
                    name: "",
                    category: "markup",
                    calculation: "percent",
                    value: "0",
                    unit: "%",
                    presentation: "included",
                    threshold: null,
                    thresholdUnit: null,
                    referenceText: null,
                    targets: [],
                  },
                ],
              }))
            }
          >
            <Plus size={14} />
            {t("addAdjustment")}
          </Button>
        </>
      )}
    </Section>
  );
}

function TargetEditor({
  target,
  options,
  t,
  onChange,
  onRemove,
}: {
  target: ApplicabilityTarget;
  options: OptionMap;
  t: ReturnType<typeof useTranslations>;
  onChange: (patch: Partial<ApplicabilityTarget>) => void;
  onRemove: () => void;
}) {
  const opts = options[target.targetType] ?? [];
  const isText = TEXT_TARGETS.has(target.targetType);
  return (
    <div className="grid grid-cols-[9rem_1fr_auto] gap-1">
      <Select
        aria-label={t("targetType")}
        value={target.targetType}
        onChange={(e) =>
          onChange({
            targetType: e.target.value,
            targetValueId: null,
            targetValueText: null,
            targetLabel: null,
          })
        }
      >
        {TARGET_TYPES.map((x) => (
          <option key={x} value={x}>
            {t(`targetTypes.${x}`)}
          </option>
        ))}
      </Select>
      {isText && target.targetType === "other" ? (
        <Input
          aria-label={t("targetValue")}
          value={target.targetValueText ?? ""}
          onChange={(e) =>
            onChange({
              targetValueText: e.target.value,
              targetValueId: null,
              targetLabel: e.target.value,
            })
          }
        />
      ) : (
        <Select
          aria-label={t("targetValue")}
          value={(isText ? target.targetValueText : target.targetValueId) ?? ""}
          onChange={(e) => {
            const o = opts.find((x) => x.id === e.target.value);
            onChange(
              isText
                ? {
                    targetValueText: e.target.value || null,
                    targetValueId: null,
                    targetLabel: o?.name ?? null,
                  }
                : {
                    targetValueId: e.target.value || null,
                    targetValueText: null,
                    targetLabel: o?.name ?? null,
                  },
            );
          }}
        >
          <option value="">{t("chooseValue")}</option>
          {opts.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </Select>
      )}
      <Button
        variant="ghost"
        size="sm"
        aria-label={t("removeTarget")}
        onClick={onRemove}
      >
        <Trash2 size={14} />
      </Button>
    </div>
  );
}

function TermsSection({
  draft,
  setDraft,
  editing,
  t,
}: {
  draft: BillCardDetail;
  setDraft: React.Dispatch<React.SetStateAction<BillCardDetail>>;
  editing: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const setTerm = (
    i: number,
    patch: Partial<BillCardDetail["terms"][number]>,
  ) =>
    setDraft((row) => ({
      ...row,
      terms: row.terms.map((x, n) => (n === i ? { ...x, ...patch } : x)),
    }));
  return (
    <Section title={t("terms")}>
      {!editing ? (
        draft.terms.length ? (
          <div className="space-y-3">
            {draft.terms.map((term, i) => (
              <div key={term.id ?? i}>
                <div className="text-xs font-medium text-slate-500">
                  {term.label}
                </div>
                <div className="whitespace-pre-wrap text-sm">
                  {term.content}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty text={t("none")} />
        )
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("termLabel")}</TableHead>
                <TableHead>{t("termContent")}</TableHead>
                <TableHead>{t("termPlacement")}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {draft.terms.map((term, i) => (
                <TableRow key={term.id ?? i}>
                  <TableCell>
                    <Input
                      value={term.label}
                      onChange={(e) => setTerm(i, { label: e.target.value })}
                    />
                    <Input
                      className="mt-1 font-mono text-xs"
                      value={term.code}
                      onChange={(e) => setTerm(i, { code: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Textarea
                      rows={2}
                      value={term.content}
                      onChange={(e) => setTerm(i, { content: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      value={term.placement}
                      onChange={(e) =>
                        setTerm(i, { placement: e.target.value })
                      }
                    >
                      {["header", "conditions", "footer"].map((x) => (
                        <option key={x} value={x}>
                          {t(`placements.${x}`)}
                        </option>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("removeTerm")}
                      onClick={() =>
                        setDraft((row) => ({
                          ...row,
                          terms: row.terms.filter((_, n) => n !== i),
                        }))
                      }
                    >
                      <Trash2 size={14} />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setDraft((row) => ({
                ...row,
                terms: [
                  ...row.terms,
                  { code: "", label: "", content: "", placement: "conditions" },
                ],
              }))
            }
          >
            <Plus size={14} />
            {t("addTerm")}
          </Button>
        </>
      )}
    </Section>
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
