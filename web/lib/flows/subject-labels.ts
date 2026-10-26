/**
 * Localized names for flow subject kinds. Every registered subject kind
 * resolves its record-type name in the `customization.recordTypes` catalog
 * under its profile's `labelKey`, or under the subject kind itself when the
 * profile declares none — one catalog for the Flows list, the New flow and
 * New approval pickers, the designer header and the approvals inbox. The
 * catalog parity suite proves every registered kind resolves in every
 * shipped locale.
 */
export const FLOW_SUBJECT_LABEL_NAMESPACE = "customization.recordTypes";

export function flowSubjectLabelKey(profile: { subjectKind: string; labelKey?: string }): string {
  return profile.labelKey ?? profile.subjectKind;
}

type Translate = {
  (key: never): string;
  has(key: never): boolean;
};

/** The localized subject name; an uncatalogued key reads as itself. */
export function flowSubjectLabel(
  tSubjects: Translate,
  profile: { subjectKind: string; labelKey?: string },
): string {
  const key = flowSubjectLabelKey(profile) as never;
  return tSubjects.has(key) ? tSubjects(key) : flowSubjectLabelKey(profile);
}

/**
 * Record-type picker options shared by the New flow and New approval
 * drawers: localized names grouped under their product-area header (see
 * web/app/api/admin/flows/profiles/groups.ts), sorted by group then name.
 * `tFlows` is the `admin.flows` translator; unknown groups read as Other so
 * the picker never renders an ungrouped row.
 */
export function flowSubjectPickerOptions(
  profiles: readonly { subjectKind: string; labelKey?: string; group?: string }[],
  tFlows: Translate,
  tSubjects: Translate,
): { value: string; label: string; group: string }[] {
  return profiles
    .map((profile) => {
      const groupKey = `new.groups.${profile.group ?? "other"}` as never;
      return {
        value: profile.subjectKind,
        label: flowSubjectLabel(tSubjects, profile),
        group: tFlows.has(groupKey) ? tFlows(groupKey) : tFlows("new.groups.other" as never),
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
}

/**
 * The localized title of the feature a flow write was refused for
 * (`flow_subject_feature_disabled`, `details.feature` naming the switch), or
 * null for any other failure. `tFeatures` is the `admin.features`
 * translator, which titles every switchboard entry.
 */
export function flowSubjectRefusedFeature(error: unknown, tFeatures: Translate): string | null {
  if (error === null || typeof error !== "object") return null;
  const { code, body } = error as { code?: unknown; body?: unknown };
  if (code !== "flow_subject_feature_disabled") return null;
  const feature = (body as { details?: { feature?: unknown } } | null)?.details?.feature;
  if (typeof feature !== "string") return null;
  const titleKey = `${feature}.title` as never;
  return tFeatures.has(titleKey) ? tFeatures(titleKey) : feature;
}
