/**
 * Pacing for the sandbox clone. A clone copies a whole tenant inside one
 * transaction on the same primary that serves every live organization. Left
 * unpaced, a large tenant produces write-ahead log faster than the synchronous
 * standby and the checkpointer absorb, and every other session's commit waits
 * behind it. The clone therefore copies in bounded statements and pauses after
 * each one so that it stays within a write-ahead-log budget and never keeps the
 * primary busy more than a fixed share of the time.
 */

export interface ClonePacing {
  /** False when the operator has turned pacing off: the clone copies as fast as the primary allows. */
  paced: boolean;
  /** Write-ahead-log bytes per second the clone may produce on average. */
  walBytesPerSecond: number;
  /** Largest share of wall time the clone may spend executing statements, in (0, 1]. */
  dutyCycle: number;
  /** Rows copied per statement for tables that can be split by primary key. */
  chunkRows: number;
}

export const DEFAULT_CLONE_PACING: Readonly<ClonePacing> = {
  paced: true,
  walBytesPerSecond: 4 * 1024 * 1024,
  dutyCycle: 0.5,
  chunkRows: 5000,
};

/** The longest single pause, so one large statement cannot stall the clone for minutes. */
const MAX_PAUSE_MS = 30_000;

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number; received ${JSON.stringify(raw)}.`);
  }
  return value;
}

/**
 * Read the operator's pacing overrides. Malformed values refuse rather than
 * unthrottle. `OPENBOOKS_SANDBOX_CLONE_PACING=off` removes the write-ahead-log
 * budget and the duty cycle, so a clone finishes sooner at the cost of
 * slowing every other organization on the same primary while it runs.
 */
export function readClonePacing(env: NodeJS.ProcessEnv = process.env): ClonePacing {
  const mode = env.OPENBOOKS_SANDBOX_CLONE_PACING?.trim();
  if (mode !== undefined && mode !== "" && mode !== "on" && mode !== "off") {
    throw new Error(
      `OPENBOOKS_SANDBOX_CLONE_PACING must be "on" or "off"; received ${JSON.stringify(mode)}.`,
    );
  }
  const dutyCycle = positiveNumber(
    env,
    "OPENBOOKS_SANDBOX_CLONE_DUTY_CYCLE",
    DEFAULT_CLONE_PACING.dutyCycle,
  );
  if (dutyCycle > 1) {
    throw new Error(
      `OPENBOOKS_SANDBOX_CLONE_DUTY_CYCLE must be at most 1; received ${JSON.stringify(
        env.OPENBOOKS_SANDBOX_CLONE_DUTY_CYCLE,
      )}.`,
    );
  }
  const chunkRows = positiveNumber(
    env,
    "OPENBOOKS_SANDBOX_CLONE_CHUNK_ROWS",
    DEFAULT_CLONE_PACING.chunkRows,
  );
  if (!Number.isInteger(chunkRows)) {
    throw new Error(
      `OPENBOOKS_SANDBOX_CLONE_CHUNK_ROWS must be a whole number; received ${JSON.stringify(
        env.OPENBOOKS_SANDBOX_CLONE_CHUNK_ROWS,
      )}.`,
    );
  }
  if (mode === "off") {
    return { paced: false, walBytesPerSecond: Number.POSITIVE_INFINITY, dutyCycle: 1, chunkRows };
  }
  return {
    paced: true,
    walBytesPerSecond: positiveNumber(
      env,
      "OPENBOOKS_SANDBOX_CLONE_WAL_BYTES_PER_SECOND",
      DEFAULT_CLONE_PACING.walBytesPerSecond,
    ),
    dutyCycle,
    chunkRows,
  };
}

/** Current write-ahead-log position in bytes, or null when the role cannot read it. */
export type WalPositionReader = () => Promise<bigint | null>;

export interface ClonePacer {
  /** Pause as long as the budget requires after a statement completes. */
  afterStatement(): Promise<void>;
}

/**
 * Pace work measured from the last pause. The write-ahead-log position is
 * cluster-wide, so concurrent production writes count against the clone's
 * budget too: the clone yields more when the primary is already busy.
 */
export async function createClonePacer(
  pacing: ClonePacing,
  readWalPosition: WalPositionReader,
  clock: { now(): number; sleep(ms: number): Promise<void> } = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<ClonePacer> {
  if (!pacing.paced) return { afterStatement: async () => {} };
  let startedAt = clock.now();
  let startPosition = await readWalPosition();
  return {
    async afterStatement() {
      const busyMs = Math.max(0, clock.now() - startedAt);
      const position = startPosition === null ? null : await readWalPosition();
      const walBytes =
        position === null || startPosition === null || position < startPosition
          ? 0
          : Number(position - startPosition);
      const walPauseMs = (walBytes / pacing.walBytesPerSecond) * 1000 - busyMs;
      const dutyPauseMs = busyMs * (1 / pacing.dutyCycle - 1);
      const pauseMs = Math.min(MAX_PAUSE_MS, Math.max(0, walPauseMs, dutyPauseMs));
      if (pauseMs > 0) await clock.sleep(pauseMs);
      startedAt = clock.now();
      startPosition = position === null ? null : await readWalPosition();
    },
  };
}
