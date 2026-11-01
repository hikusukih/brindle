export type Channel = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** A spec such as "openai:gpt-4o"; null follows the server default. */
  model: string | null;
};

export type RunEvent = { id: string; runId: string; seq: number; type: string; data: string; createdAt: string };

export type Run = {
  id: string;
  channelId: string;
  status: "running" | "waiting" | "done" | "failed" | "cancelled" | "stopped";
  stopReason: string | null;
  startedAt: string;
  endedAt: string | null;
  events: RunEvent[];
};

// The server answers failures with { error, message }; that message is written for the user, so show it as is.
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Server answered ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export type Artifact = {
  id: string;
  title: string;
  kind: "document" | "code" | "data" | "page" | "link";
  scope: "channel" | "goal";
  scopeId: string;
  /** The scope's name when the artifact was made. */
  scopeName: string;
  runId: string | null;
  mime: string;
  size: number;
  createdAt: string;
  /** True while the channel that made it still exists. */
  scopeLive: boolean;
};
