/**
 * Posting contributors: the seam through which domain modules take part in
 * document posting, editing and voiding without the ledger importing them.
 *
 * Four hook kinds, each a typed contract in its own file:
 *
 *   - line contributions (posting-line-contributors.ts): accounts and lines
 *     a domain supplies before the kernel builds the entry;
 *   - preconditions (posting-preconditions.ts): refusals and required state
 *     a domain establishes before the accounting transaction writes;
 *   - effects (posting-effect-contributors.ts): subledger, automation and
 *     event effects of a committed posting;
 *   - void remedies (void-remedy-contributors.ts): domain reversals that
 *     run inside a void.
 *
 * Each domain registers its hooks under its own module name, and
 * composition/posting-contributors.ts installs every domain once per process
 * in one fixed order. Ordering is the ledger's: it resolves a contributor at
 * the exact statement that needs it, so hooks run in the ledger's statement
 * order and registration order never changes which hook runs first.
 *
 * Fail closed: a posting that reaches a hook whose domain was never installed
 * refuses with PostingContributorMissingError instead of skipping the hook. A
 * posting that reaches no hook needs nothing installed.
 *
 * Registration is keyed and idempotent: registering a domain again replaces
 * its hooks, so installing twice never runs a hook twice.
 */

export type PostingHookKind = "line contribution" | "precondition" | "effect" | "void remedy";

/** The installer every process that posts runs at start. */
export const POSTING_CONTRIBUTOR_INSTALLER =
  "installPostingContributors() (engine/src/composition/posting-contributors.ts, run by installEngineSeams())";

/** A posting reached a domain hook that this process never installed. */
export class PostingContributorMissingError extends Error {
  readonly code = "posting_contributor_missing";

  constructor(
    readonly kind: PostingHookKind,
    readonly domain: string,
  ) {
    super(
      `The ${domain} ${kind} hook is not installed in this process; call ${POSTING_CONTRIBUTOR_INSTALLER} before posting.`,
    );
    this.name = "PostingContributorMissingError";
  }
}

export interface PostingContributorRegistry<M extends object> {
  /** Register (or replace) one domain's hooks. */
  register<K extends keyof M & string>(domain: K, hooks: M[K]): void;
  /** The domain's hooks, or a PostingContributorMissingError refusal. */
  require<K extends keyof M & string>(domain: K): M[K];
  /** Installed domain names, in first-registration order. */
  installed(): (keyof M & string)[];
  /** Remove every registration. Tests only. */
  clear(): void;
}

export function postingContributorRegistry<M extends object>(
  kind: PostingHookKind,
): PostingContributorRegistry<M> {
  const hooks = new Map<keyof M & string, M[keyof M & string]>();
  return {
    register(domain, contributor) {
      hooks.set(domain, contributor);
    },
    require<K extends keyof M & string>(domain: K): M[K] {
      const contributor = hooks.get(domain);
      if (contributor === undefined) throw new PostingContributorMissingError(kind, domain);
      return contributor as M[K];
    },
    installed: () => [...hooks.keys()],
    clear: () => hooks.clear(),
  };
}
