import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, type GoalState } from "./api";

const button = "min-h-11 rounded-lg px-3 text-sm font-medium";

/** `#/goals/<id>/state` opens one goal's state document. */
export function goalStateIdFromHash(hash: string): string | null {
  const [screen, id, page] = hash.replace(/^#\/?/, "").split("/");
  return screen === "goals" && id && page === "state" ? decodeURIComponent(id) : null;
}

export function GoalStateView({ goalId }: { goalId: string }) {
  const [current, setCurrent] = useState<GoalState | null>(null);
  const [history, setHistory] = useState<Required<GoalState>[]>([]);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [now, versions] = await Promise.all([
      api<GoalState>(`/api/goals/${goalId}/state`),
      api<Required<GoalState>[]>(`/api/goals/${goalId}/state/versions`),
    ]);
    setCurrent(now);
    setDraft(now.text);
    setHistory([...versions].reverse());
  }, [goalId]);

  useEffect(() => {
    load().catch((e: unknown) => setProblem((e as Error).message));
  }, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/goals/${goalId}/state`, {
        method: "PUT",
        body: { text: draft, baseVersion: current?.version ?? 0 },
      });
      setProblem(null);
      setNotice("Saved.");
      await load();
    } catch (err) {
      setNotice(null);
      setProblem((err as Error).message);
    }
  };

  const restore = async (version: number) => {
    try {
      await api(`/api/goals/${goalId}/state/versions/${version}/restore`, { method: "POST" });
      setProblem(null);
      setNotice(`Restored version ${version} as a new version.`);
      await load();
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  if (!current && !problem) return <p className="text-slate-500">Loading…</p>;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">State document</h1>
      <p className="text-sm text-slate-600">
        The goal's working memory. The agent updates it as it works; your edits are saved as versions too.
      </p>
      {problem && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
          {problem}
        </p>
      )}
      {notice && <p className="text-sm text-green-800">{notice}</p>}
      {current && (
        <form onSubmit={save} className="flex flex-col gap-2">
          <textarea
            aria-label="State document"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={14}
            className="rounded-lg border border-slate-300 p-3 font-mono text-sm"
          />
          <div>
            <button
              type="submit"
              disabled={draft === current.text}
              className={`${button} bg-slate-900 text-white disabled:opacity-50`}
            >
              Save
            </button>
          </div>
        </form>
      )}
      <section aria-label="History" className="flex flex-col gap-2">
        <h2 className="font-medium">History</h2>
        {history.length === 0 && <p className="text-slate-600">No versions yet.</p>}
        <ul className="flex flex-col gap-2">
          {history.map((v) => (
            <li
              key={v.version}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3"
            >
              <span className="text-sm">
                Version {v.version} · {v.author === "agent" ? "agent" : "you"} · {v.note} ·{" "}
                {new Date(v.createdAt).toLocaleString()}
              </span>
              {v.version !== current?.version && (
                <button
                  type="button"
                  aria-label={`Restore version ${v.version}`}
                  className={`${button} border border-slate-300 text-slate-700 hover:bg-slate-100`}
                  onClick={() => void restore(v.version)}
                >
                  Restore
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
