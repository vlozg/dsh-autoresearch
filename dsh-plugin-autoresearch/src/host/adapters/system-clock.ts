/** System clock adapter. */

import type { Clock } from "../app/ports";

export const systemClock: Clock = {
  now: () => Date.now(),
};