/**
 * At most one read per interval, shared by everyone who asks, and never a
 * stale answer left standing.
 *
 * Built for the remote-mode balance (`/v1/me`), which is asked for when the
 * chat view loads, when Settings or the usage bar opens, and after every run,
 * often several at once. Every ask is answered right away: with a fresh read
 * when the last one is older than the interval, otherwise with the last
 * result immediately AND one trailing read when the interval runs out. The
 * trailing read is what stops the balance freezing: a run that ends two
 * seconds after Settings opened still shows its charge eight seconds later,
 * instead of whenever someone next happens to ask.
 */
export interface ThrottledCheck<T> {
  /**
   * Deliver a result to `deliver`: once now (fresh, or the cached one), and
   * once more after the trailing read if the cached one was used. `key`
   * collapses repeated asks from the same requester into one trailing delivery.
   */
  request(key: unknown, read: () => Promise<T>, deliver: (value: T, fresh: boolean) => void): void;
  /** Drop the cached result and any read in flight — it describes a session that is gone. */
  invalidate(): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
}

const realClock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms) };

/** A requester that has gone away (a disposed webview) must not break delivery to the others. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // ignore
  }
}

export function createThrottledCheck<T>(minIntervalMs: number, clock: Clock = realClock): ThrottledCheck<T> {
  let last: { at: number; value: T } | null = null;
  let inFlight: Promise<T> | null = null;
  let generation = 0;
  let trailingScheduled = false;
  let trailingRead: (() => Promise<T>) | null = null;
  const trailingListeners = new Map<unknown, (value: T, fresh: boolean) => void>();

  const run = (read: () => Promise<T>): Promise<T> => {
    if (inFlight) return inFlight;
    const gen = generation;
    const startedAt = clock.now();
    const p = read().then((value) => {
      // A read started before invalidate() answers for the old session: hand
      // it to whoever was waiting on it, but never cache it.
      if (gen === generation) last = { at: startedAt, value };
      return value;
    });
    inFlight = p;
    const clear = () => {
      if (inFlight === p) inFlight = null;
    };
    p.then(clear, clear);
    return p;
  };

  return {
    request(key, read, deliver) {
      if (!last || clock.now() - last.at >= minIntervalMs) {
        run(read).then((v) => safely(() => deliver(v, true)), () => {});
        return;
      }
      const cached = last.value;
      safely(() => deliver(cached, false));
      trailingListeners.set(key, deliver);
      trailingRead = read;
      if (trailingScheduled) return;
      trailingScheduled = true;
      clock.setTimeout(() => {
        trailingScheduled = false;
        const listeners = [...trailingListeners.values()];
        trailingListeners.clear();
        const next = trailingRead;
        trailingRead = null;
        if (!next || !listeners.length) return;
        run(next).then((v) => listeners.forEach((l) => safely(() => l(v, true))), () => {});
      }, Math.max(0, (last?.at ?? 0) + minIntervalMs - clock.now()));
    },
    invalidate() {
      generation++;
      last = null;
      inFlight = null;
    },
  };
}
