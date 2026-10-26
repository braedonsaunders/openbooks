"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { Button, Input, Label, SearchSelect, Select, type SelectOption } from "@openbooks/ui";
import { serviceRequest } from "./api";

type Option = { value: string; label: string; hint?: string };

/** A searchable picker over a service option list (customers, items, part items). */
export function RemotePicker({
  kind,
  value,
  label,
  onChange,
  ariaLabel,
}: {
  kind: "customers" | "items" | "part-items";
  value: string;
  label?: string;
  onChange: (value: string, option: Option | null) => void;
  ariaLabel: string;
}) {
  const t = useTranslations("service.form");
  const [options, setOptions] = useState<Option[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const request = ++seq.current;
    const timer = setTimeout(() => {
      setLoading(true);
      serviceRequest<{
        options: Array<Option & { id?: string; name?: string; code?: string | null }>;
      }>(
        `/api/service/options?kind=${kind}&q=${encodeURIComponent(query)}`,
        undefined,
        t("loadFailed"),
      )
        .then((result) => {
          if (request !== seq.current) return;
          setOptions(
            result.options.map((option) =>
              option.value
                ? option
                : {
                    value: option.id!,
                    label: option.code ? `${option.code} — ${option.name}` : option.name!,
                  },
            ),
          );
        })
        .catch(() => {
          if (request === seq.current) setOptions([]);
        })
        .finally(() => {
          if (request === seq.current) setLoading(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [kind, query, t]);
  const selected: SelectOption[] =
    value && label && !options.some((option) => option.value === value) ? [{ value, label }] : [];
  return (
    <SearchSelect
      value={value}
      onChange={(next) => onChange(next, options.find((option) => option.value === next) ?? null)}
      options={[
        ...selected,
        ...options.map((option) => ({
          value: option.value,
          label: option.label,
          hint: option.hint,
        })),
      ]}
      remote
      loading={loading}
      onSearchChange={setQuery}
      placeholder={t("choose")}
      searchPlaceholder={t("search")}
      ariaLabel={ariaLabel}
    />
  );
}

export type CustomerSite = { addresses: Option[]; contacts: Option[] };

/** The customer's service location and contact, loaded when the customer changes. */
export function SitePickers({
  customerId,
  addressId,
  contactId,
  onAddress,
  onContact,
}: {
  customerId: string;
  addressId: string;
  contactId: string;
  onAddress: (value: string) => void;
  onContact: (value: string) => void;
}) {
  const t = useTranslations("service.form");
  const [sites, setSites] = useState<CustomerSite & { customerId: string }>({
    customerId: "",
    addresses: [],
    contacts: [],
  });
  useEffect(() => {
    if (!customerId) return;
    let live = true;
    serviceRequest<CustomerSite>(
      `/api/service/options?kind=sites&customer=${customerId}`,
      undefined,
      t("loadFailed"),
    )
      .then((result) => {
        if (live) setSites({ customerId, ...result });
      })
      .catch(() => {
        if (live) setSites({ customerId, addresses: [], contacts: [] });
      });
    return () => {
      live = false;
    };
  }, [customerId, t]);
  const current = sites.customerId === customerId ? sites : { addresses: [], contacts: [] };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <Label>{t("address")}</Label>
        <Select
          value={addressId}
          onChange={(event) => onAddress(event.target.value)}
          disabled={!customerId}
          aria-label={t("address")}
        >
          <option value="">{t("noAddress")}</option>
          {current.addresses.map((option) => (
            <option key={option.value} value={option.value}>
              {option.hint ?? option.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>{t("contact")}</Label>
        <Select
          value={contactId}
          onChange={(event) => onContact(event.target.value)}
          disabled={!customerId}
          aria-label={t("contact")}
        >
          <option value="">{t("noContact")}</option>
          {current.contacts.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
              {option.hint ? ` · ${option.hint}` : ""}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

/** Required qualifications: the skills a technician must hold, verified, to be assigned. */
export function QualificationPicker({
  value,
  onChange,
}: {
  value: readonly string[];
  onChange: (value: string[]) => void;
}) {
  const t = useTranslations("service.form");
  const [options, setOptions] = useState<Option[] | null>(null);
  useEffect(() => {
    let live = true;
    serviceRequest<{ options: Option[] }>(
      "/api/service/options?kind=qualifications",
      undefined,
      t("loadFailed"),
    )
      .then((result) => {
        if (live) setOptions(result.options);
      })
      .catch(() => {
        if (live) setOptions([]);
      });
    return () => {
      live = false;
    };
  }, [t]);
  if (options === null) return null;
  if (!options.length) return <p className="text-xs text-slate-500">{t("noQualifications")}</p>;
  return (
    <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
      <legend className="sr-only">{t("qualifications")}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className="flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-200"
        >
          <input
            type="checkbox"
            checked={value.includes(option.value)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, option.value]
                  : value.filter((id) => id !== option.value),
              )
            }
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

export type DraftLine = {
  key: string;
  itemId: string;
  itemLabel: string;
  description: string;
  quantity: string;
  unitPrice: string;
};

export const newLine = (): DraftLine => ({
  key: crypto.randomUUID(),
  itemId: "",
  itemLabel: "",
  description: "",
  quantity: "1",
  unitPrice: "",
});

/** Scope lines: item, description, exact quantity and unit price as entered. */
export function LinesEditor({
  lines,
  onChange,
}: {
  lines: readonly DraftLine[];
  onChange: (lines: DraftLine[]) => void;
}) {
  const t = useTranslations("service.form");
  const update = (key: string, patch: Partial<DraftLine>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  return (
    <div className="space-y-2">
      {lines.map((line) => (
        <div
          key={line.key}
          className="grid grid-cols-12 items-end gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-800"
        >
          <div className="col-span-12 sm:col-span-5">
            <Label>{t("item")}</Label>
            <RemotePicker
              kind="items"
              value={line.itemId}
              label={line.itemLabel}
              ariaLabel={t("item")}
              onChange={(itemId, option) =>
                update(line.key, { itemId, itemLabel: option?.label ?? "" })
              }
            />
          </div>
          <div className="col-span-6 sm:col-span-2">
            <Label>{t("quantity")}</Label>
            <Input
              inputMode="decimal"
              value={line.quantity}
              onChange={(event) => update(line.key, { quantity: event.target.value })}
              aria-label={t("quantity")}
            />
          </div>
          <div className="col-span-6 sm:col-span-2">
            <Label>{t("unitPrice")}</Label>
            <Input
              inputMode="decimal"
              value={line.unitPrice}
              onChange={(event) => update(line.key, { unitPrice: event.target.value })}
              aria-label={t("unitPrice")}
            />
          </div>
          <div className="col-span-10 sm:col-span-2">
            <Label>{t("description")}</Label>
            <Input
              value={line.description}
              onChange={(event) => update(line.key, { description: event.target.value })}
              aria-label={t("description")}
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(lines.filter((candidate) => candidate.key !== line.key))}
              aria-label={t("removeLine")}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...lines, newLine()])}
      >
        <Plus className="mr-1 h-4 w-4" />
        {t("addLine")}
      </Button>
    </div>
  );
}

/** Lines as the API takes them: only lines with an item, exact strings unchanged. */
export function lineInputs(lines: readonly DraftLine[]) {
  return lines
    .filter((line) => line.itemId)
    .map((line) => ({
      itemId: line.itemId,
      description: line.description.trim() || null,
      quantity: line.quantity.trim(),
      unitPrice: line.unitPrice.trim(),
    }));
}
