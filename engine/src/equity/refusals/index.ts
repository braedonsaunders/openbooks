/**
 * Every equity refusal, by catalog key. Each entry carries its stable API
 * code, its English templates and the kind of each figure its templates
 * name; the locale catalogs hold the same entries under `refusals.equity`.
 */
import type { RefusalSpec, RefusalValue } from "../../platform/catalog-refusal.ts";
import { COMMON_REFUSALS } from "./common.ts";
import { EVENT_REFUSALS } from "./events.ts";
import { GOVERNANCE_REFUSALS } from "./governance.ts";
import { MODEL_REFUSALS } from "./models.ts";
import { RUN_REFUSALS } from "./runs.ts";
import { SECURITY_REFUSALS } from "./securities.ts";
import { STRUCTURE_REFUSALS } from "./structure.ts";

/** An equity catalog entry: a refusal answers 422 unless its entry names another status. */
export type EquityRefusalSpec = RefusalSpec & { readonly status?: 403 | 404 | 409 | 422 };

export const EQUITY_REFUSAL_AREAS = {
  common: COMMON_REFUSALS,
  events: EVENT_REFUSALS,
  governance: GOVERNANCE_REFUSALS,
  models: MODEL_REFUSALS,
  runs: RUN_REFUSALS,
  securities: SECURITY_REFUSALS,
  structure: STRUCTURE_REFUSALS,
} as const;

export const EQUITY_REFUSALS = {
  ...COMMON_REFUSALS,
  ...EVENT_REFUSALS,
  ...GOVERNANCE_REFUSALS,
  ...MODEL_REFUSALS,
  ...RUN_REFUSALS,
  ...SECURITY_REFUSALS,
  ...STRUCTURE_REFUSALS,
} as const satisfies Readonly<Record<string, EquityRefusalSpec>>;

export type EquityRefusalKey = keyof typeof EQUITY_REFUSALS;

type ParamsOf<K extends EquityRefusalKey> = (typeof EQUITY_REFUSALS)[K] extends {
  readonly params: infer P;
}
  ? P
  : Record<never, never>;

/** The figures one refusal takes, each of the kind its entry declares. */
export type EquityRefusalValues<K extends EquityRefusalKey> = {
  readonly [P in keyof ParamsOf<K>]: Extract<RefusalValue, { kind: ParamsOf<K>[P] }>;
};
