import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { artifacts, channels } from "./db/schema.js";

export type Artifact = typeof artifacts.$inferSelect;

export const artifactKinds = ["document", "code", "data", "page", "link"] as const;
export type ArtifactKind = (typeof artifactKinds)[number];

const maxBytes = 1_000_000;

const mimes: Record<ArtifactKind, { mime: string; ext: string }> = {
  document: { mime: "text/markdown", ext: "md" },
  code: { mime: "text/plain", ext: "txt" },
  data: { mime: "application/json", ext: "json" },
  page: { mime: "text/html", ext: "html" },
  link: { mime: "text/uri-list", ext: "url" },
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
    if (!artifactKinds.includes(input.kind as ArtifactKind)) {
      throw new ArtifactError("invalid", `kind must be one of ${artifactKinds.join(", ")}.`);
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

  list(): Artifact[] {
    return this.db.select().from(artifacts).orderBy(desc(artifacts.createdAt)).all();
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
      if (needle && !a.title.toLowerCase().includes(needle) && !this.content(a)?.toLowerCase().includes(needle))
        continue;
      found.push(a);
      if (found.length >= (filter.limit ?? 20)) break;
    }
    return found;
  }

  get(id: string): Artifact | undefined {
    return this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
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
