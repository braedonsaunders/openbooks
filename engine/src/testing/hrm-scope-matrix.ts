/**
 * Legal-entity scope matrix for HRM integration suites.
 *
 * Every subsidiary-scope proof needs the same world: a scratch organization
 * whose root subsidiary (A) has a second legal entity (B) beneath it, the
 * feature flags the surface sits behind, and actors whose grants and
 * legal-entity lens come from the same role. A row declares the features,
 * the actors, what to seed, and the read and write proofs; the runner builds
 * a fresh world for every row and drops it afterwards, so rows never observe
 * each other's data.
 *
 * Actors default to an unrestricted `admin` and an A-restricted `scoped`
 * user, both holding the row's permissions. The runner requires a read or
 * a write proof; by convention a row shows both halves where the surface
 * has one: the cross-entity attempt refuses (and writes nothing), and the
 * same attempt inside the actor's lens still succeeds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "./fixtures.ts";
import { DB, enableFeatures, grantPermissions, linkPerson, mkSecondSubsidiary, refusalOf, scopeRole, type Refusal } from "./hrm-harness.ts";

/**
 * How an actor's lens is set. `all`, `A` and `B` restrict the actor's own
 * role and put the permissions on it; `direct` grants the permissions as
 * user overrides and leaves the role unrestricted.
 */
export type ActorScope = "all" | "A" | "B" | "direct";

export type ActorSpec = {
  scope: ActorScope;
  /** Defaults to the row's permissions. */
  permissions?: readonly string[];
  /**
   * Grant the permissions as user overrides while the role still carries the
   * lens, proving an override-sourced grant is fenced like a role grant.
   */
  overrides?: boolean;
  /** Link a person party: true mints the default name, a string names it. */
  link?: boolean | string;
};

export type ScopeWorld<K extends string = "admin"> = {
  org: ScratchOrg;
  orgId: string;
  subA: string;
  subB: string;
  /** Linked person party per actor that asked for `link`. */
  party: Record<K, string>;
} & { readonly [P in K]: string };

type DefaultActors = { admin: ActorSpec; scoped: ActorSpec };

export type ScopeRow<A extends Record<string, ActorSpec> = DefaultActors, C = undefined> = {
  /** The guarantee the row proves; it is the test title. */
  name: string;
  /** Feature flags the surface sits behind; `hrm` is always on. */
  features?: readonly string[];
  /** Permissions every actor holds unless its spec says otherwise. */
  permissions?: readonly string[];
  actors?: A;
  /** Second legal entity's currency and country; defaults match the root (CAD/CA). */
  subB?: { currency?: string; country?: string };
  seed?: (w: ScopeWorld<NoInfer<keyof A & string>>) => Promise<C>;
  read?: (w: ScopeWorld<NoInfer<keyof A & string>>, c: C) => Promise<void>;
  write?: (w: ScopeWorld<NoInfer<keyof A & string>>, c: C) => Promise<void>;
};

type World = Record<string, unknown>;
type Step = (w: World, c: unknown) => Promise<unknown>;

/** A row with its actor keys and seed type erased, as the runner holds it. */
export type MatrixRow = Omit<ScopeRow<Record<string, ActorSpec>>, "seed" | "read" | "write"> & {
  seed?: Step;
  read?: Step;
  write?: Step;
};

/** Fixes a row's actor keys and seed type for inference, then erases them. */
export function scopeRow<const A extends Record<string, ActorSpec> = DefaultActors, C = undefined>(
  row: ScopeRow<A, C>,
): MatrixRow {
  return row as unknown as MatrixRow;
}

const DEFAULT_ACTORS: DefaultActors = { admin: { scope: "all" }, scoped: { scope: "A" } };

async function buildWorld(row: MatrixRow): Promise<World & { orgId: string }> {
  const org = await createScratchOrg();
  const orgId = org.orgId;
  await enableFeatures(orgId, [...new Set(["hrm", ...(row.features ?? [])])]);
  const subA = org.subsidiaryId;
  const subB = await mkSecondSubsidiary(orgId, subA, row.subB);
  const ids: Record<string, string> = {};
  const party: Record<string, string> = {};
  for (const [key, spec] of Object.entries(row.actors ?? DEFAULT_ACTORS)) {
    const handle = `scope_${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;
    const userId = await createScratchUser(orgId, key, handle);
    const permissions = [...(spec.permissions ?? row.permissions ?? [])];
    if (spec.scope === "direct") {
      await grantPermissions(orgId, userId, permissions);
    } else {
      const lens = spec.scope === "all" ? "all" : [spec.scope === "A" ? subA : subB];
      await scopeRole(orgId, handle, spec.overrides ? [] : permissions, lens);
      if (spec.overrides) await grantPermissions(orgId, userId, permissions);
    }
    if (spec.link) {
      party[key] = await linkPerson(orgId, userId, typeof spec.link === "string" ? spec.link : undefined);
    }
    ids[key] = userId;
  }
  return { ...ids, org, orgId, subA, subB, party };
}

/**
 * Register one integration test per row. Each test builds its own world,
 * seeds, runs the read proof and then the write proof, and drops the org.
 */
export function scopeMatrix(rows: readonly MatrixRow[]): void {
  for (const row of rows) {
    assert.ok(row.read || row.write, `${row.name}: a scope row must prove a read or a write`);
    test(row.name, { skip: !DB }, async () => {
      const w = await buildWorld(row);
      try {
        const c = row.seed ? await row.seed(w, undefined) : undefined;
        if (row.read) await row.read(w, c);
        if (row.write) await row.write(w, c);
      } finally {
        await dropScratchOrg(w.orgId);
      }
    });
  }
}

/** The uniform not-found wording scope denials share with unknown ids. */
export const NOT_VISIBLE = /not visible in this organization/;

/**
 * Await a refusal of the expected class and, when given, message; return
 * the error so the caller can assert its code or structural fields.
 */
export async function refusal<E extends abstract new (...args: never[]) => Error>(
  promise: Promise<unknown>,
  expected: E,
  message?: RegExp | string,
): Promise<InstanceType<E>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof expected, `expected ${expected.name}, got ${String(error)}`);
    if (typeof message === "string") assert.equal(error.message, message);
    else if (message) assert.match(error.message, message);
    return error as InstanceType<E>;
  }
  throw new Error(`expected a ${expected.name} refusal, the call succeeded`);
}

/**
 * A cross-entity target must refuse exactly like a fabricated one, so the
 * refusal never confirms the hidden row exists. The calls run one after the
 * other; when `expected` is given both must be that refusal class. Returns
 * the shared refusal.
 */
export async function refusesLikeUnknown<E extends abstract new (...args: never[]) => Error>(
  hidden: () => Promise<unknown>,
  unknown: () => Promise<unknown>,
  expected?: E,
): Promise<Refusal> {
  const seen = await refusalOf(hidden(), expected);
  assert.deepEqual(seen, await refusalOf(unknown(), expected), "the hidden target must refuse identically to an unknown one");
  return seen;
}

/** Row count for `from ... where ...`, used to prove a refused write stored nothing. */
export async function countRows(from: SQL): Promise<number> {
  return (await db.execute<{ n: number }>(sql`select count(*)::int as n ${from}`)).rows[0]!.n;
}
