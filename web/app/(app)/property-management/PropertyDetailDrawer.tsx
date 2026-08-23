"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import {
  Drawer,
  Button,
  Input,
  Label,
  Popover,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@openbooks/ui";
import {
  defaultFormLayout,
  isCustomTabKey,
  resolveFormTabs,
  type FormLayoutConfig,
  type HeaderFieldPlacement,
} from "@openbooks/customization";
import { CustomFieldInput } from "../../../components/custom-field-input";
import type { CustomFieldDefClient } from "../../../components/custom-field-inputs";
import { HeaderFields } from "../../../components/transaction-form/header-fields";
import type { Option } from "./workspace-ui";
import { Empty, RecordTabs, Status } from "./workspace-ui";
import { CamTable } from "./CamTable";
import { DepositTable, RentTable } from "./LeaseTables";

export function PropertyDetailDrawer({
  property,
  units,
  leases,
  options,
  permissions,
  customization,
  fixedAssetsEnabled = false,
  multiCurrency = false,
  data,
  money,
  act,
  busy,
  onClose,
  onAddUnit,
  onOpenUnit,
  onAddLease,
  onAddCam,
  onEditCam,
  onReopenCam,
  onOpenLease,
  onSave,
  onDelete,
  initialTab,
}: any) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations("entities.propertyManagement.detail");
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [tab, setTab] = useState(initialTab ?? "overview");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [form, setForm] = useState(() =>
    propertyForm(property ?? {}, customization.fieldDefs),
  );
  const effectiveLayout: FormLayoutConfig =
    customization.layout ?? defaultFormLayout("property");
  const customByKey = useMemo(
    () =>
      new Map<string, CustomFieldDefClient>(
        customization.fieldDefs.map((def: CustomFieldDefClient) => [
          def.key,
          def,
        ]),
      ),
    [customization.fieldDefs],
  );
  const tabs = resolveFormTabs(effectiveLayout).filter((item) => item.visible);
  const customGroupIds = new Set(
    tabs
      .filter((item) => isCustomTabKey(item.key))
      .flatMap((item) => item.groupIds ?? []),
  );
  const overviewLayout: FormLayoutConfig = {
    ...effectiveLayout,
    header: {
      groups: effectiveLayout.header.groups.filter(
        (group: FormLayoutConfig["header"]["groups"][number]) =>
          !customGroupIds.has(group.id),
      ),
    },
  };
  if (!property) return null;

  const editable = mode === "edit" && permissions.manage;
  const reset = () => {
    setForm(propertyForm(property, customization.fieldDefs));
    setMode("view");
  };
  const optionName = (items: Option[], value: string) =>
    items.find((item) => item.id === value)?.name ?? "—";
  const labelFor = (placement: HeaderFieldPlacement, fallback: string) =>
    placement.labelOverride?.trim() || fallback;
  const requiredFor = (placement: HeaderFieldPlacement, required = false) =>
    required || placement.required === true;
  const field = (
    placement: HeaderFieldPlacement,
    label: string,
    content: React.ReactNode,
    required = false,
  ) => (
    <>
      <Label>
        {labelFor(placement, label)}
        {editable && requiredFor(placement, required) ? (
          <span className="text-red-500"> *</span>
        ) : null}
      </Label>
      {content}
    </>
  );
  const read = (value: unknown, className = "") => (
    <p className={cn("text-sm", className)}>
      {value == null || value === "" ? "—" : String(value)}
    </p>
  );
  const select = (
    value: string,
    onChange: (value: string) => void,
    items: Option[],
    empty = t("selectEmpty"),
  ) =>
    editable ? (
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{empty}</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </Select>
    ) : (
      read(optionName(items, value))
    );

  function renderPropertyField(placement: HeaderFieldPlacement) {
    const key = placement.key;
    if (key.startsWith("cf_")) {
      const def = customByKey.get(key.slice(3));
      if (!def) return null;
      return (
        <CustomFieldInput
          def={{
            ...def,
            label: labelFor(placement, def.label),
            isRequired: requiredFor(placement, def.isRequired),
          }}
          value={form.custom[def.key]}
          onChange={(value) =>
            setForm({ ...form, custom: { ...form.custom, [def.key]: value } })
          }
          readOnly={!editable}
        />
      );
    }
    switch (key) {
      case "name":
        return field(
          placement,
          t("fields.name"),
          editable ? (
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          ) : (
            read(form.name)
          ),
          true,
        );
      case "code":
        return field(
          placement,
          t("fields.code"),
          editable ? (
            <Input
              className="font-mono"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          ) : (
            read(form.code, "font-mono")
          ),
          true,
        );
      case "property_type":
        return field(
          placement,
          t("fields.propertyType"),
          editable ? (
            <Select
              value={form.propertyType}
              onChange={(e) =>
                setForm({ ...form, propertyType: e.target.value })
              }
            >
              {[
                "residential",
                "commercial",
                "mixed_use",
                "industrial",
                "other",
              ].map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          ) : (
            read(form.propertyType.replaceAll("_", " "), "capitalize")
          ),
          true,
        );
      case "status":
        return field(
          placement,
          t("fields.status"),
          editable ? (
            <Select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              {["active", "inactive", "sold"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          ) : (
            <Status value={form.status} />
          ),
        );
      case "subsidiary_id":
        return field(
          placement,
          t("fields.subsidiary"),
          select(
            form.subsidiaryId,
            (value) => setForm({ ...form, subsidiaryId: value }),
            options.subsidiaries,
            t("selectSubsidiary"),
          ),
          true,
        );
      case "location_id":
        return field(
          placement,
          t("fields.location"),
          select(
            form.locationId,
            (value) => setForm({ ...form, locationId: value }),
            options.locations,
          ),
        );
      case "fixed_asset_id":
        if (!fixedAssetsEnabled) return null;
        return field(
          placement,
          t("fields.fixedAsset"),
          select(
            form.fixedAssetId,
            (value) => setForm({ ...form, fixedAssetId: value }),
            options.assets,
          ),
        );
      case "currency":
        if (!multiCurrency) return null;
        return field(
          placement,
          t("fields.currency"),
          editable ? (
            <Input
              className="font-mono uppercase"
              maxLength={3}
              value={form.currency}
              onChange={(e) =>
                setForm({ ...form, currency: e.target.value.toUpperCase() })
              }
            />
          ) : (
            read(form.currency, "font-mono")
          ),
          true,
        );
      case "street":
        return field(
          placement,
          t("fields.street"),
          editable ? (
            <Input
              value={form.street}
              onChange={(e) => setForm({ ...form, street: e.target.value })}
            />
          ) : (
            read(form.street)
          ),
        );
      case "city":
        return field(
          placement,
          t("fields.city"),
          editable ? (
            <Input
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
            />
          ) : (
            read(form.city)
          ),
        );
      case "region":
        return field(
          placement,
          t("fields.region"),
          editable ? (
            <Input
              value={form.region}
              onChange={(e) => setForm({ ...form, region: e.target.value })}
            />
          ) : (
            read(form.region)
          ),
        );
      case "postal_code":
        return field(
          placement,
          t("fields.postalCode"),
          editable ? (
            <Input
              value={form.postalCode}
              onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
            />
          ) : (
            read(form.postalCode)
          ),
        );
      case "rent_income_account_id":
        return field(
          placement,
          t("fields.rentIncomeAccount"),
          select(
            form.rentIncomeAccountId,
            (value) => setForm({ ...form, rentIncomeAccountId: value }),
            options.incomeAccounts,
          ),
        );
      case "cam_income_account_id":
        return field(
          placement,
          t("fields.camIncomeAccount"),
          select(
            form.camIncomeAccountId,
            (value) => setForm({ ...form, camIncomeAccountId: value }),
            options.incomeAccounts,
          ),
        );
      case "deposit_liability_account_id":
        return field(
          placement,
          t("fields.depositLiabilityAccount"),
          select(
            form.depositLiabilityAccountId,
            (value) => setForm({ ...form, depositLiabilityAccountId: value }),
            options.liabilityAccounts,
          ),
        );
      case "default_bank_account_id":
        return field(
          placement,
          t("fields.defaultBankAccount"),
          select(
            form.defaultBankAccountId,
            (value) => setForm({ ...form, defaultBankAccountId: value }),
            options.bankAccounts,
          ),
        );
      default:
        return null;
    }
  }

  const tabLabel = (item: { key: string; labelOverride?: string | null }) =>
    item.labelOverride?.trim() ||
    ({
      overview: t("tabsLabelMap.overview"),
      units: t("tabsLabelMap.units"),
      leases: t("tabsLabelMap.leases"),
      rent: t("tabsLabelMap.rent"),
      deposits: t("tabsLabelMap.deposits"),
      cam: t("tabsLabelMap.cam"),
    }[item.key] ??
      item.key.replace(/^tab_/, "").replaceAll("_", " "));
  const propertyPayload = (status = form.status) => ({
      propertyId: property.id,
      name: form.name,
      code: form.code,
      propertyType: form.propertyType,
      status,
      subsidiaryId: form.subsidiaryId,
      locationId: form.locationId || null,
      ...(fixedAssetsEnabled ? { fixedAssetId: form.fixedAssetId || null } : {}),
      ...(multiCurrency ? { currency: form.currency } : {}),
      address: {
        street: form.street,
        city: form.city,
        region: form.region,
        postalCode: form.postalCode,
      },
      rentIncomeAccountId: form.rentIncomeAccountId || null,
      camIncomeAccountId: form.camIncomeAccountId || null,
      depositLiabilityAccountId: form.depositLiabilityAccountId || null,
      defaultBankAccountId: form.defaultBankAccountId || null,
      custom: form.custom,
  });
  const save = async () => {
    const result = await onSave(propertyPayload());
    if (result) setMode("view");
  };
  const changeStatus = async (status: string) => {
    const result = await onSave(propertyPayload(status));
    if (result) {
      setForm({ ...form, status });
      setActionsOpen(false);
    }
  };
  const selectForm = (formId: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (formId) next.set("form", formId);
    else next.delete("form");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    setActionsOpen(false);
  };

  return (
    <Drawer
      open
      onClose={onClose}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500">{form.code}</span>
          <span>{form.name}</span>
          <Status value={form.status} />
        </span>
      }
      description={t("description", {
        subsidiary: property.subsidiaryName,
        location: property.locationName || t("noLocation"),
      })}
      subtabs={
        <RecordTabs
          label={t("tabsAria")}
          active={tab}
          tabs={tabs.map((item) => ({ key: item.key, label: tabLabel(item) }))}
          onChange={setTab}
        />
      }
      headerActions={
        mode === "edit" ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={reset}>
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              disabled={busy || !form.name.trim() || !form.code.trim()}
              onClick={save}
            >
              {busy ? t("saving") : t("save")}
            </Button>
          </div>
        ) : permissions.manage || permissions.customize ? (
          <div className="flex items-center gap-1.5">
            {permissions.manage ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-2.5 text-xs"
                onClick={() => setMode("edit")}
              >
                {t("edit")}
              </Button>
            ) : null}
            <Popover
              open={actionsOpen}
              onOpenChange={setActionsOpen}
              align="end"
              className="w-64 p-1.5"
              trigger={
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={() => setActionsOpen((open) => !open)}
                >
                  {t("actions")}{" "}
                  <ChevronDown
                    className={cn("h-3.5 w-3.5", actionsOpen && "rotate-180")}
                  />
                </Button>
              }
            >
              {customization.forms.length ? (
                <div className="mb-1 border-b border-slate-200 p-2 dark:border-slate-800">
                  <Label className="mb-1 block text-xs">{t("customForm")}</Label>
                  <Select
                    value={customization.currentFormId ?? ""}
                    onChange={(e) => selectForm(e.target.value)}
                  >
                    {customization.forms.map((item: any) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              {permissions.customize ? (
                <Button
                  asChild
                  variant="ghost"
                  className="h-8 w-full justify-start rounded px-2 text-xs"
                >
                  <Link href="/admin/customization?recordType=property&tab=forms">
                    {t("customizeForm")}
                  </Link>
                </Button>
              ) : null}
              {permissions.manage ? (
                <div className="mt-1 border-t border-slate-200 pt-1 dark:border-slate-800">
                  {form.status === "active" ? (
                    <Button
                      variant="ghost"
                      className="h-8 w-full justify-start rounded px-2 text-xs"
                      disabled={busy}
                      onClick={() => changeStatus("inactive")}
                    >
                      {t("deactivate")}
                    </Button>
                  ) : form.status === "inactive" ? (
                    <Button
                      variant="ghost"
                      className="h-8 w-full justify-start rounded px-2 text-xs"
                      disabled={busy}
                      onClick={() => changeStatus("active")}
                    >
                      {t("reactivate")}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    className="h-8 w-full justify-start rounded px-2 text-xs text-red-600 hover:text-red-700"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          t("deleteConfirm", { name: property.name }),
                        )
                      )
                        void onDelete();
                    }}
                  >
                    {t("deleteProperty")}
                  </Button>
                </div>
              ) : null}
            </Popover>
          </div>
        ) : undefined
      }
    >
      {tab === "overview" ? (
        <div className="p-1">
          <HeaderFields
            layout={overviewLayout}
            editable={editable}
            renderField={renderPropertyField}
          />
        </div>
      ) : null}
      {tab === "units" ? (
        <div className="space-y-3 p-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{t("units.title")}</h3>
              <p className="text-xs text-slate-500">
                {t("units.description")}
              </p>
            </div>
            {permissions.manage && property.status === "active" ? (
              <Button size="sm" onClick={onAddUnit}>
                {t("units.addUnit")}
              </Button>
            ) : null}
          </div>
          {units.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("units.table.unit")}</TableHead>
                  <TableHead>{t("units.table.type")}</TableHead>
                  <TableHead className="text-right">{t("units.table.rentableArea")}</TableHead>
                  <TableHead className="text-right">{t("units.table.bedrooms")}</TableHead>
                  <TableHead>{t("units.table.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {units.map((unit: any) => (
                  <TableRow
                    key={unit.id}
                    tabIndex={0}
                    role="button"
                    className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600"
                    onClick={() => onOpenUnit(unit.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenUnit(unit.id);
                      }
                    }}
                  >
                    <TableCell>
                      <div className="font-medium">{unit.code}</div>
                      <div className="text-xs text-slate-500">
                        {unit.name || "—"}
                      </div>
                    </TableCell>
                    <TableCell>{unit.unitType || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {unit.rentableArea || "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {unit.bedrooms ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Status value={unit.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty
              title={t("units.emptyTitle")}
              detail={t("units.emptyDetail")}
            />
          )}
        </div>
      ) : null}
      {tab === "leases" ? (
        <div className="space-y-3 p-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{t("leases.title")}</h3>
              <p className="text-xs text-slate-500">
                {t("leases.description")}
              </p>
            </div>
            {permissions.manage && property.status === "active" ? (
              <Button size="sm" onClick={() => onAddLease(null)}>
                {t("leases.newLease")}
              </Button>
            ) : null}
          </div>
          {leases.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("leases.table.lease")}</TableHead>
                  <TableHead>{t("leases.table.unit")}</TableHead>
                  <TableHead>{t("leases.table.tenant")}</TableHead>
                  <TableHead>{t("leases.table.term")}</TableHead>
                  <TableHead>{t("leases.table.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leases.map((lease: any) => (
                  <TableRow
                    key={lease.id}
                    tabIndex={0}
                    role="button"
                    className="cursor-pointer"
                    onClick={() => onOpenLease(lease.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenLease(lease.id);
                      }
                    }}
                  >
                    <TableCell className="font-medium text-teal-700">
                      {lease.leaseNumber}
                    </TableCell>
                    <TableCell>{lease.unitCode || t("leases.wholeProperty")}</TableCell>
                    <TableCell>{lease.tenantName}</TableCell>
                    <TableCell>
                      {lease.startsOn} – {lease.endsOn || t("leases.openTerm")}
                    </TableCell>
                    <TableCell>
                      <Status value={lease.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty
              title={t("leases.emptyTitle")}
              detail={t("leases.emptyDetail")}
            />
          )}
        </div>
      ) : null}
      {tab === "rent" ? (
        <div className="space-y-3 p-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{t("rent.title")}</h3>
              <p className="text-xs text-slate-500">
                {t("rent.description")}
              </p>
            </div>
            {permissions.bill ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    act(
                      { action: "assessLateFees", propertyId: property.id },
                      t("toasts.lateFeesAssessed"),
                    )
                  }
                >
                  {t("rent.assessLateFees")}
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    act(
                      { action: "billRent", propertyId: property.id },
                      t("toasts.rentBilled"),
                    )
                  }
                >
                  {t("rent.billDueRent")}
                </Button>
              </div>
            ) : null}
          </div>
          <RentTable
            schedules={data.schedules.filter((row: any) =>
              leases.some((lease: any) => lease.id === row.leaseId),
            )}
            leases={leases}
            money={money}
          />
        </div>
      ) : null}
      {tab === "deposits" ? (
        <div className="space-y-3 p-1">
          <div>
            <h3 className="text-sm font-semibold">{t("depositsTab.title")}</h3>
            <p className="text-xs text-slate-500">
              {t("depositsTab.description")}
            </p>
          </div>
          <DepositTable
            deposits={data.deposits.filter((row: any) =>
              leases.some((lease: any) => lease.id === row.leaseId),
            )}
            leases={leases}
            money={money}
          />
        </div>
      ) : null}
      {tab === "cam" ? (
        <div className="space-y-3 p-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{t("cam.title")}</h3>
              <p className="text-xs text-slate-500">
                {t("cam.description")}
              </p>
            </div>
            {permissions.manage && property.status === "active" ? (
              <Button size="sm" onClick={onAddCam}>
                {t("cam.newPool")}
              </Button>
            ) : null}
          </div>
          <div className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-800">
            <CamTable
              data={data}
              propertyId={property.id}
              money={money}
              busy={busy}
              permissions={permissions}
              act={act}
              onEdit={onEditCam}
              onReopen={onReopenCam}
            />
          </div>
        </div>
      ) : null}
      {tabs.some((item) => item.key === tab && isCustomTabKey(item.key)) ? (
        <div className="p-1">
          <HeaderFields
            layout={{
              ...effectiveLayout,
              header: {
                groups: effectiveLayout.header.groups.filter(
                  (group: FormLayoutConfig["header"]["groups"][number]) =>
                    (
                      tabs.find((item) => item.key === tab)?.groupIds ?? []
                    ).includes(group.id),
                ),
              },
            }}
            editable={editable}
            renderField={renderPropertyField}
          />
        </div>
      ) : null}
    </Drawer>
  );
}

function propertyForm(property: any, defs: CustomFieldDefClient[]) {
  return {
    name: property.name ?? "",
    code: property.code ?? "",
    propertyType: property.propertyType ?? "other",
    status: property.status ?? "active",
    subsidiaryId: property.subsidiaryId ?? "",
    locationId: property.locationId ?? "",
    fixedAssetId: property.fixedAssetId ?? "",
    currency: property.currency ?? "",
    street: property.address?.street ?? "",
    city: property.address?.city ?? "",
    region: property.address?.region ?? "",
    postalCode: property.address?.postalCode ?? "",
    rentIncomeAccountId: property.rentIncomeAccountId ?? "",
    camIncomeAccountId: property.camIncomeAccountId ?? "",
    depositLiabilityAccountId: property.depositLiabilityAccountId ?? "",
    defaultBankAccountId: property.defaultBankAccountId ?? "",
    custom: Object.fromEntries(
      defs.map((def) => [def.key, property.custom?.[def.key]]),
    ) as Record<string, unknown>,
  };
}
