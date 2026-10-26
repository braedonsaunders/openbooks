import {
  replaceOpeningLevySourceAuthority,
  type OpeningLevySourceAuthorityInput,
  type OpeningLevySourceAuthorityResult,
} from "./opening-levy-source-authority.ts";
import type { OpeningLevySourceCorrection } from "./opening-levy-source-correction-authority.ts";

export type CorrectOpeningLevySourceInput = OpeningLevySourceAuthorityInput &
  OpeningLevySourceCorrection;

/** Corrects unissued original-source qualifications without changing their retained financial history. */
export async function correctOpeningLevySourceAuthority(
  input: CorrectOpeningLevySourceInput,
): Promise<OpeningLevySourceAuthorityResult> {
  const { requestId, expectedAuthorityId, expectedAllocationSha256, ...qualification } = input;
  return replaceOpeningLevySourceAuthority(qualification, {
    requestId,
    expectedAuthorityId,
    expectedAllocationSha256,
  });
}
