import type { Profile } from "./types.ts";
import { generalContractor } from "./general-contractor.ts";
import { professionalServices } from "./professional-services.ts";
import { saasCompany } from "./saas.ts";

export type { Profile } from "./types.ts";

/** All built-in profiles, keyed by id. Community profiles register here. */
export const PROFILES: Record<string, Profile> = {
  [generalContractor.id]: generalContractor,
  [professionalServices.id]: professionalServices,
  [saasCompany.id]: saasCompany,
};

export function getProfile(id: string): Profile {
  const p = PROFILES[id];
  if (!p) {
    throw new Error(`unknown profile "${id}". available: ${Object.keys(PROFILES).join(", ")}`);
  }
  return p;
}

export function listProfiles(): Profile[] {
  return Object.values(PROFILES);
}
