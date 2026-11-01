import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { appMeta } from "./db/schema.js";

// See docs/design/goals.md, "The user's time": one setting, an IANA name, read by the scheduler, the UI and the date the agent is told.
const key = "time_zone";

export class TimeZoneError extends Error {}

export function isTimeZone(name: unknown): name is string {
  if (typeof name !== "string" || !name.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export function getTimeZone(db: Db): string | null {
  return db.select().from(appMeta).where(eq(appMeta.key, key)).get()?.value ?? null;
}

/** With `onlyIfUnset`, the first writer wins: the browser's guess on first open never replaces a choice already made. */
export function setTimeZone(db: Db, name: unknown, opts: { onlyIfUnset?: boolean } = {}): string {
  if (!isTimeZone(name)) throw new TimeZoneError("That is not a time zone I know. Use a name like America/New_York.");
  if (opts.onlyIfUnset) {
    const current = getTimeZone(db);
    if (current) return current;
  }
  db.insert(appMeta)
    .values({ key, value: name })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: name } })
    .run();
  return name;
}

/** The sentence the model is given, so "tomorrow" and "this evening" mean what the user means. */
export function describeToday(timeZone: string, now = new Date()): string {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  return `Today is ${date} (time zone ${timeZone}).`;
}
