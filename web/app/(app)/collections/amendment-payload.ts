/**
 * The amend request body from the Amendments form. Blank fields are omitted,
 * never sent as "": the route's typed schema refuses an empty uuid or date
 * (anchorSubscriptionId, termEndsOn, planVersionId), and a refused body reads
 * as an invalid request with no field named. An omitted name or reason keeps
 * the stored value instead of overwriting it with an empty one.
 */
export function amendmentRequestPayload<T extends Record<string, string>>(form: T): Partial<T> {
  const payload: Partial<T> = {};
  for (const key of Object.keys(form) as Array<keyof T>) {
    const value = form[key];
    if (value !== undefined && value.trim() !== "") payload[key] = value;
  }
  return payload;
}
