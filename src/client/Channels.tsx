import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { type Artifact, api, type Channel, type Run, type RunEvent } from "./api";
import { channelIdFromHash } from "./screens";

const button = "min-h-11 rounded-lg px-3 text-sm font-medium";
const primary = `${button} bg-slate-900 text-white disabled:opacity-50`;
const quiet = `${button} border border-slate-300 text-slate-700 hover:bg-slate-100`;

function Problem({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
      {message}
    </p>
  ) : null;
}

function useChannelId() {
  const [id, setId] = useState(() => channelIdFromHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setId(channelIdFromHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return id;
}

export function ChannelsScreen() {
  const id = useChannelId();
  return id ? <ChannelView id={id} /> : <ChannelList />;
}

function ChannelList() {
  const [showArchived, setShowArchived] = useState(false);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{
    channel: Channel;
    artifacts: Artifact[];
    choice: "keep" | "all" | "some";
    picked: string[];
  } | null>(null);

  const load = useCallback(() => {
    api<Channel[]>(`/api/channels?archived=${showArchived}`)
      .then((list) => {
        setChannels(list);
        setProblem(null);
      })
      .catch((e: unknown) => setProblem(String((e as Error).message)));
  }, [showArchived]);
  useEffect(load, [load]);

  const act = async (path: string, method: string, body?: unknown) => {
    try {
      await api(path, { method, body });
      setRenaming(null);
      load();
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  // A channel that made no artifacts gets the plain confirm; otherwise the user picks what happens to them, keeping all by default.
  const askDelete = async (c: Channel) => {
    try {
      const made = await api<Artifact[]>(`/api/channels/${c.id}/artifacts`);
      if (made.length) setDeleting({ channel: c, artifacts: made, choice: "keep", picked: [] });
      else if (window.confirm(`Delete "${c.name}" and its history? This can't be undone.`))
        await act(`/api/channels/${c.id}`, "DELETE");
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const { channel, artifacts, choice, picked } = deleting;
    const ids = choice === "all" ? artifacts.map((a) => a.id) : choice === "some" ? picked : [];
    setDeleting(null);
    await act(`/api/channels/${channel.id}`, "DELETE", ids.length ? { deleteArtifacts: ids } : undefined);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const made = await api<Channel>("/api/channels", { method: "POST", body: { name } });
      setName("");
      window.location.hash = `#/channels/${made.id}`;
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Channels</h1>
      <form onSubmit={create} className="flex gap-2">
        <input
          aria-label="New channel name"
          placeholder="New channel name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-300 px-3"
        />
        <button type="submit" className={primary}>
          Create
        </button>
      </form>
      <Problem message={problem} />
      {deleting && (
        <section aria-label="Delete channel" className="flex flex-col gap-2 rounded-lg border border-red-200 p-3">
          <h2 className="font-medium">
            Delete "{deleting.channel.name}" and its history? It made {deleting.artifacts.length}{" "}
            {deleting.artifacts.length === 1 ? "artifact" : "artifacts"}.
          </h2>
          {(
            [
              ["keep", "Keep all artifacts"],
              ["all", "Delete all artifacts"],
              ["some", "Choose which to delete"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name="artifact-choice"
                checked={deleting.choice === value}
                onChange={() => setDeleting({ ...deleting, choice: value })}
              />
              {label}
            </label>
          ))}
          {deleting.choice === "some" && (
            <ul className="flex flex-col">
              {deleting.artifacts.map((a) => (
                <li key={a.id}>
                  <label className="flex min-h-11 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={deleting.picked.includes(a.id)}
                      onChange={(e) =>
                        setDeleting({
                          ...deleting,
                          picked: e.target.checked
                            ? [...deleting.picked, a.id]
                            : deleting.picked.filter((x) => x !== a.id),
                        })
                      }
                    />
                    {a.title}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <button type="button" className={`${quiet} text-red-700`} onClick={() => void confirmDelete()}>
              Delete channel
            </button>
            <button type="button" className={quiet} onClick={() => setDeleting(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}
      <div className="flex gap-2">
        <button type="button" className={quiet} aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>
          Active
        </button>
        <button type="button" className={quiet} aria-pressed={showArchived} onClick={() => setShowArchived(true)}>
          Archived
        </button>
      </div>
      {channels?.length === 0 && (
        <div>
          <h2 className="font-medium">{showArchived ? "No archived channels" : "No channels yet"}</h2>
          {!showArchived && (
            <p className="text-slate-600">
              A channel is a named conversation with its own history. Start one to talk to your agent.
            </p>
          )}
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {channels?.map((c) => (
          <li key={c.id} className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3">
            {renaming?.id === c.id ? (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(`/api/channels/${c.id}`, "PATCH", { name: renaming.name });
                }}
              >
                <input
                  aria-label="Channel name"
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: c.id, name: e.target.value })}
                  className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-300 px-3"
                />
                <button type="submit" className={primary}>
                  Save
                </button>
                <button type="button" className={quiet} onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <a href={`#/channels/${c.id}`} className="min-h-6 font-medium">
                {c.name}
              </a>
            )}
            <div className="flex flex-wrap gap-2">
              {c.archivedAt ? (
                <button type="button" className={quiet} onClick={() => act(`/api/channels/${c.id}/restore`, "POST")}>
                  Restore
                </button>
              ) : (
                <>
                  <button type="button" className={quiet} onClick={() => setRenaming({ id: c.id, name: c.name })}>
                    Rename
                  </button>
                  <button type="button" className={quiet} onClick={() => act(`/api/channels/${c.id}/archive`, "POST")}>
                    Archive
                  </button>
                </>
              )}
              <button type="button" className={`${quiet} text-red-700`} onClick={() => void askDelete(c)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const eventTypes = [
  "message",
  "text",
  "tool_call",
  "tool_result",
  "approval_request",
  "approval_decision",
  "artifact",
  "error",
];

function parse(e: RunEvent): Record<string, unknown> {
  try {
    return JSON.parse(e.data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function EventLine({ event }: { event: RunEvent }) {
  const d = parse(event);
  switch (event.type) {
    case "message":
      return <p className="ml-auto max-w-[85%] rounded-lg bg-slate-900 p-3 text-white">{String(d.text)}</p>;
    case "text":
      return <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-slate-100 p-3">{String(d.text)}</p>;
    case "tool_call":
      return <p className="text-xs text-slate-500">Called {String(d.name)}</p>;
    case "tool_result":
      return <p className="text-xs text-slate-500">{String(d.name)} answered</p>;
    case "error":
      return (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
          {String(d.message)}
        </p>
      );
    default:
      return null;
  }
}

type SentContext = {
  step: number;
  report: {
    window: number;
    budget: number;
    layers: { name: string; tokens: number }[];
    runsDropped: number;
    breaks: string[];
    overflow: { layer: string; detail: string }[];
  };
  messages: SentMessage[] | null;
  tools: { name: string; description: string; parameters: unknown }[] | null;
};

type SentMessage = {
  role: string;
  content: string;
  toolCalls?: { id: string; name: string; arguments: unknown }[];
  toolCallId?: string;
};

/** One message as the model received it, tool calls and the call a result answers included. */
function formatSent(m: SentMessage): string {
  const head = m.role === "tool" ? `tool (answers ${m.toolCallId}):` : `${m.role}:`;
  const calls = (m.toolCalls ?? []).map((c) => `\n-> call ${c.id} ${c.name} ${JSON.stringify(c.arguments)}`).join("");
  return `${head} ${m.content}${calls}`;
}

/** What the model was sent for one run: layer sizes, and the exact messages while the server still keeps them. */
function SentView({ runId }: { runId: string }) {
  const [sent, setSent] = useState<SentContext[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = () =>
    api<SentContext[]>(`/api/runs/${runId}/context`).then(setSent, (e: Error) => setProblem(e.message));
  return (
    <details className="text-xs text-slate-600" onToggle={(e) => e.currentTarget.open && !sent && load()}>
      <summary className="cursor-pointer">What was sent</summary>
      <Problem message={problem} />
      {sent?.length === 0 && <p>No request was recorded for this run.</p>}
      {sent?.map((req) => (
        <div key={req.step} className="mt-2 flex flex-col gap-1">
          <p>
            Step {req.step}: {req.report.layers.map((l) => `${l.name} ${l.tokens}`).join(", ")} of {req.report.budget}{" "}
            tokens
            {req.report.runsDropped ? `; ${req.report.runsDropped} older run(s) left out` : ""}
            {req.report.breaks.length ? `; prompt start changed: ${req.report.breaks.join(", ")}` : ""}
          </p>
          {req.messages ? (
            <>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-slate-100 p-2">
                {req.messages.map(formatSent).join("\n\n")}
              </pre>
              {req.tools && (
                <details>
                  <summary className="cursor-pointer">
                    Tools offered ({req.tools.map((t) => t.name).join(", ")})
                  </summary>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-slate-100 p-2">
                    {JSON.stringify(req.tools, null, 2)}
                  </pre>
                </details>
              )}
            </>
          ) : req.report.overflow.some((o) => o.layer === "current_run") ? (
            <p>Nothing was sent: {req.report.overflow.map((o) => o.detail).join("; ")}.</p>
          ) : (
            <p>The exact messages are only kept for a channel's 20 newest runs.</p>
          )}
        </div>
      ))}
    </details>
  );
}

function ApprovalCard(props: {
  tool: string;
  reason: string;
  args: unknown;
  decision: string | null;
  ended: boolean;
  onDecide: (decision: "approve" | "decline") => void;
}) {
  const { tool, reason, args, decision, ended, onDecide } = props;
  return (
    <section
      aria-label={`Approval for ${tool}`}
      className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm"
    >
      <p className="font-medium">{reason}</p>
      <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-slate-700">{JSON.stringify(args, null, 2)}</pre>
      {decision ? (
        <p className="text-xs text-slate-600">{decision === "approve" ? "Approved." : "Declined."}</p>
      ) : ended ? (
        <p className="text-xs text-slate-600">Not answered before the run ended.</p>
      ) : (
        <div className="flex gap-2">
          <button type="button" className={primary} onClick={() => onDecide("approve")}>
            Approve
          </button>
          <button type="button" className={quiet} onClick={() => onDecide("decline")}>
            Decline
          </button>
        </div>
      )}
    </section>
  );
}

function ChannelView({ id }: { id: string }) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [modelText, setModelText] = useState("");
  const source = useRef<EventSource | null>(null);

  const reload = useCallback(async () => {
    setRuns(await api<Run[]>(`/api/channels/${id}/runs`));
  }, [id]);

  useEffect(() => {
    setChannel(null);
    api<{ default: string | null }>("/api/models")
      .then((m) => setDefaultModel(m.default))
      .catch(() => {});
    api<Channel[]>("/api/channels")
      .then(async (active) => {
        const found =
          active.find((c) => c.id === id) ??
          (await api<Channel[]>("/api/channels?archived=true")).find((c) => c.id === id);
        if (!found) throw new Error("No such channel.");
        setChannel(found);
        await reload();
      })
      .catch((e: unknown) => setProblem((e as Error).message));
    return () => source.current?.close();
  }, [id, reload]);

  // Events replay from the start on connect and again after a reconnect, so merge by seq instead of appending.
  const follow = useCallback(
    (runId: string) => {
      source.current?.close();
      const es = new EventSource(`/api/runs/${runId}/events`);
      source.current = es;
      const take = (e: Event) => {
        // "error" is also the name of EventSource's own connection failure, which carries no data.
        if (!(e instanceof MessageEvent) || typeof e.data !== "string") return;
        const seq = Number(e.lastEventId);
        setRuns((all) =>
          all.map((r) =>
            r.id !== runId || r.events.some((x) => x.seq === seq)
              ? r
              : {
                  ...r,
                  events: [
                    ...r.events,
                    { id: `${runId}:${seq}`, runId, seq, type: e.type, data: e.data, createdAt: "" },
                  ].sort((a, b) => a.seq - b.seq),
                },
          ),
        );
      };
      for (const t of eventTypes) es.addEventListener(t, take);
      es.addEventListener("end", () => {
        es.close();
        reload().catch((err: unknown) => setProblem((err as Error).message));
      });
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          setProblem("Lost the connection to the server.");
          reload().catch(() => {});
        }
      };
    },
    [reload],
  );

  const send = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const run = await api<Run>(`/api/channels/${id}/runs`, { method: "POST", body: { text } });
      setText("");
      setProblem(null);
      setRuns((all) => [...all, { ...run, events: [] }]);
      follow(run.id);
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  const decide = async (runId: string, callId: string, decision: "approve" | "decline") => {
    try {
      await api(`/api/runs/${runId}/approvals/${callId}`, { method: "POST", body: { decision } });
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  const chooseModel = async (model: string | null) => {
    try {
      setChannel(await api<Channel>(`/api/channels/${id}/model`, { method: "POST", body: { model } }));
      setModelText("");
      setProblem(null);
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  // A run waiting for an approval is still working as far as the channel is concerned.
  const running = runs.find((r) => r.status === "running" || r.status === "waiting");
  const readOnly = channel?.archivedAt != null;

  return (
    <div className="flex flex-col gap-4">
      <a href="#/channels" className="min-h-6 text-sm text-slate-600">
        ← All channels
      </a>
      <h1 className="text-2xl font-semibold">{channel?.name ?? "Channel"}</h1>
      {channel && (
        <div className="flex flex-col gap-2 text-sm text-slate-600">
          <p>Model: {channel.model ?? (defaultModel ? `${defaultModel} (default)` : "none configured")}</p>
          {!readOnly && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                chooseModel(modelText.trim() || null);
              }}
            >
              <input
                aria-label="Model for this channel"
                placeholder="provider:name, such as openai:gpt-4o"
                value={modelText}
                onChange={(e) => setModelText(e.target.value)}
                className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-300 px-3"
              />
              <button type="submit" className={quiet}>
                {modelText.trim() ? "Set model" : "Use default"}
              </button>
            </form>
          )}
        </div>
      )}
      <div className="flex flex-col gap-4">
        {runs.map((run) => (
          <section key={run.id} aria-label="Run" className="flex flex-col gap-2">
            {run.events.map((ev) => {
              if (ev.type === "approval_request") {
                const d = parse(ev);
                const answer = run.events.find((x) => x.type === "approval_decision" && parse(x).callId === d.callId);
                return (
                  <ApprovalCard
                    key={ev.seq}
                    tool={String(d.tool)}
                    reason={String(d.reason)}
                    args={d.arguments}
                    decision={answer ? String(parse(answer).decision) : null}
                    ended={run.status !== "running" && run.status !== "waiting"}
                    onDecide={(decision) => decide(run.id, String(d.callId), decision)}
                  />
                );
              }
              return <EventLine key={ev.seq} event={ev} />;
            })}
            {run.status !== "running" &&
              run.status !== "done" &&
              run.stopReason &&
              !run.events.some((x) => x.type === "error") && (
                <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
                  This run ended: {run.stopReason}.
                </p>
              )}
            {run.status === "cancelled" && <p className="text-xs text-slate-500">Cancelled.</p>}
            {run.status !== "running" && run.status !== "waiting" && <SentView runId={run.id} />}
          </section>
        ))}
      </div>
      <Problem message={problem} />
      {readOnly ? (
        <p className="text-sm text-slate-600">This channel is archived. Restore it to send a message.</p>
      ) : (
        <form onSubmit={send} className="flex gap-2">
          <input
            aria-label="Message"
            placeholder="Message"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-300 px-3"
          />
          {running ? (
            <button
              type="button"
              className={quiet}
              onClick={() =>
                api(`/api/runs/${running.id}/cancel`, { method: "POST" }).catch((err: unknown) =>
                  setProblem((err as Error).message),
                )
              }
            >
              Cancel
            </button>
          ) : (
            <button type="submit" className={primary} disabled={!channel}>
              Send
            </button>
          )}
        </form>
      )}
    </div>
  );
}
