/**
 * Validate the Dutch burgerservicenummer's nine-digit shape and statutory
 * 11-proef. RvIG describes the test as mandatory for assigning or accepting
 * a BSN (Handreiking BSN voor Gebruikers: https://www.rvig.nl/handreiking-bsn-gebruikers).
 */
export function isValidBsn(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !/^\d{9}$/.test(value)) return false;
  const weights = [9n, 8n, 7n, 6n, 5n, 4n, 3n, 2n, -1n] as const;
  let sum = 0n;
  for (let index = 0; index < weights.length; index += 1) {
    sum += BigInt(value[index]!) * weights[index]!;
  }
  return sum % 11n === 0n;
}
