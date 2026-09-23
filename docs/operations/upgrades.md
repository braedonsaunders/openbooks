# Upgrade and rollback runbook

OpenBooks migrations are forward-only. Running an older application image
against a database that has already been migrated is not a rollback.

## Before production

1. Read release notes and identify database, configuration, connector, and
   infrastructure changes.
2. Resolve a post-clean, scanned target application to an immutable image
   digest. Update `OPENBOOKS_IMAGE` deliberately; do not use an old package,
   a mutable tag, or `latest`.
3. Produce a fresh deployment recovery set: PostgreSQL, object storage, secrets,
   configuration, and the current image digest.
4. Restore that set into isolated infrastructure using
   [the recovery runbook](backup-restore.md). Record the measured RPO/RTO.
5. Upgrade the restored copy first. Run bootstrap once, wait for it to complete,
   then start web and worker processes.
6. Exercise health, sign-in, authorization, worker heartbeat, attachments,
   reports, a reversible draft transaction, reconciliation/report totals, and
   jurisdiction-specific controls. Review migration and application logs.
7. Obtain business-owner acceptance for the tested maintenance window and
   rollback point.

## Compose upgrade

The included Compose stack is one host and is not highly available. Schedule a
maintenance window:

```bash
docker compose --env-file .env.compose stop web worker
docker compose --env-file .env.compose pull
docker compose --env-file .env.compose up -d --wait --wait-timeout 300
docker compose --env-file .env.compose ps
curl --fail http://localhost:4780/api/v1/health?include=worker
```

`bootstrap` is a one-shot service. Web starts only after it succeeds. Preserve
its logs with the change record. Do not use `docker compose down -v` during an
upgrade; that deletes named data volumes.

The repository pins PostgreSQL, Redis, MinIO, and the MinIO client to explicit
release tags and multi-platform digests. Upgrade those components separately according to their upstream
compatibility and backup procedures. Changing the application and every stateful
dependency in one maintenance event makes failure attribution and rollback much
harder.

## HA application-tier upgrade

The Kubernetes reference under `deploy/ha` uses a separate bootstrap Job and
multiple web/worker replicas. The order is:

1. stop or pause mutating workers as required by the release notes;
2. run the new bootstrap Job to completion against the controlled owner URL;
3. roll web pods and verify readiness/error rate;
4. roll worker pods and verify queue/heartbeat health; and
5. complete accounting and attachment smoke checks.

Database, Redis, S3, ingress, secret management, observability, and backup HA
are external responsibilities in that example.

## Swarm release from CI

The reference swarm installation releases itself from a version tag. Pushing
`v<version>` runs `publish-container.yml`: the tagged commit must already have
a green `test` run and a passing upgrade rehearsal (below), both architectures are built and scanned, the merged image
is attested, and then `deploy-production.yml` runs on the self-hosted runner
that shares a network with the swarm manager. That job connects to the
manager over ssh with a dedicated deploy key and executes
`deploy/swarm-release.sh` for the attested digest: migrations apply first from
the exact image being released, both service pins swap only if the migration
chain succeeds, and the job stays red until the health endpoint reports the
tagged version. Manual edge publishes never deploy.

The deploy job reads its settings from the `production` GitHub environment,
whose deployment policy admits only `v*` tags:

| setting | kind | value |
| --- | --- | --- |
| `PRODUCTION_DEPLOY_SSH_KEY` | secret | private half of a key authorized on the manager with `no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding` |
| `PRODUCTION_SSH_KNOWN_HOSTS` | variable | the manager's host key line, so an unknown key aborts the release |
| `PRODUCTION_SSH_HOST` / `PRODUCTION_SSH_USER` | variable | the manager and the account that can run `docker` with `sudo` |
| `PRODUCTION_HEALTH_URL` | variable | the public `/api/v1/health` URL whose `version` must match the tag |

To re-deploy or roll back to an earlier attested digest, run
`deploy-production.yml` manually from the release tag ref with the digest and
the version the health endpoint should report. The release script leaves the
previous Dokploy compose file and env under
`/home/<user>/openbooks-deploy-backup-<stamp>/` on the manager; restoring that
compose file into Dokploy and redeploying is the application-tier rollback
when no migration changed the schema.

## Release gate: upgrade rehearsal

Every install upgrades in place: bootstrap applies the pending migrations over
whatever data that install holds. A release is therefore only as safe as its
migrations are on data that earlier releases wrote. Proving that on a fresh
database proves nothing about it. `upgrade-rehearsal.yml` is the release gate
for it. It is deliberately NOT part of per-commit CI: it spins up every dataset
for every supported source release, and that cost belongs to releases.

Start it on the exact release-candidate commit:

```bash
git push origin "${SHA}:refs/heads/upgrade-rehearsal/${SHA:0:9}"
```

`publish-container.yml` refuses a `v*` tag whose commit has no successful
`upgrade-verification` job, just as it refuses one without an exhaustive
`test` run. Delete the branch once the release is out.

Each cell of the matrix is one (source release, dataset) pair, as planned by
`scripts/upgrade-rehearsal/plan.mjs` from `scripts/upgrade-rehearsal/rehearsal.json`.
A cell runs `scripts/upgrade-rehearsal/rehearse.mjs`:

1. Install the source release (its own bootstrap), then seed the dataset with
   the source release's own tooling (simulation, sample-company templates, or
   a seeder driving the source's engine). A real install holds data that its
   own version wrote.
2. Run the source release's golden harness on every seeded org, so the data is
   proven clean before the upgrade touches it.
3. Fingerprint the ledger with version-tolerant SQL. That covers the trial
   balance per book, account, and currency; document totals and open balances;
   applications; row counts; and unbalanced posted entries.
4. Upgrade with the candidate's bootstrap and record each migration's time.
5. Refuse unless every candidate migration is recorded as applied, a second
   bootstrap applies nothing, the ledger fingerprint is identical, the
   candidate's golden harness passes on every org with activity, and the
   upgraded schema catalog equals a fresh install's.

The job summary lists each cell's phases and slowest migrations. The artifact
holds the before and after fingerprints and the catalog comparison.

**Sources.** After each release, add its tag to `sources` in
`rehearsal.json`. Drop a source only when upgrading from it stops being
supported, and say so in the release notes.

**Datasets.** Every class in `requiredDatasetClasses` must have a dataset, and
the plan refuses otherwise. The classes are: `empty`, `small`, `perf-1m` (a
ledger of about a million lines), `multi-entity` (multiple currencies and
subsidiaries), `samples`, `simulation`, and `edge` (deliberately awkward
histories). A seeder lives in `scripts/upgrade-rehearsal/seeders/<name>.ts`.
It is copied into the source tree, runs on the source release's runtime, and
must print `{"orgIds": [...]}` as its last JSON line. It may use only engine
APIs present in every supported source release.

## Rollback

If bootstrap did not change the schema, reverting the application digest may be
possible after confirming compatibility. Once a migration has applied, recover
the pre-upgrade PostgreSQL and object-storage recovery set into clean
infrastructure and start the matching prior image. Preserve the failed target
for investigation. Never attempt an improvised reverse migration on the only
copy of financial data.

Declare rollback complete only after restored checksums, constraints, ledger
totals, attachments, authentication, worker processing, and business acceptance
all pass.
