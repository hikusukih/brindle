import { authHeaders, setToken, unauthorizedEvent } from "./token";

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
    headers: { ...authHeaders(), ...(init?.body === undefined ? {} : { "content-type": "application/json" }) },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401) {
    // The stored token no longer works; the login gate takes over.
    setToken(null);
    window.dispatchEvent(new Event(unauthorizedEvent));
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Server answered ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** The bytes of an artifact's file. The token travels in the header, which is why a plain link cannot open it. */
export async function fetchArtifactFile(id: string): Promise<Blob> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}/file`, { headers: authHeaders() });
  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new Event(unauthorizedEvent));
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Server answered ${res.status}`);
  }
  return res.blob();
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
