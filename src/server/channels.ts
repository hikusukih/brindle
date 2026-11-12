import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { channels } from "./db/schema.js";

export type Channel = typeof channels.$inferSelect;

export class ChannelError extends Error {
  constructor(
    readonly code: "not_found" | "archived" | "invalid_name" | "invalid_model" | "goal_channel" | "run_unfinished",
    message: string,
  ) {
    super(message);
  }
}

function cleanName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed || trimmed.length > 120) {
    throw new ChannelError("invalid_name", "A channel name is 1 to 120 characters.");
  }
  return trimmed;
}

export function listChannels(db: Db, opts: { archived?: boolean } = {}): Channel[] {
  const all = db.select().from(channels).orderBy(desc(channels.updatedAt)).all();
  return all.filter((c) => (c.archivedAt !== null) === (opts.archived ?? false));
}

export function getChannel(db: Db, id: string): Channel {
  const row = db.select().from(channels).where(eq(channels.id, id)).get();
  if (!row) throw new ChannelError("not_found", "No such channel.");
  return row;
}

export function createChannel(db: Db, name: unknown, now = new Date()): Channel {
  const stamp = now.toISOString();
  const row = {
    id: randomUUID(),
    name: cleanName(name),
    createdAt: stamp,
    updatedAt: stamp,
    archivedAt: null,
    model: null,
    branch: null,
    driftDismissedVersion: null,
  };
  db.insert(channels).values(row).run();
  return row;
}

/**
 * Sets the channel's model spec, or clears it with null to follow the default. `validate` is the model
 * registry's check, so a typo or a missing key is refused here rather than on the first message.
 */
export function setChannelModel(
  db: Db,
  id: string,
  model: unknown,
  validate: (spec: string) => void,
  now = new Date(),
): Channel {
  const channel = getChannel(db, id);
  if (channel.archivedAt) throw new ChannelError("archived", "Restore the channel before changing it.");
  let spec: string | null = null;
  if (model !== null && model !== undefined) {
    spec = typeof model === "string" ? model.trim() : "";
    if (!spec) throw new ChannelError("invalid_model", "A model is written provider:name, such as openai:gpt-4o.");
    try {
      validate(spec);
    } catch (err) {
      throw new ChannelError("invalid_model", (err as Error).message);
    }
  }
  const updated = { model: spec, updatedAt: now.toISOString() };
  db.update(channels).set(updated).where(eq(channels.id, id)).run();
  return { ...channel, ...updated };
}

export function renameChannel(db: Db, id: string, name: unknown, now = new Date()): Channel {
  const channel = getChannel(db, id);
  // An archived channel is read-only until it is restored.
  if (channel.archivedAt) throw new ChannelError("archived", "Restore the channel before changing it.");
  const updated = { name: cleanName(name), updatedAt: now.toISOString() };
  db.update(channels).set(updated).where(eq(channels.id, id)).run();
  return { ...channel, ...updated };
}

function setArchived(db: Db, id: string, archivedAt: string | null, now: Date): Channel {
  const channel = getChannel(db, id);
  const updated = { archivedAt, updatedAt: now.toISOString() };
  db.update(channels).set(updated).where(eq(channels.id, id)).run();
  return { ...channel, ...updated };
}

export function archiveChannel(db: Db, id: string, now = new Date()): Channel {
  return setArchived(db, id, now.toISOString(), now);
}

export function restoreChannel(db: Db, id: string, now = new Date()): Channel {
  return setArchived(db, id, null, now);
}

// Runs and events go with the channel through the foreign keys' cascade.
export function deleteChannel(db: Db, id: string): void {
  getChannel(db, id);
  db.delete(channels).where(eq(channels.id, id)).run();
}
