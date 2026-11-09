import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { artifacts, channels } from "./db/schema.js";

export type Artifact = typeof artifacts.$inferSelect;

export const artifactKinds = ["document", "code", "data", "page", "link", "audio"] as const;
export type ArtifactKind = (typeof artifactKinds)[number];
/** What `create_artifact` may make: a model writes text, and audio comes only from the `speak` tool. */
export const writableKinds = artifactKinds.filter((k): k is Exclude<ArtifactKind, "audio"> => k !== "audio");
/** The audio types `speak` accepts from a speech server; the stored type is one of these, never the server's header as sent. */
export const audioTypes: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};
const maxAudioBytes = 25_000_000;

const maxBytes = 1_000_000;

const mimes: Record<ArtifactKind, { mime: string; ext: string }> = {
  document: { mime: "text/markdown", ext: "md" },
  code: { mime: "text/plain", ext: "txt" },
  data: { mime: "application/json", ext: "json" },
  page: { mime: "text/html", ext: "html" },
  link: { mime: "text/uri-list", ext: "url" },
  audio: { mime: "audio/mpeg", ext: "mp3" },
};

export class ArtifactError extends Error {
  constructor(
    readonly code: "invalid" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

/** Only a plain file name survives, so a model-chosen name can never point outside the artifact's own folder. */
function safeName(name: string | undefined, fallback: string): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^\w.-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
  return cleaned || fallback;
}

/** Files live under dir/<id>/, metadata in SQLite. */
export class ArtifactStore {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
  ) {}

  create(
    input: { title?: unknown; kind?: unknown; content?: unknown; filename?: unknown },
    origin: { scope: "channel" | "goal"; scopeId: string; runId?: string },
    now = new Date(),
  ): Artifact {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title || title.length > 200) throw new ArtifactError("invalid", "A title is 1 to 200 characters.");
    if (!(writableKinds as readonly string[]).includes(input.kind as string)) {
      throw new ArtifactError("invalid", `kind must be one of ${writableKinds.join(", ")}.`);
    }
    const kind = input.kind as ArtifactKind;
    if (typeof input.content !== "string") throw new ArtifactError("invalid", "content must be text.");
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.length > maxBytes) throw new ArtifactError("invalid", `content is over ${maxBytes} bytes.`);
    const { mime, ext } = mimes[kind];
    const id = randomUUID();
    const name = safeName(typeof input.filename === "string" ? input.filename : undefined, `artifact.${ext}`);
    const scopeName =
      origin.scope === "channel"
        ? (this.db.select({ name: channels.name }).from(channels).where(eq(channels.id, origin.scopeId)).get()?.name ??
          "")
        : "";
    const row: Artifact = {
      id,
      title,
      kind,
      scope: origin.scope,
      scopeId: origin.scopeId,
      scopeName,
      runId: origin.runId ?? null,
      file: `${id}/${name}`,
      mime,
      size: bytes.length,
      createdAt: now.toISOString(),
    };
    const path = join(this.dir, row.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    this.db.insert(artifacts).values(row).run();
    return row;
  }

  /** Saves speech from the `speak` tool. The type must be one of `audioTypes`; the file name is made here, not by the caller. */
  createAudio(
    input: { title: string; bytes: Uint8Array; contentType: string },
    origin: { scope: "channel" | "goal"; scopeId: string; runId?: string },
    now = new Date(),
  ): Artifact {
    const title = input.title.trim();
    if (!title || title.length > 200) throw new ArtifactError("invalid", "A title is 1 to 200 characters.");
    const mime = input.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    const ext = audioTypes[mime];
    if (!ext) throw new ArtifactError("invalid", `${mime || "That"} is not an audio type this server stores.`);
    if (!input.bytes.length) throw new ArtifactError("invalid", "The speech server returned no audio.");
    if (input.bytes.length > maxAudioBytes) throw new ArtifactError("invalid", `audio is over ${maxAudioBytes} bytes.`);
    const id = randomUUID();
    const scopeName =
      origin.scope === "channel"
        ? (this.db.select({ name: channels.name }).from(channels).where(eq(channels.id, origin.scopeId)).get()?.name ??
          "")
        : "";
    const row: Artifact = {
      id,
      title,
      kind: "audio",
      scope: origin.scope,
      scopeId: origin.scopeId,
      scopeName,
      runId: origin.runId ?? null,
      file: `${id}/speech.${ext}`,
      mime: mime === "audio/x-wav" ? "audio/wav" : mime,
      size: input.bytes.length,
      createdAt: now.toISOString(),
    };
    const path = join(this.dir, row.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, input.bytes);
    this.db.insert(artifacts).values(row).run();
    return row;
  }

  /** Newest first, with the channel a channel-scoped artifact came from marked live or gone, so the gallery can link or say so. */
  list(filter: { kind?: string; scope?: string } = {}): (Artifact & { scopeLive: boolean })[] {
    const where = and(
      filter.kind ? eq(artifacts.kind, filter.kind) : undefined,
      filter.scope ? eq(artifacts.scope, filter.scope) : undefined,
    );
    const live = new Set(
      this.db
        .select({ id: channels.id })
        .from(channels)
        .all()
        .map((c) => c.id),
    );
    return this.db
      .select()
      .from(artifacts)
      .where(where)
      .orderBy(desc(artifacts.createdAt))
      .all()
      .map((a) => ({ ...a, scopeLive: a.scope === "channel" && live.has(a.scopeId) }));
  }

  /** Newest first. The text matches a title or the content, ignoring case; a file that cannot be read just doesn't match on content. */
  find(filter: { query?: string; kind?: string; limit?: number } = {}): Artifact[] {
    const needle = filter.query?.trim().toLowerCase();
    const found: Artifact[] = [];
    const rows = this.db
      .select()
      .from(artifacts)
      .where(filter.kind ? eq(artifacts.kind, filter.kind) : undefined)
      .orderBy(desc(artifacts.createdAt))
      .all();
    for (const a of rows) {
      // Audio has no text to match, so only its title can.
      const body = a.kind === "audio" ? undefined : this.content(a);
      if (needle && !a.title.toLowerCase().includes(needle) && !body?.toLowerCase().includes(needle)) continue;
      found.push(a);
      if (found.length >= (filter.limit ?? 20)) break;
    }
    return found;
  }

  get(id: string): Artifact | undefined {
    return this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
  }

  bytes(a: Artifact): Buffer | undefined {
    try {
      return readFileSync(join(this.dir, a.file));
    } catch {
      return undefined;
    }
  }

  content(a: Artifact): string | undefined {
    try {
      return readFileSync(join(this.dir, a.file), "utf8");
    } catch {
      return undefined;
    }
  }

  /** The artifacts a channel made, which the delete-channel prompt offers for removal. Goal-owned ones are never listed. */
  forChannel(channelId: string): Artifact[] {
    return this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.scope, "channel"), eq(artifacts.scopeId, channelId)))
      .orderBy(desc(artifacts.createdAt))
      .all();
  }

  /** Deletes rows and files together, and only the listed artifacts that belong to this channel. Returns how many went. */
  deleteForChannel(channelId: string, ids: string[]): number {
    if (!ids.length) return 0;
    const mine = this.forChannel(channelId).filter((a) => ids.includes(a.id));
    if (!mine.length) return 0;
    this.db
      .delete(artifacts)
      .where(
        inArray(
          artifacts.id,
          mine.map((a) => a.id),
        ),
      )
      .run();
    for (const a of mine) rmSync(join(this.dir, a.id), { recursive: true, force: true });
    return mine.length;
  }
}
