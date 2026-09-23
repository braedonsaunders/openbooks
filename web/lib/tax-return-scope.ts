/**
 * Shared filing-entity scope + translation parsing for the tax return
 * surfaces. The preview GET (`/api/tax/returns/[code]`) and the prepare POST
 * (`/api/tax/filings`) accept the SAME scope in different envelopes (query
 * params vs JSON body) and must validate it identically — a scope the preview
 * accepts but prepare rejects (or vice versa) strands the filer between two
 * disagreeing surfaces. Both routes parse here and pass the result straight
 * to `computeTaxReturn`; value-level validation (UUID shape, org membership,
 * currency codes) stays in the engine so the two paths can never drift.
 */

export interface ReturnTranslationRequest {
  presentationCurrency: string;
  rateType?: string;
  rateDate?: string;
}

export interface ReturnScopeRequest {
  /**
   * Requested subsidiary scope. Empty means the org-wide return — unless a
   * `registrationId` pins a registration, which keeps the org-wide sums
   * under that registration's number.
   */
  subsidiaryIds: string[];
  registrationId?: string;
  translation?: ReturnTranslationRequest;
}

export interface ParsedReturnScope {
  scope?: ReturnScopeRequest;
  error?: string;
}

function translationFromParts(parts: {
  presentationCurrency?: unknown;
  rateType?: unknown;
  rateDate?: unknown;
}): { translation?: ReturnTranslationRequest; error?: string } {
  for (const [name, value] of [
    ["presentationCurrency", parts.presentationCurrency],
    ["rateType", parts.rateType],
    ["rateDate", parts.rateDate],
  ] as const) {
    if (value !== undefined && typeof value !== "string") {
      return { error: `invalid translation: ${name} must be a string` };
    }
  }
  const currency =
    typeof parts.presentationCurrency === "string" ? parts.presentationCurrency.trim() : "";
  const type =
    typeof parts.rateType === "string" ? parts.rateType.trim() || undefined : undefined;
  const date =
    typeof parts.rateDate === "string" ? parts.rateDate.trim() || undefined : undefined;
  return {
    translation: {
      presentationCurrency: currency,
      ...(type ? { rateType: type } : {}),
      ...(date ? { rateDate: date } : {}),
    },
  };
}

/**
 * Parse the preview-style query params (`subsidiary` repeat/comma-separated,
 * `registration`, `presentationCurrency` + optional `rateType`/`rateDate`).
 * An explicitly empty subsidiary filter is a caller error, not the org-wide
 * return — unless a registration pin carries the scope.
 */
export function parseReturnScopeQuery(p: URLSearchParams): ParsedReturnScope {
  const subsidiaryIds = p
    .getAll("subsidiary")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  const registrationId = p.get("registration")?.trim() || undefined;
  if (p.has("subsidiary") && subsidiaryIds.length === 0 && !registrationId) {
    return { error: "subsidiary filter is empty" };
  }
  const presentationCurrency = p.get("presentationCurrency")?.trim() || undefined;
  const rateType = p.get("rateType")?.trim() || undefined;
  const rateDate = p.get("rateDate")?.trim() || undefined;
  if (!presentationCurrency && !rateType && !rateDate) {
    return {
      scope: {
        subsidiaryIds,
        ...(registrationId ? { registrationId } : {}),
      },
    };
  }
  const { translation, error } = translationFromParts({
    presentationCurrency,
    rateType,
    rateDate,
  });
  if (error) return { error };
  return {
    scope: {
      subsidiaryIds,
      ...(registrationId ? { registrationId } : {}),
      ...(translation ? { translation } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse the prepare-POST JSON scope (`filingEntity` +
 * `translation`). Same rules as the query envelope: trimmed ids, empties
 * dropped, an empty scope without a registration pin refused, translation
 * passed through for the engine to validate by name.
 */
export function parseReturnScopeBody(body: {
  filingEntity?: unknown;
  translation?: unknown;
}): ParsedReturnScope {
  let subsidiaryIds: string[] = [];
  let registrationId: string | undefined;
  if (body.filingEntity !== undefined) {
    if (!isRecord(body.filingEntity)) {
      return { error: "invalid filing entity" };
    }
    const { subsidiaryIds: rawIds, registrationId: rawRegistration } = body.filingEntity;
    if (rawIds !== undefined) {
      if (!Array.isArray(rawIds)) {
        return { error: "invalid filing entity: subsidiaryIds must be an array" };
      }
      const ids: string[] = [];
      for (const id of rawIds) {
        if (typeof id !== "string") {
          return { error: "invalid filing entity: subsidiaryIds must be an array" };
        }
        const trimmed = id.trim();
        if (trimmed) ids.push(trimmed);
      }
      subsidiaryIds = ids;
    }
    if (rawRegistration !== undefined) {
      if (typeof rawRegistration !== "string") {
        return { error: "invalid filing entity: registrationId must be a string" };
      }
      registrationId = rawRegistration.trim() || undefined;
    }
    if (subsidiaryIds.length === 0 && !registrationId) {
      return { error: "subsidiary filter is empty" };
    }
  }
  if (body.translation !== undefined) {
    if (!isRecord(body.translation)) {
      return { error: "invalid translation" };
    }
    const { translation, error } = translationFromParts({
      presentationCurrency: body.translation["presentationCurrency"],
      rateType: body.translation["rateType"],
      rateDate: body.translation["rateDate"],
    });
    if (error) return { error };
    return {
      scope: {
        subsidiaryIds,
        ...(registrationId ? { registrationId } : {}),
        ...(translation ? { translation } : {}),
      },
    };
  }
  return {
    scope: {
      subsidiaryIds,
      ...(registrationId ? { registrationId } : {}),
    },
  };
}

/**
 * Build the `computeTaxReturn` options for a parsed scope. A scope with
 * neither subsidiaries nor a registration pin is the org-wide return and
 * carries no filing entity; a registration-only pin travels with an empty
 * subsidiary set, which the engine reads as org-wide-under-that-number.
 */
export function returnScopeOpts(scope: ReturnScopeRequest): {
  filingEntity?: { subsidiaryIds: string[]; registrationId?: string };
  translation?: ReturnTranslationRequest;
} {
  const filingEntity =
    scope.subsidiaryIds.length > 0 || scope.registrationId
      ? {
          subsidiaryIds: scope.subsidiaryIds,
          ...(scope.registrationId ? { registrationId: scope.registrationId } : {}),
        }
      : undefined;
  return {
    ...(filingEntity ? { filingEntity } : {}),
    ...(scope.translation ? { translation: scope.translation } : {}),
  };
}
