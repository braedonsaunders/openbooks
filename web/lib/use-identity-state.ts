"use client";

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

function sameIdentity(left: readonly unknown[], right: readonly unknown[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  );
}

/** Local drafts and read results belong to the exact subject or request that
 * created them. A new identity resets before commit; late callbacks from an
 * earlier identity cannot overwrite the current subject. */
export function useIdentityState<T>(
  identity: readonly unknown[],
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const seed = (): T => (typeof initial === "function" ? (initial as () => T)() : initial);
  const [record, update] = useState(() => ({ identity: [...identity], value: seed() }));
  if (!sameIdentity(record.identity, identity)) {
    update({ identity: [...identity], value: seed() });
  }
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      update((current) => {
        if (current.identity !== record.identity) return current;
        const value =
          typeof action === "function" ? (action as (previous: T) => T)(current.value) : action;
        return Object.is(value, current.value) ? current : { ...current, value };
      });
    },
    [record.identity],
  );
  return [record.value, setValue];
}
