import { performance } from 'node:perf_hooks';

// One monotonic clock for action deadlines, dispatch and local scheduling durations.
export const systemMatchClock = Object.freeze({
  now: () => performance.now(),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (timer) => clearInterval(timer),
});
export const MATCH_TICK_MS = 20;
