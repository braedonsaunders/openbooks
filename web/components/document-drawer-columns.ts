import { useMemo } from "react";
import { amortizationLineColumns } from "./transaction-form/amortization-columns";
import { CLEAR_SEGMENT, INHERIT_SEGMENT } from "../lib/segment-assignments";
import {
  collectDependencyRules,
  dependentOptions,
  lineExtraDims,
} from "../lib/segment-dependency-options";
import type { DimensionAssignment } from "@openbooks/engine/organization/segment-dependency-rules";
import {
  type LineColumnPlacement,
  isCustomFieldKey,
  lineFieldMeta,
} from "@openbooks/customization";
import type { LineGridColumn } from "./line-grid";
import { customFieldColumns } from "./custom-field-inputs";
import { displayLineDecimal } from "../lib/line-grid-decimal";
import type { LineRow } from "./document-drawer-types";
import type { DocumentDrawerCommandsScope } from "./document-drawer-commands";
import { ENTRY_SECONDARY_LINE_KEYS } from "./document-drawer-entry";

/** Line grid columns: the built-in fallback set and the form-layout set. */
export function useDocumentDrawerColumns(scope: DocumentDrawerCommandsScope) {
  const {
    recordType,
    stockLocations,
    rows,
    setRows,
    stockedItemIds,
    t,
    tCommon,
    tAmortization,
    tWithholdingLine,
    config,
    amortizationTemplates,
    segments,
    builtinSegments,
    subsidiaryId,
    departmentId,
    projectIdHeader,
    locationId,
    classId,
    extraDims,
    documentDate,
    accounts,
    departments,
    projects,
    locations,
    classes,
    items,
    taxProfiles,
    nativeGoods,
    lineDefs,
    lineTax,
    showWithholdingLines,
    returnSourceColumn,
    promotionColumn,
    marketplaceColumn,
    layout,
    money,
    doc,
  } = scope;

  // -- line warehouse picker ------------------------------------------------
  const showWarehousePicker =
    recordType === "customer_invoice" &&
    (stockLocations ?? []).length > 1 &&
    rows.some((row) => row.itemId !== "" && stockedItemIds.has(row.itemId));
  const warehouseColumn = useMemo<LineGridColumn<LineRow> | null>(() => {
    if (!showWarehousePicker) return null;
    return {
      key: "stockLocationId",
      label: tCommon("labels.warehouse"),
      width: "150px",
      type: "select",
      options: [
        { value: "", label: "—" },
        ...(stockLocations ?? []).map((l) => ({ value: l.id, label: l.code ?? "" })),
      ],
      isCellEditable: (row) => stockedItemIds.has(String(row.itemId ?? "")),
    };
  }, [showWarehousePicker, stockLocations, stockedItemIds, tCommon]);

  // -- line amortization (vendor bills, while the feature is on) ------------
  const amortizationColumns = useMemo<LineGridColumn<LineRow>[]>(() => {
    return config.kind === "vendor_bill"
      ? amortizationLineColumns<LineRow>(amortizationTemplates, tAmortization)
      : [];
  }, [config.kind, amortizationTemplates, tAmortization]);

  // -- grid columns (line-based kinds; transfer uses its own fields) --------
  const columns = useMemo<LineGridColumn<LineRow>[]>(() => {
    // Segment value dependencies: each line picker offers the values the
    // line's other values allow on the document date.
    const dependencyRules = collectDependencyRules([...segments, ...builtinSegments]);
    const builtinSegmentId = (storage: string) =>
      builtinSegments.find((segment) => segment.storageColumn === storage)?.id;
    const segmentKeys = segments.map((segment) => segment.key);
    const lineDimensions = (row: LineRow): DimensionAssignment => {
      const cells = row as unknown as Record<string, unknown>;
      return {
        subsidiaryId:
          (typeof cells.subsidiaryId === "string" && cells.subsidiaryId) || subsidiaryId || null,
        departmentId:
          (typeof cells.departmentId === "string" && cells.departmentId) || departmentId || null,
        projectId:
          (typeof cells.projectId === "string" && cells.projectId) || projectIdHeader || null,
        locationId: locationId || null,
        classId: classId || null,
        extraDims: lineExtraDims(extraDims, cells, segmentKeys),
      };
    };
    const dependent = <T extends { value: string }>(
      options: T[],
      storageOrId: { storage?: string; id?: string },
      cell: string,
    ) =>
      dependencyRules.length === 0
        ? undefined
        : (row: LineRow) =>
            dependentOptions(
              options,
              dependencyRules,
              storageOrId.id ??
                (storageOrId.storage ? builtinSegmentId(storageOrId.storage) : undefined),
              lineDimensions(row),
              documentDate,
              String((row as unknown as Record<string, unknown>)[cell] ?? ""),
            );
    const departmentOptions = [
      { value: "", label: "—" },
      ...departments.map((d) => ({ value: d.id, label: d.name ?? "" })),
    ];
    const projectOptions = projects.map((p) => ({ value: p.id, label: p.name ?? "" }));
    const cols: LineGridColumn<LineRow>[] = [
      {
        key: "accountId",
        label: t("drawer.accountColumn"),
        width: "minmax(200px,2fr)",
        type: "search-select",
        required: true,
        options: accounts.map((a) => ({
          value: a.id,
          label: `${a.number ?? ""} ${a.name ?? ""}`.trim(),
          keywords: a.number ? [a.number] : undefined,
        })),
        placeholder: t("drawer.accountPlaceholder"),
      },
      {
        key: "description",
        label: tCommon("labels.description"),
        width: "minmax(160px,1.6fr)",
        type: "text",
      },
      {
        key: "departmentId",
        label: tCommon("labels.department"),
        width: "140px",
        type: "select",
        options: departmentOptions,
        optionsFor: dependent(departmentOptions, { storage: "department_id" }, "departmentId"),
      },
      {
        key: "projectId",
        label: tCommon("labels.project"),
        width: "minmax(150px,1.2fr)",
        type: "search-select",
        options: projectOptions,
        optionsFor: dependent(projectOptions, { storage: "project_id" }, "projectId"),
        placeholder: "—",
      },
    ];
    if (warehouseColumn) cols.push(warehouseColumn);
    if (returnSourceColumn) cols.push(returnSourceColumn);
    if (promotionColumn) cols.push(promotionColumn);
    if (config.hasTax) {
      cols.push({
        key: "taxProfileId",
        label: tCommon("labels.tax"),
        width: "110px",
        type: "select",
        options: [
          {
            value: "",
            label: nativeGoods ? tCommon("nativeGoodsTax.automatic") : t("drawer.noTax"),
          },
          ...taxProfiles.map((profile) => ({ value: profile.value, label: profile.code ?? "" })),
        ],
      });
    }
    for (const segment of segments.filter((item) => item.showOnLines)) {
      const segmentOptions = [
        { value: INHERIT_SEGMENT, label: tCommon("labels.inheritHeader") },
        { value: CLEAR_SEGMENT, label: tCommon("labels.noDimensionValue") },
        ...segment.values.map((value) => ({
          value: value.id,
          label: `${value.code ? `${value.code} · ` : ""}${value.name}`,
        })),
      ];
      cols.push({
        key: `seg_${segment.key}`,
        label: segment.name,
        width: "150px",
        type: "search-select",
        options: segmentOptions,
        optionsFor: dependent(segmentOptions, { id: segment.id }, `seg_${segment.key}`),
        placeholder: "—",
      });
    }
    for (const c of customFieldColumns<LineRow>(lineDefs)) cols.push(c);
    cols.push({
      key: "amount",
      label: tCommon("labels.amount"),
      width: "120px",
      type: "amount",
      align: "right",
      required: true,
    });
    if (config.hasTax) {
      cols.push({
        key: "taxAmount",
        label: t("drawer.taxAmountColumn"),
        width: "120px",
        type: "tax",
        align: "right",
        computeTax: lineTax,
        onTaxChange: (index, next) =>
          setRows((prev) =>
            prev.map((r, j) =>
              j === index ? { ...r, taxOverridden: next.overridden, taxAmount: next.taxAmount } : r,
            ),
          ),
      });
    }
    if (config.kind === "vendor_bill" && showWithholdingLines)
      cols.push({
        key: "withholdingTreatment",
        label: tWithholdingLine("treatment"),
        width: "150px",
        type: "select",
        options: [
          { value: "", label: tWithholdingLine("fromItem") },
          { value: "labour", label: tWithholdingLine("labour") },
          { value: "materials", label: tWithholdingLine("materials") },
          { value: "excluded", label: tWithholdingLine("excluded") },
        ],
      });
    if (config.kind === "vendor_bill" && showWithholdingLines)
      cols.push({
        key: "withholdingMaterialsCost",
        label: tWithholdingLine("directCost"),
        help: tWithholdingLine("directCostHelp"),
        width: "160px",
        type: "amount",
        align: "right",
      });
    if (marketplaceColumn) cols.push(marketplaceColumn);
    cols.push(...amortizationColumns);
    const lineVisibility = new Map(
      builtinSegments.map((segment) => [segment.storageColumn, segment.showOnLines]),
    );
    const storageForRowKey: Record<string, string> = {
      departmentId: "department_id",
      projectId: "project_id",
      locationId: "location_id",
      classId: "class_id",
    };
    return cols.filter((column) => {
      const storage = storageForRowKey[String(column.key)];
      return !storage || lineVisibility.get(storage) !== false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    accounts,
    departments,
    projects,
    taxProfiles,
    lineDefs,
    segments,
    builtinSegments,
    config,
    t,
    tCommon,
    tWithholdingLine,
    warehouseColumn,
    returnSourceColumn,
    promotionColumn,
    marketplaceColumn,
    showWithholdingLines,
    subsidiaryId,
    departmentId,
    projectIdHeader,
    locationId,
    classId,
    extraDims,
    documentDate,
    amortizationColumns,
  ]);

  // -- layout-driven path: header via <HeaderFields> + line columns from the
  //    resolved FormLayoutConfig. The hardcoded path is a defensive fallback
  //    for callers that have not resolved a tenant form yet. -----------------
  const useLayout = !!layout;

  // A multi-subsidiary org's transaction must ALWAYS show its subsidiary, even
  // if a user-customized layout hides the field — mirror how required built-ins
  // render by force-showing it after the layout groups.
  const layoutShowsSubsidiary =
    !!layout &&
    layout.header.groups.some((g) => g.fields.some((f) => f.key === "subsidiary_id" && f.visible));

  const cfColumns = useMemo(() => {
    const m = new Map<string, LineGridColumn<LineRow>>();
    for (const c of customFieldColumns<LineRow>(lineDefs)) m.set(c.key, c);
    return m;
  }, [lineDefs]);

  const columnsFromLayout = useMemo<LineGridColumn<LineRow>[]>(() => {
    if (!layout) return columns;
    const builtIn: Record<string, Omit<LineGridColumn<LineRow>, "label">> = {
      account_id: {
        key: "accountId",
        width: "minmax(200px,2fr)",
        type: "search-select",
        required: true,
        options: accounts.map((a) => ({
          value: a.id,
          label: `${a.number ?? ""} ${a.name ?? ""}`.trim(),
          keywords: a.number ? [a.number] : undefined,
        })),
        placeholder: t("drawer.accountPlaceholder"),
      },
      item_id: {
        key: "itemId",
        width: "minmax(150px,1.4fr)",
        type: "search-select",
        options: (items ?? []).map((it) => ({
          value: it.id,
          label: `${it.code ? it.code + " " : ""}${it.name ?? ""}`.trim(),
          keywords: it.code ? [it.code] : undefined,
        })),
        placeholder: "—",
      },
      description: { key: "description", width: "minmax(160px,1.6fr)", type: "text" },
      quantity: {
        key: "quantity",
        width: "90px",
        type: "decimal",
        decimalScale: 8,
        align: "right",
      },
      unit: { key: "unit", width: "80px", type: "text" },
      unit_price: {
        key: "unitPrice",
        width: "110px",
        type: "decimal",
        decimalScale: 8,
        align: "right",
      },
      cost_rate: {
        key: "costRate",
        width: "110px",
        type: "readonly",
        align: "right",
        render: (row) => displayLineDecimal(row.costRate, 8),
      },
      bill_rate: {
        key: "billRate",
        width: "110px",
        type: "readonly",
        align: "right",
        render: (row) => displayLineDecimal(row.billRate, 8),
      },
      bill_amount: {
        key: "billAmount",
        width: "120px",
        type: "readonly",
        align: "right",
        render: (row) => money(row.billAmount, { currency: doc.currency }),
      },
      is_billable: {
        key: "isBillable",
        width: "90px",
        type: "readonly",
        render: (row) => (row.isBillable ? tCommon("labels.yes") : tCommon("labels.no")),
      },
      department_id: {
        key: "departmentId",
        width: "140px",
        type: "select",
        options: [
          { value: "", label: "—" },
          ...departments.map((d) => ({ value: d.id, label: d.name ?? "" })),
        ],
      },
      project_id: {
        key: "projectId",
        width: "minmax(150px,1.2fr)",
        type: "search-select",
        options: projects.map((p) => ({ value: p.id, label: p.name ?? "" })),
        placeholder: "—",
      },
      location_id: {
        key: "locationId",
        width: "140px",
        type: "select",
        options: [
          { value: "", label: "—" },
          ...(locations ?? []).map((l) => ({ value: l.id, label: l.name ?? "" })),
        ],
      },
      class_id: {
        key: "classId",
        width: "140px",
        type: "select",
        options: [
          { value: "", label: "—" },
          ...(classes ?? []).map((c) => ({ value: c.id, label: c.name ?? "" })),
        ],
      },
      tax_code_id: {
        key: "taxProfileId",
        width: "110px",
        type: "select",
        options: [
          {
            value: "",
            label: nativeGoods ? tCommon("nativeGoodsTax.automatic") : t("drawer.noTax"),
          },
          ...taxProfiles.map((profile) => ({ value: profile.value, label: profile.code ?? "" })),
        ],
      },
      work_from: { key: "workFrom", width: "130px", type: "date" },
      work_to: { key: "workTo", width: "130px", type: "date" },
      // Withholding line fields stay out of the layout registry without a
      // registration: a saved form layout cannot resurrect columns the grid
      // itself refuses to offer.
      ...(showWithholdingLines
        ? {
            withholding_treatment: {
              key: "withholdingTreatment",
              width: "150px",
              type: "select",
              options: [
                { value: "", label: tWithholdingLine("fromItem") },
                { value: "labour", label: tWithholdingLine("labour") },
                { value: "materials", label: tWithholdingLine("materials") },
                { value: "excluded", label: tWithholdingLine("excluded") },
              ],
            },
            withholding_materials_cost: {
              key: "withholdingMaterialsCost",
              width: "160px",
              type: "amount",
              align: "right",
              help: tWithholdingLine("directCostHelp"),
            },
          }
        : {}),
      amount: { key: "amount", width: "120px", type: "amount", align: "right", required: true },
      tax_amount: {
        key: "taxAmount",
        width: "120px",
        type: "tax",
        align: "right",
        computeTax: lineTax,
        onTaxChange: (index, next) =>
          setRows((prev) =>
            prev.map((r, j) =>
              j === index ? { ...r, taxOverridden: next.overridden, taxAmount: next.taxAmount } : r,
            ),
          ),
      },
    };
    const defLabel: Record<string, string> = {
      account_id: t("drawer.accountColumn"),
      item_id: tCommon("labels.item"),
      description: tCommon("labels.description"),
      quantity: tCommon("labels.quantity"),
      unit: tCommon("labels.unit"),
      unit_price: tCommon("labels.unitPrice"),
      cost_rate: tCommon("labels.costRate"),
      bill_rate: tCommon("labels.billRate"),
      bill_amount: tCommon("labels.billAmount"),
      is_billable: tCommon("labels.billable"),
      department_id: tCommon("labels.department"),
      project_id: tCommon("labels.project"),
      location_id: tCommon("labels.location"),
      class_id: tCommon("labels.class"),
      tax_code_id: tCommon("labels.tax"),
      work_from: tCommon("labels.workFrom"),
      work_to: tCommon("labels.workTo"),
      amount: tCommon("labels.amount"),
      tax_amount: t("drawer.taxAmountColumn"),
      withholding_treatment: tWithholdingLine("treatment"),
      withholding_materials_cost: tWithholdingLine("directCost"),
    };
    const configured = layout.lines.columns
      .filter(
        (p: LineColumnPlacement) =>
          p.visible &&
          builtinSegments.find((segment) => segment.storageColumn === p.key)?.showOnLines !== false,
      )
      .map((p): LineGridColumn<LineRow> | null => {
        if (isCustomFieldKey(p.key)) {
          const base = cfColumns.get(p.key);
          if (!base) return null;
          return {
            ...base,
            width: p.width ?? base.width,
            label: p.labelOverride?.trim() ? p.labelOverride.trim() : base.label,
          };
        }
        const base = builtIn[p.key];
        if (!base) return null;
        const meta = recordType ? lineFieldMeta(recordType, p.key) : undefined;
        // A form that does not say otherwise keeps the line to what most
        // entries need (account, description, amount, tax): quantities,
        // pricing and dimensions open with Details or as soon as a line uses
        // them, so Tab goes from the account to the amount directly.
        const entrySecondary =
          ENTRY_SECONDARY_LINE_KEYS.has(p.key) ||
          (p.key === "item_id" && (items ?? []).length === 0) ||
          ((p.key === "tax_code_id" || p.key === "tax_amount") && taxProfiles.length === 0);
        return {
          ...base,
          width: p.width ?? base.width,
          secondary: p.secondary ?? entrySecondary,
          required: meta?.required ?? (base as { required?: boolean }).required,
          label: p.labelOverride?.trim() ? p.labelOverride.trim() : (defLabel[p.key] ?? p.key),
        };
      })
      .filter((c): c is LineGridColumn<LineRow> => c !== null);
    // The warehouse and return pickers are force-shown like the subsidiary
    // header field: tenant layouts predate those keys, so placement alone
    // would hide them.
    return [
      ...configured,
      ...(warehouseColumn ? [warehouseColumn] : []),
      ...(returnSourceColumn ? [returnSourceColumn] : []),
      ...(promotionColumn ? [promotionColumn] : []),
      // Amortization columns are force-shown like the warehouse picker:
      // tenant layouts predate them.
      ...amortizationColumns,
      ...columns.filter(
        (column) =>
          String(column.key).startsWith("seg_") ||
          (showWithholdingLines &&
            (column.key === "withholdingTreatment" || column.key === "withholdingMaterialsCost") &&
            !configured.some((c) => c.key === column.key)),
      ),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    layout,
    accounts,
    departments,
    projects,
    locations,
    classes,
    items,
    taxProfiles,
    lineDefs,
    cfColumns,
    columns,
    recordType,
    builtinSegments,
    t,
    tCommon,
    tWithholdingLine,
    warehouseColumn,
    returnSourceColumn,
    promotionColumn,
    showWithholdingLines,
    amortizationColumns,
  ]);

  return { useLayout, layoutShowsSubsidiary, columns, columnsFromLayout };
}

export type DocumentDrawerColumnsScope = DocumentDrawerCommandsScope &
  ReturnType<typeof useDocumentDrawerColumns>;
