# HA-ready application-tier reference

This directory is a Kubernetes reference for running more than one OpenBooks
web and worker process. It is not, by itself, a highly available OpenBooks
deployment. Overall availability is bounded by PostgreSQL, Redis, object
storage, ingress/DNS, secrets, and the cluster control plane.

The ordinary `compose.yaml` remains a single-host evaluation/small-deployment
topology. Adding Compose replicas on the same host does not remove that host as
a failure domain.

## External prerequisites

Provide and test:

- PostgreSQL 16 with automated failover, backups/PITR, connection limits, and a
  constrained runtime role separate from the schema owner;
- a Redis topology supported by BullMQ, with authentication, persistence,
  failover, and alerting;
- S3-compatible object storage with versioning/replication and tested recovery;
- a TLS ingress/load balancer with health-based routing;
- a secret manager and rotation procedure;
- at least two Kubernetes nodes/failure zones for pod spreading; and
- centralized logs, metrics, traces, alerts, and an on-call runbook.

Validate each provider's consistency and failover behavior with OpenBooks.
These manifests do not install or claim HA for those dependencies.

## Secrets

Create secrets out of band. Do not commit values or leave them in shell history.
`openbooks-runtime` must provide:

- `OPENBOOKS_DB_URL`
- `OPENBOOKS_REDIS_URL`
- `SESSION_SECRET`
- `OPENBOOKS_DATA_KEY`
- `OPENBOOKS_INTERNAL_TOKEN`
- `S3_ENDPOINT`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

`openbooks-bootstrap` must provide `OPENBOOKS_MIGRATION_DB_URL` and
`OPENBOOKS_RUNTIME_DB_URL`. The migration URL is exposed only to the one-shot
Job. For a first installation, also provide `ORG_CURRENCY`, `ORG_COUNTRY`, and
the intentionally managed initial administrator inputs.

## Deploy or upgrade

The manifests deliberately use an unreachable `example.invalid` image and a
zero digest. Do not substitute a historical OpenBooks package. Replace the
placeholder only with an immutable multi-platform digest built from the
remediated clean-history source and accepted by post-build security/privacy
scans. Then:

1. Apply `configuration.yaml` after setting the public URL, region, and bucket.
2. Apply `bootstrap-job.yaml` and wait for the Job to succeed.
3. Preserve its logs as deployment evidence.
4. Apply `application.yaml` only after bootstrap completion.
5. Configure TLS ingress to the `openbooks-web` Service.
6. Verify web readiness, worker heartbeat, queue processing, object access, and
   representative accounting/report workflows.

The bootstrap itself also takes the OpenBooks PostgreSQL deployment advisory
lock, but sequencing the Job before the Deployments keeps failure visible and
prevents a new application revision from racing an incomplete migration.

The Deployments use three web pods and two workers, pod anti-affinity, topology
spread, rolling updates, disruption budgets, non-root execution, read-only root
filesystems, and bounded resources. Tune replicas and resources from measured
load; more workers are not automatically better for every accounting workload.

## Failure testing

Before calling the resulting system HA, test at least:

- loss of a web pod, worker pod, node, and availability zone;
- PostgreSQL primary failover during reads, writes, and posting;
- Redis failover with queued and in-flight work;
- object-store and DNS/network interruption;
- a bootstrap Job failure before rollout;
- backup restoration into a separate cluster; and
- recovery while a posting or integration job is in flight.

Measure error rate, recovery time, duplicate/missing work, queue lag, and ledger
invariants. Document residual single points of failure and compare measured
results with the declared RPO, RTO, and service objective.
