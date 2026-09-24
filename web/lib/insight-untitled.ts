/**
 * Stored names for unnamed insight cards and dashboards (F4T-8/F4T2-9).
 *
 * These are STORED CODES, never display copy: every read path renders them
 * through the localized `cardStudio.untitled` / `builder.untitled` keys, and
 * the publish routes refuse them by name. Persisting a TRANSLATED string
 * here (as NewDashboardButton once did with `builder.untitled`) writes a
 * name no sentinel check recognizes, so an "untitled" board in another
 * language sails through the publish gate. Import these — never re-spell
 * the English, and never store `t('...untitled')`.
 */
export const UNTITLED_CARD_NAME = 'Untitled card'

export const UNTITLED_DASHBOARD_NAME = 'Untitled dashboard'
