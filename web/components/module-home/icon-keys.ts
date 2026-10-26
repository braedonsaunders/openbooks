/**
 * Icon keys a spec may name for stat tiles, panels and directory items. Plain
 * data so authoring vocabularies can list them without importing the icon
 * components; the client icon map is typed against this list.
 */
export const HOME_ICON_KEYS = [
  'landmark', 'credit-card', 'list-checks', 'check-circle', 'arrow-left-right', 'badge-dollar',
  'building', 'briefcase', 'area-chart', 'triangle-alert', 'circle-alert', 'shield-check', 'wallet',
  'users', 'trending-up', 'timer', 'clipboard', 'clipboard-check', 'scroll-text', 'target',
  'calendar-clock', 'heart-pulse', 'gauge', 'coins', 'flag', 'scale', 'trending-down', 'pie-chart', 'history',
] as const

export type HomeIconKey = (typeof HOME_ICON_KEYS)[number]

/** Accent palette shared by stat tiles and cockpit chips. */
export const HOME_ACCENTS = ['teal', 'sky', 'violet', 'amber', 'emerald', 'red', 'slate', 'indigo'] as const
