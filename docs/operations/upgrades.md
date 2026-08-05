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
