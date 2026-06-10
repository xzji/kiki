type Release = () => void;

const queues = new Map<string, Promise<void>>();

export async function withMemoryMutex<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release: Release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current);
  queues.set(key, next);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (queues.get(key) === next) {
      queues.delete(key);
    }
  }
}
