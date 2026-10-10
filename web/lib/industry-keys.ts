/**
 * Client-safe industry registry keys. The registry itself
 * (`web/lib/industries.ts`) is server-only; surfaces that only need to name a
 * preset import its key from here.
 */

/**
 * The neutral preset: a general chart of accounts and no feature opinions.
 * It is the chart a company starts on when no industry template fits and
 * the operator chooses features individually.
 */
export const NEUTRAL_INDUSTRY_KEY = 'general_business'
