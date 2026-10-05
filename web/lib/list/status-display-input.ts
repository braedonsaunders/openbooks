/**
 * Which string a status display-name hook receives for a quick-filter
 * option. Static options (declared in the record-type registry with a
 * labelKey) carry their stable code: the catalog is keyed by that code, so
 * resolving from the translated label would key it by display text
 * ("planning.status.Suggested"). Tenant-loaded options carry database ids
 * as values, so they resolve from their stored name — the only stable
 * string a renamed or seeded row offers.
 */
export interface StatusDisplayOption {
  value: string;
  label: string;
  stableCode?: string;
}

export function tagStaticStatusOption(option: { value: string; labelKey?: string }, label: string): StatusDisplayOption {
  return {
    value: option.value,
    label,
    ...(option.labelKey ? { stableCode: option.value } : {}),
  };
}

export function statusDisplayInput(option: StatusDisplayOption): string {
  return option.stableCode ?? option.label;
}
