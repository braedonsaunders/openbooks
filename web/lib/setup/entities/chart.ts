/**
 * Setup-registry chart governance entities: accounting contexts and segment
 * value dependencies. Their write validation is server-side
 * (web/lib/setup/chart-validation.ts).
 */
import type { SetupEntity } from "../types";

export const CHART_ENTITIES: SetupEntity[] = [
  {
    // Named presentation contexts (for example a local statutory chart).
    // Reports run under a context show its localized account numbers and
    // names; postings never change.
    key: "accounting-contexts",
    table: "accounting_contexts",
    actorCols: true,
    groupKey: "accounting",
    iconKey: "book-open",
    orgScoped: true,
    naturalKey: "code",
    hasActive: true,
    featureKey: "accountingContexts",
    docSlug: "chart-of-accounts-governance",
    columns: [
      { key: "name", kind: "text" },
      { key: "code", kind: "code" },
      { key: "isActive", kind: "badge-active" },
    ],
    fields: [
      { key: "code", kind: "text", required: true, lockedOnEdit: true },
      { key: "name", kind: "text", required: true },
      { key: "description", kind: "textarea" },
      { key: "isActive", kind: "boolean", defaultValue: true },
    ],
  },
  {
    // The context a subsidiary, or every subsidiary of a country, reports
    // under unless a report names another context.
    key: "accounting-context-defaults",
    table: "accounting_context_defaults",
    actorCols: true,
    groupKey: "accounting",
    iconKey: "map-pin",
    orgScoped: true,
    hasActive: false,
    featureKey: "accountingContexts",
    orderBy: "country nulls first, subsidiary_id",
    parentRecords: [{ entityKey: "accounting-contexts", fieldKey: "contextId" }],
    columns: [
      { key: "subsidiaryId", kind: "ref", ref: "subsidiaries" },
      { key: "country", kind: "text" },
    ],
    fields: [
      {
        key: "contextId",
        kind: "ref",
        ref: "accounting-contexts",
        required: true,
        lockedOnEdit: true,
      },
      {
        key: "subsidiaryId",
        kind: "ref",
        ref: "subsidiaries",
        helpTextKey: "fieldHelp.contextDefaultScope",
      },
      { key: "country", kind: "country" },
    ],
  },
  {
    // Effective-dated localized number and name per account, optionally for
    // one subsidiary. Versions replace each other by date; reports refuse
    // a localized number two accounts share.
    key: "account-localizations",
    table: "account_localizations",
    actorCols: true,
    groupKey: "accounting",
    iconKey: "book-open",
    orgScoped: true,
    hasActive: false,
    featureKey: "accountingContexts",
    orderBy: "localized_number nulls last, account_id, effective_from",
    parentRecords: [{ entityKey: "accounting-contexts", fieldKey: "contextId" }],
    columns: [
      { key: "accountId", kind: "ref", ref: "chart-accounts" },
      { key: "localizedNumber", kind: "code" },
      { key: "localizedName", kind: "text" },
      { key: "subsidiaryId", kind: "ref", ref: "subsidiaries" },
      { key: "effectiveFrom", kind: "date" },
      { key: "effectiveTo", kind: "date" },
    ],
    fields: [
      {
        key: "contextId",
        kind: "ref",
        ref: "accounting-contexts",
        required: true,
        lockedOnEdit: true,
      },
      {
        key: "accountId",
        kind: "ref",
        ref: "chart-accounts",
        required: true,
        searchableReferences: true,
      },
      { key: "localizedNumber", kind: "text" },
      { key: "localizedName", kind: "text" },
      {
        key: "subsidiaryId",
        kind: "ref",
        ref: "subsidiaries",
        helpTextKey: "fieldHelp.localizationSubsidiary",
      },
      { key: "effectiveFrom", kind: "date", required: true },
      { key: "effectiveTo", kind: "date" },
    ],
  },
  {
    // "Filtered by": a segment value allowed only with listed values of a
    // controlling segment, one allowed value per row. Lives in its
    // segment's drawer; built-in dimensions and custom segments alike.
    key: "segment-value-dependencies",
    table: "segment_value_dependencies",
    actorCols: true,
    groupKey: "dimensions",
    iconKey: "workflow",
    orgScoped: true,
    hasActive: true,
    featureKey: "segmentDependencies",
    docSlug: "chart-of-accounts-governance",
    orderBy: "value_id, controlling_segment_id, effective_from nulls first",
    parentRecords: [{ entityKey: "segment-definitions", fieldKey: "segmentId" }],
    columns: [
      { key: "valueId", kind: "ref", ref: "segment-dimension-values" },
      { key: "controllingSegmentId", kind: "ref", ref: "all-segment-definitions" },
      { key: "allowedValueId", kind: "ref", ref: "segment-dimension-values" },
      { key: "effectiveFrom", kind: "date" },
      { key: "effectiveTo", kind: "date" },
      { key: "isActive", kind: "badge-active" },
    ],
    fields: [
      // Fixed by the owning segment's drawer.
      {
        key: "segmentId",
        kind: "ref",
        ref: "segment-definitions",
        required: true,
        lockedOnEdit: true,
        hidden: true,
      },
      {
        key: "valueId",
        kind: "ref",
        ref: "segment-dimension-values",
        refScopeField: "segmentId",
        required: true,
        searchableReferences: true,
      },
      { key: "controllingSegmentId", kind: "ref", ref: "all-segment-definitions", required: true },
      {
        key: "allowedValueId",
        kind: "ref",
        ref: "segment-dimension-values",
        refScopeField: "controllingSegmentId",
        required: true,
        searchableReferences: true,
        helpTextKey: "fieldHelp.allowedValue",
      },
      { key: "effectiveFrom", kind: "date" },
      { key: "effectiveTo", kind: "date" },
      { key: "description", kind: "textarea" },
      { key: "isActive", kind: "boolean", defaultValue: true },
    ],
  },
];
