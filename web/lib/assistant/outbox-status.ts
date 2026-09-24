/** Expose only opaque outbox identity and operational state to assistant tools. */
export function projectOutboxFailure(row: Record<string, unknown>) {
  return {
    jobId: row.job_id,
    jobType: row.job_type,
    status: row.status,
    attempts: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
