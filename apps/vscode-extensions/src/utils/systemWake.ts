/**
 * Whether this process resumed from system sleep in the last few minutes.
 *
 * A sleeping Mac still wakes for a few seconds at a time ("dark wakes"; pmset
 * logs "SleepService: window begins with cap time=180 secs"), and our interval
 * timers fire inside them. An Atlassian token refresh sent there is received
 * and the refresh token rotated, then the machine sleeps before the reply
 * arrives: the new token is lost and the stored one is dead, so the user has to
 * reconnect. Background work that refreshes a rotating token therefore waits
 * until the machine has been awake longer than any dark wake.
 *
 * Detection: a SAMPLE_MS timer records the wall clock. Timers cannot run while
 * the system sleeps, so a gap of more than FROZEN_MS between samples means the
 * process was frozen, i.e. asleep. (Node's monotonic clock can't tell us: on
 * macOS process.hrtime keeps counting through sleep, same as Date.now.) A
 * minute-long event-loop stall would read the same and only delays background
 * sync by DARK_WAKE_MAX_MS.
 */

/** Longest a dark wake lasts (the SleepService cap above). */
export const DARK_WAKE_MAX_MS = 3 * 60 * 1000;
/** How often the wall clock is sampled, so a wake is dated to within this. */
export const SAMPLE_MS = 10_000;
/** A gap between samples longer than this means the process was frozen. */
const FROZEN_MS = 60_000;

export function createWakeTracker(now: () => number = () => Date.now()) {
  let last = now();
  let wokeAt: number | undefined;

  const sample = (): void => {
    const t = now();
    if (t - last > FROZEN_MS) {
      wokeAt = t;
    }
    last = t;
  };

  return {
    sample,
    /** Time since the last resume from sleep; undefined if none was seen. */
    msSinceWake(): number | undefined {
      sample(); // a timer that fires on wake can run before the periodic sample
      return wokeAt === undefined ? undefined : now() - wokeAt;
    },
  };
}

let tracker: ReturnType<typeof createWakeTracker> | undefined;

/** True for DARK_WAKE_MAX_MS after the system resumes from sleep.
 * Wakes are dated from the first call on, so call it when a scheduler starts. */
export function justWokeFromSleep(): boolean {
  if (!tracker) {
    const t = createWakeTracker();
    setInterval(t.sample, SAMPLE_MS).unref();
    tracker = t;
  }
  const since = tracker.msSinceWake();
  return since !== undefined && since < DARK_WAKE_MAX_MS;
}
