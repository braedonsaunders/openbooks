import { mergeHref } from '../../../../lib/list-params'

/**
 * The workspace Settings tab shows one concept at a time: the connector
 * configuration, or one of the channel-scoped setup entities. An explicit
 * `section` param always wins; without one, a legacy row deep link
 * (`?spendRow=`, `?locationRow=`, `?mapRow=`) opens its own section so
 * bookmarked editors keep working. Anything else is the posting section.
 */
export type SettingsSectionKey = 'connection' | 'posting' | 'locations' | 'adspend'

export const SETTINGS_ENTITY_SECTIONS = [
  { key: 'posting', entityKey: 'channel-account-maps', rowParam: 'mapRow', paramPrefix: 'map' },
  { key: 'locations', entityKey: 'channel-locations', rowParam: 'locationRow', paramPrefix: 'location' },
  { key: 'adspend', entityKey: 'channel-ad-spend', rowParam: 'spendRow', paramPrefix: 'spend' },
] as const

export type SettingsEntitySection = (typeof SETTINGS_ENTITY_SECTIONS)[number]

const KNOWN_SECTIONS: readonly string[] = ['connection', 'posting', 'locations', 'adspend']

export function resolveSettingsSection(
  sp: Record<string, string | string[] | undefined>,
): SettingsSectionKey {
  const raw = typeof sp.section === 'string' ? sp.section : ''
  if ((KNOWN_SECTIONS as readonly string[]).includes(raw)) return raw as SettingsSectionKey
  if (raw === '') {
    if (typeof sp.spendRow === 'string') return 'adspend'
    if (typeof sp.locationRow === 'string') return 'locations'
    if (typeof sp.mapRow === 'string') return 'posting'
  }
  return 'posting'
}

/**
 * Subtab links keep every unrelated filter and only move the section,
 * closing row drawers from the section being left.
 */
export function settingsSectionHref(
  channelId: string,
  sp: Record<string, string | string[] | undefined>,
  key: SettingsSectionKey,
): string {
  return mergeHref(`/channels/${channelId}`, sp, {
    tab: 'settings',
    section: key,
    mapRow: undefined,
    locationRow: undefined,
    spendRow: undefined,
  })
}
