/** Setup-registry service dispatch entities: the effective-dated dispatch policy. */
import type { SetupEntity } from "../types";

const hours = (key: string): SetupEntity["fields"][number] => ({
  key,
  labelKey: `serviceDispatchFields.${key}`,
  kind: "integer",
  min: 1,
  max: 8760,
  helpTextKey: "serviceDispatchFields.responseHoursHelp",
});

export const SERVICE_ENTITIES: SetupEntity[] = [
  {
    // One authoritative, effective-dated policy: a save appends a version
    // effective from its date, so response targets and notices recorded on
    // earlier work keep the policy they were made under.
    key: "service-dispatch-policies",
    table: "service_dispatch_policies",
    singularTitleKey: "entities.service-dispatch-policies.singularTitle",
    groupKey: "workforce",
    iconKey: "wrench",
    orgScoped: true,
    actorCols: false,
    orderBy: "effective_from desc",
    hasActive: false,
    allowUpdate: false,
    allowDelete: false,
    featureKey: "serviceDispatch",
    importVia: "none",
    mutationPath: "/api/service/policies",
    mutationCreateKeys: [
      "effectiveFrom",
      "notifyArrivalWindow",
      "notifyEnRoute",
      "arrivalWindowMinutes",
      "defaultVisitMinutes",
      "urgentResponseHours",
      "highResponseHours",
      "normalResponseHours",
      "lowResponseHours",
      "agreementHorizonDays",
      "reason",
    ],
    columns: [
      { key: "effectiveFrom", kind: "date" },
      {
        key: "notifyArrivalWindow",
        labelKey: "serviceDispatchFields.notifyArrivalWindow",
        kind: "badge-active",
      },
      {
        key: "notifyEnRoute",
        labelKey: "serviceDispatchFields.notifyEnRoute",
        kind: "badge-active",
      },
      {
        key: "urgentResponseHours",
        labelKey: "serviceDispatchFields.urgentResponseHours",
        kind: "text",
      },
      { key: "reason", kind: "text" },
    ],
    formSections: [
      {
        titleKey: "sections.serviceDispatchNotices",
        descriptionKey: "sections.serviceDispatchNoticesHelp",
        fields: ["effectiveFrom", "notifyArrivalWindow", "notifyEnRoute", "arrivalWindowMinutes"],
      },
      {
        titleKey: "sections.serviceDispatchResponse",
        descriptionKey: "sections.serviceDispatchResponseHelp",
        fields: [
          "urgentResponseHours",
          "highResponseHours",
          "normalResponseHours",
          "lowResponseHours",
        ],
      },
      {
        titleKey: "sections.serviceDispatchPlanning",
        fields: ["defaultVisitMinutes", "agreementHorizonDays", "reason"],
      },
    ],
    fields: [
      { key: "effectiveFrom", kind: "date", required: true },
      {
        key: "notifyArrivalWindow",
        labelKey: "serviceDispatchFields.notifyArrivalWindow",
        kind: "boolean",
        defaultValue: false,
        booleanStyle: "switch",
        helpTextKey: "serviceDispatchFields.notifyArrivalWindowHelp",
      },
      {
        key: "notifyEnRoute",
        labelKey: "serviceDispatchFields.notifyEnRoute",
        kind: "boolean",
        defaultValue: false,
        booleanStyle: "switch",
        helpTextKey: "serviceDispatchFields.notifyEnRouteHelp",
      },
      {
        key: "arrivalWindowMinutes",
        labelKey: "serviceDispatchFields.arrivalWindowMinutes",
        kind: "integer",
        required: true,
        min: 15,
        max: 720,
        defaultValue: 120,
      },
      hours("urgentResponseHours"),
      hours("highResponseHours"),
      hours("normalResponseHours"),
      hours("lowResponseHours"),
      {
        key: "defaultVisitMinutes",
        labelKey: "serviceDispatchFields.defaultVisitMinutes",
        kind: "integer",
        required: true,
        min: 5,
        max: 1440,
        defaultValue: 60,
      },
      {
        key: "agreementHorizonDays",
        labelKey: "serviceDispatchFields.agreementHorizonDays",
        kind: "integer",
        required: true,
        min: 7,
        max: 366,
        defaultValue: 90,
        helpTextKey: "serviceDispatchFields.agreementHorizonDaysHelp",
      },
      { key: "reason", kind: "textarea", required: true, resetOnEdit: true },
    ],
  },
];
