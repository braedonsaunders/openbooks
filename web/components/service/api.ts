"use client";

import { refusalMessageFromBody } from "../../lib/api-error";

/** A refusal as the server worded it, with its supported remedy and any assignment conflicts. */
export class ServiceRequestError extends Error {
  readonly remedy: string | null;
  readonly code: string | null;
  readonly conflicts: readonly ServiceConflict[];
  constructor(
    message: string,
    remedy: string | null,
    code: string | null,
    conflicts: readonly ServiceConflict[] = [],
  ) {
    super(message);
    this.remedy = remedy;
    this.code = code;
    this.conflicts = conflicts;
  }
}

export type ServiceConflict = {
  readonly code: string;
  readonly severity: "block" | "warn";
  readonly message: string;
};

/** JSON request to a service endpoint; refusals throw ServiceRequestError with the server's words. */
export async function serviceRequest<T>(
  url: string,
  init: RequestInit | undefined,
  fallback: string,
): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers:
      init?.body && !(init.body instanceof FormData)
        ? { "content-type": "application/json", ...(init?.headers ?? {}) }
        : init?.headers,
  });
  if (!response.ok) {
    let body: {
      error?: unknown;
      remedy?: unknown;
      code?: unknown;
      details?: { conflicts?: unknown };
    } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // A body that is not JSON keeps the fallback message.
    }
    const message =
      refusalMessageFromBody({ ...body, remedy: undefined }, { fallback }) ?? fallback;
    const conflicts = Array.isArray(body.details?.conflicts)
      ? (body.details.conflicts as ServiceConflict[])
      : [];
    throw new ServiceRequestError(
      message,
      typeof body.remedy === "string" ? body.remedy : null,
      typeof body.code === "string" ? body.code : null,
      conflicts,
    );
  }
  return (await response.json()) as T;
}

export function postJson<T>(
  url: string,
  body: unknown,
  fallback: string,
  method = "POST",
): Promise<T> {
  return serviceRequest<T>(url, { method, body: JSON.stringify(body) }, fallback);
}

export function refusalText(
  error: unknown,
  fallback: string,
): { message: string; remedy: string | null } {
  if (error instanceof ServiceRequestError) return { message: error.message, remedy: error.remedy };
  return { message: error instanceof Error ? error.message : fallback, remedy: null };
}
