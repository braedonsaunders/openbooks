export class KdfCapacityError extends Error {
  constructor() {
    super("password KDF capacity is temporarily exhausted");
    this.name = "KdfCapacityError";
  }
}

/** Bounded FIFO admission queue around memory-hard password work. */
export function createKdfExecutor(options: { maxActive: number; maxQueued: number }) {
  if (!Number.isInteger(options.maxActive) || options.maxActive < 1) {
    throw new Error("maxActive must be a positive integer");
  }
  if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
    throw new Error("maxQueued must be a nonnegative integer");
  }

  let active = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < options.maxActive) {
      active += 1;
      return Promise.resolve();
    }
    if (queue.length >= options.maxQueued) return Promise.reject(new KdfCapacityError());
    return new Promise((resolve) => queue.push(resolve));
  }

  function release(): void {
    const next = queue.shift();
    if (next) next();
    else active -= 1;
  }

  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
    snapshot() {
      return { active, queued: queue.length };
    },
  };
}
