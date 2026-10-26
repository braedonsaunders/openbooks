"use client";

import type { ActionResult } from "@braedonsaunders/appkit-errors";
import { fetchAppAction } from "../../../lib/api-error";

/**
 * Client helpers shared by the compound-asset, proposal, construction,
 * maintenance and insurance workspaces: one JSON action path (refusals keep
 * their code, message and remedy) and exact cent arithmetic for previews.
 */
export function postJson<T = unknown>(
  url: string,
  body: unknown,
  fallback: string,
  method: "POST" | "PATCH" = "POST",
): Promise<ActionResult<T>> {
  return fetchAppAction<T>(
    url,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { fallback },
  );
}

export function newRequestKey(): string {
  return crypto.randomUUID();
}

const CENTS = /^(-)?(\d+)(?:\.(\d{1,4}))?$/;

/** Parse a decimal stated to the cent (ledger amounts may carry two trailing zero places) into cents, or null. */
export function toCents(value: string): bigint | null {
  const match = CENTS.exec(value.trim());
  if (!match) return null;
  const fraction = (match[3] ?? "").padEnd(4, "0");
  if (fraction.slice(2) !== "00") return null;
  const cents = BigInt(match[2]!) * 100n + BigInt(fraction.slice(0, 2));
  return match[1] ? -cents : cents;
}

export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  return `${negative ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

/** Split an amount into equal shares to the cent; leftover cents go to the first shares. */
export function evenSplit(amount: string, parts: number): string[] | null {
  const cents = toCents(amount);
  if (cents === null || cents <= 0n || !Number.isInteger(parts) || parts < 2) return null;
  const base = cents / BigInt(parts);
  const leftover = Number(cents - base * BigInt(parts));
  return Array.from({ length: parts }, (_, index) =>
    fromCents(base + (index < leftover ? 1n : 0n)),
  );
}

/** Sum decimal strings exactly; null when any value is not a two-place decimal. */
export function sumCents(values: readonly string[]): string | null {
  let total = 0n;
  for (const value of values) {
    const cents = toCents(value);
    if (cents === null) return null;
    total += cents;
  }
  return fromCents(total);
}
