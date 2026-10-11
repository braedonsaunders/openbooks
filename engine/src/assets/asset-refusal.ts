/**
 * A named, operator-facing refusal from the compound-asset, proposal,
 * construction-in-progress, maintenance and insurance services. `code` is a
 * stable snake_case key the UI can translate; `remedy` names an action that
 * exists in the product; `status` is the HTTP status the API boundary
 * answers with (4xx only).
 */
export class AssetRefusal extends Error {
  readonly name = "AssetRefusal";
  constructor(
    message: string,
    readonly code: string,
    readonly status: number = 422,
    readonly remedy?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function refuse(
  code: string,
  message: string,
  options: { status?: number; remedy?: string; details?: Record<string, unknown> } = {},
): never {
  throw new AssetRefusal(message, code, options.status ?? 422, options.remedy, options.details);
}
