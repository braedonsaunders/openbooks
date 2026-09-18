"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Drawer, Button, Input, Select } from "@openbooks/ui";
import type { Option } from "./workspace-ui";
import { Field, PROPERTY_TYPE_OPTIONS } from "./workspace-ui";
import type { SaveAction, WorkspaceOptions } from "./types";

export function PropertyDrawer({ open, onClose, options, busy, onSave, fixedAssetsEnabled = false, multiCurrency = false }: { open: boolean; onClose: () => void; options: WorkspaceOptions; busy: boolean; onSave: SaveAction; fixedAssetsEnabled?: boolean; multiCurrency?: boolean }) {
  const initial = useMemo(
    () => ({
      code: "",
      name: "",
      propertyType: "residential",
      subsidiaryId: options.subsidiaries[0]?.id ?? "",
      currency: options.subsidiaries[0]?.currency ?? "CAD",
      locationId: "",
      fixedAssetId: "",
      rentIncomeAccountId: "",
      camIncomeAccountId: "",
      depositLiabilityAccountId: "",
      defaultBankAccountId: "",
      street: "",
      city: "",
      region: "",
      postalCode: "",
    }),
    [options],
  );
  const [form, setForm] = useState(initial);
  const t = useTranslations("entities.propertyManagement.propertyDrawer");
  const tCommon = useTranslations("common");
  const tWorkspace = useTranslations("entities.propertyManagement.workspace");
  const tTypes = useTranslations("entities.propertyManagement.propertyTypes");
  useEffect(() => {
    if (open) setForm(initial);
  }, [open, initial]);
  const submit = () => {
    const { currency, ...fields } = form;
    onSave({
      ...fields,
      ...(multiCurrency ? { currency } : {}),
      locationId: form.locationId || null,
      ...(fixedAssetsEnabled ? { fixedAssetId: form.fixedAssetId || null } : {}),
      camIncomeAccountId: form.camIncomeAccountId || null,
      depositLiabilityAccountId: form.depositLiabilityAccountId || null,
      defaultBankAccountId: form.defaultBankAccountId || null,
      address: {
        street: form.street,
        city: form.city,
        region: form.region,
        postalCode: form.postalCode,
      },
    });
  };
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={tWorkspace("newProperty")}
      description={t("description")}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {tCommon("actions.cancel")}
          </Button>
          <Button
            disabled={
              busy ||
              !form.code ||
              !form.name ||
              !form.subsidiaryId ||
              !form.rentIncomeAccountId
            }
            onClick={submit}
          >
            {busy ? tCommon("actions.creating") : tCommon("actions.create")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("code")}>
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </Field>
          <Field label={tCommon("labels.name")}>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label={tCommon("labels.type")}>
            <Select
              value={form.propertyType}
              onChange={(e) =>
                setForm({ ...form, propertyType: e.target.value })
              }
            >
              {PROPERTY_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {tTypes(option.key)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("legalEntity")}>
            <Select
              value={form.subsidiaryId}
              onChange={(e) => {
                const sub = options.subsidiaries.find(
                  (item: Option) => item.id === e.target.value,
                );
                setForm({
                  ...form,
                  subsidiaryId: e.target.value,
                  currency: sub?.currency ?? form.currency,
                });
              }}
            >
              <option value="">{t("selectEntity")}</option>
              {options.subsidiaries.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("propertyLocation")}>
            <Select
              value={form.locationId}
              onChange={(e) => setForm({ ...form, locationId: e.target.value })}
            >
              <option value="">{t("notMapped")}</option>
              {options.locations.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          {fixedAssetsEnabled ? <Field label={t("fixedAsset")}>
            <Select
              value={form.fixedAssetId}
              onChange={(e) =>
                setForm({ ...form, fixedAssetId: e.target.value })
              }
            >
              <option value="">{t("notOwned")}</option>
              {options.assets.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field> : null}
          <Field label={t("rentIncomeAccount")}>
            <Select
              value={form.rentIncomeAccountId}
              onChange={(e) =>
                setForm({ ...form, rentIncomeAccountId: e.target.value })
              }
            >
              <option value="">{t("selectAccount")}</option>
              {options.incomeAccounts.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("camIncomeAccount")}>
            <Select
              value={form.camIncomeAccountId}
              onChange={(e) =>
                setForm({ ...form, camIncomeAccountId: e.target.value })
              }
            >
              <option value="">{t("selectAccount")}</option>
              {options.incomeAccounts.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("depositLiability")}>
            <Select
              value={form.depositLiabilityAccountId}
              onChange={(e) =>
                setForm({ ...form, depositLiabilityAccountId: e.target.value })
              }
            >
              <option value="">{t("selectLiability")}</option>
              {options.liabilityAccounts.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("defaultDepositBank")}>
            <Select
              value={form.defaultBankAccountId}
              onChange={(e) =>
                setForm({ ...form, defaultBankAccountId: e.target.value })
              }
            >
              <option value="">{t("selectBank")}</option>
              {options.bankAccounts.map((o: Option) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("street")}>
            <Input
              value={form.street}
              onChange={(e) => setForm({ ...form, street: e.target.value })}
            />
          </Field>
          <Field label={t("city")}>
            <Input
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
            />
          </Field>
          <Field label={t("region")}>
            <Input
              value={form.region}
              onChange={(e) => setForm({ ...form, region: e.target.value })}
            />
          </Field>
          <Field label={t("postalCode")}>
            <Input
              value={form.postalCode}
              onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
            />
          </Field>
        </div>
      </div>
    </Drawer>
  );
}
