# Git history rewrite operator runbook

This is the execution runbook for decision `dec_history_rewrite`. It is not a
routine maintenance procedure. Run it only in the separately approved
execution slice, during a scheduler-owned repository freeze. The tooling in
this directory never needs or records plaintext prohibited identifiers; it
loads only their SHA-256 fingerprints from `../check-history-hygiene.mjs`.

## Verification tooling

`npm run test:history-rewrite` is the machine-checkable rehearsal for this
tooling. It proves, before any destructive step is contemplated:

- callback generation parses the gate's hash set and fails closed on
  malformed, duplicated, or empty sets;
- the redaction simulation clears every violation the gate flags while
  leaving unflagged values byte-identical, and is idempotent;
- executing the generated Python callbacks under `python3` matches the
  JavaScript simulation byte for byte;
- a throwaway fixture repository under the system temp directory — never this
  repository — rehearsed with the real pinned `git-filter-repo` produces
  exactly the simulated survivors (deep nesting purged, lookalike names such
  as `objects-list.md` kept), zero residual violations, preserved commit
  count, tags, branches, blob contents, and a complete commit map; and
- the read-only dry-run passes against the current history.

The suite asserts the canonical repository's HEAD is unchanged across the
rehearsal. If `git-filter-repo` is absent the rehearsal reports an explicit
skip; every other check still runs.

## Preconditions and freeze

The scheduler/operator must confirm all of the following before creating any
recovery artifact or running the rewrite:

- The canonical checkout is on `main`, and every working tree is fully
  committed and clean. Inventory them with `git worktree list --porcelain` and
  preserve that inventory outside the repository for the refresh step.
- There are **zero live bb workers** for this project, including hidden
  workers. Inspect `bb thread list --project <openbooks-project-id>
  --include-hidden --json`; stop or finish every active worker and obtain an
  explicit scheduler sign-off.
- The scheduler has confirmed quiescence: no queued work may start, no
  automation may run, and no person or integration may create commits or move
  refs until publication and worktree refresh are complete. Inspect scheduled
  work with `bb automation list --project <openbooks-project-id>` as part of
  that sign-off.
- `git status --porcelain=v1` is empty in every worktree, local `main` is the
  exact approved source head, and the expected remote `main` SHA has been
  recorded outside the repository.
- `/opt/homebrew/bin/git-filter-repo` exists. Record its version with
  `/opt/homebrew/bin/git-filter-repo --version`; retest this tooling if the
  version differs from the rehearsed version.
- `npm run test:history-rewrite` passes immediately before the rewrite. Stop if
  any check fails or reports an unexpected skip on this platform.
- `node scripts/history-rewrite/dry-run.mjs` exits 0 immediately before the
  rewrite. Stop if it reports an uncovered path, an unexpected purge match, a
  residual violation, or a sibling self-audit failure.

Keep the same shell session through the rewrite so the captured remote values
below remain available. Treat every old commit SHA as invalid after execution.

## 1. Create recovery artifacts

From the canonical checkout, set `repo` to its absolute path. The mirror must
be a sibling of the repository, never a directory inside it. The destination
must not already exist; stop and investigate rather than replacing an existing
backup.

```sh
repo=/absolute/path/to/openbooks
cd "$repo"

pre_rewrite_head="$(git rev-parse HEAD)"
origin_url="$(git remote get-url origin)"
old_origin_main="$(git ls-remote --exit-code origin refs/heads/main | awk '{print $1}')"

git tag pre-rewrite-backup "$pre_rewrite_head"
git show-ref --verify refs/tags/pre-rewrite-backup

git clone --mirror "$repo" ../openbooks-pre-rewrite-backup.git
git --git-dir=../openbooks-pre-rewrite-backup.git fsck --full
test "$(git --git-dir=../openbooks-pre-rewrite-backup.git rev-parse refs/tags/pre-rewrite-backup)" = "$pre_rewrite_head"
```

The required backup command in template form is:

```sh
git clone --mirror <repo> ../openbooks-pre-rewrite-backup.git
```

The local tag is exactly `refs/tags/pre-rewrite-backup`. Because the rewrite
processes all local refs, the working repository's copy of that tag will move
onto rewritten history. The mirror's copy is the recovery reference that
retains the original SHA. Record the backup path, `pre_rewrite_head`,
`old_origin_main`, and `origin_url` in the out-of-repository operator record.

## 2. Execute the approved rewrite

Generate both callback bodies directly from the gate's hash set, then pass
them to the pinned executable. Do not hand-edit a callback and do not add a
plaintext replacement map.

```sh
cd "$repo"

filename_callback="$(node scripts/history-rewrite/build-callbacks.mjs --filename)"
message_callback="$(node scripts/history-rewrite/build-callbacks.mjs --message)"

/opt/homebrew/bin/git-filter-repo \
  --force \
  --invert-paths \
  --path '.local/tenant-migrations' \
  --path-glob '*/.local/tenant-migrations' \
  --path-glob '*/.local/tenant-migrations/*' \
  --path 'account-data' \
  --path-glob '*/account-data' \
  --path-glob '*/account-data/*' \
  --path 'extraction' \
  --path-glob '*/extraction' \
  --path-glob '*/extraction/*' \
  --path-glob 'objects-list.txt' \
  --path-glob '*/objects-list.txt' \
  --filename-callback "$filename_callback" \
  --message-callback "$message_callback"

unset filename_callback message_callback
```

The inverted path selection purges all four prohibited private-data path
classes. The filename and message callbacks lowercase and hash both gate token
forms, replacing every match with the literal `[REDACTED]`. The filename
callback also preserves filter-repo's `None` sentinel for already-purged paths.

This is a full-ref rewrite, not a `--refs`/partial rewrite. Git-filter-repo
rewrites **all commit SHAs** and updates all local refs, including worktree
branches and the local backup tag. It also strips the `origin` remote
configuration after a normal full rewrite. The external mirror is therefore
the rollback boundary, and the captured remote values are required for
publication.

If the command fails or reports a filename collision, stop. Do not improvise a
second rewrite, restore refs, delete the mirror, or publish a partial result.
Escalate with the command output and the external backup coordinates.

## 3. Verify the rewritten repository

Do not restore the remote or publish until every check is green:

```sh
node scripts/history-rewrite/dry-run.mjs
npm run check:history-hygiene
npm run typecheck --workspaces --if-present
npm run verify:release

new_head="$(git rev-parse HEAD)"
git status --short --branch
git log -1 --format='%H %s'
```

`npm run check:history-hygiene` must exit 0; it scans paths from `git rev-list
--objects --all` and subjects from `git log --all`, so this is a full-history,
all-ref gate rather than a current-tree check. The explicit workspace
typecheck must be green, and every suite mandated by the scheduler's execution
handoff must also be green; `npm run verify:release` is the repository's
current aggregate release gate. Record every command and exit status.

The dry-run should now report zero current violations, zero simulated residual
violations, and a clean sibling self-audit. Record `pre_rewrite_head` and
`new_head`, and preserve `.git/filter-repo/commit-map` with the external
operator artifacts. Report `new_head` as the new canonical HEAD SHA.

Any nonzero verification result blocks publication. Roll back only from the
external mirror under scheduler direction; do not try to join old and new
histories.

## 4. Publish and refresh bb worktrees

Git-filter-repo normally removes `origin`. Recreate it from the value captured
before the rewrite, verify the URL, and publish `main` with an explicit lease
against the captured old remote SHA. The explicit lease prevents overwriting a
remote update that escaped the freeze.

```sh
git remote add origin "$origin_url"
test "$(git remote get-url origin)" = "$origin_url"

git push \
  --force-with-lease=refs/heads/main:"$old_origin_main" \
  origin HEAD:main

test "$(git ls-remote --exit-code origin refs/heads/main | awk '{print $1}')" = "$new_head"
```

Do not use an unleased `--force`, and do not push the recovery tag. If the
lease rejects the push, the repository freeze was violated or the captured
state was wrong; stop and investigate.

While the scheduler freeze remains in force, refresh every path from the saved
`git worktree list --porcelain` inventory:

1. Confirm its bb worker is still stopped and its pre-rewrite status was
   recorded clean.
2. Resolve its checked-out branch and confirm that branch was rewritten. A
   branch processed by this full-ref rewrite already points into the new
   graph; do not rebase those commits a second time.
3. Refresh the clean worktree's index and files to its rewritten branch tip,
   then verify `git status --porcelain=v1` is empty and `git merge-base
   --is-ancestor main <branch>` succeeds where that ancestry is expected.
   Recreating a bb-managed environment from its rewritten branch is preferred
   when there is any uncertainty about stale worktree state.
4. Any branch or worktree that was not present in the rewrite must remain
   stopped until its unique commits are rebased or cherry-picked onto the new
   `main`, reviewed, and verified. Never merge the old graph into the new one.
5. Update bb environment metadata/merge-base expectations to rewritten
   `main`, recreate or reopen the managed environments, and only then ask the
   scheduler to release queued workers and automations.

For a confirmed-clean worktree whose symbolic branch was included in the
rewrite, the explicit refresh is:

```sh
worktree=/absolute/path/from/the/saved-inventory
branch="$(git -C "$worktree" symbolic-ref --short HEAD)"
git -C "$worktree" reset --hard "$branch"
test -z "$(git -C "$worktree" status --porcelain=v1)"
```

`reset --hard` is authorized here only for a path individually matched to the
saved clean-worktree inventory after all workers are stopped. Never put the
inventory into an unchecked recursive loop, and never run the refresh against
an uncommitted worktree.

Finish by reporting the external mirror path, old and new canonical SHAs, the
successful force-with-lease publication, verification results, and the status
of every bb-managed worktree. Keep the mirror until the owner explicitly ends
the recovery-retention period.
