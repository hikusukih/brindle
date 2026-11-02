import { useEffect, useState } from "react";
import { type Artifact, api } from "./api";

const kinds = ["document", "code", "data", "page", "link"] as const;
const scopes = ["channel", "goal"] as const;
const select = "min-h-11 rounded-lg border border-slate-300 px-3 text-sm";

function Source({ a }: { a: Artifact }) {
  if (a.scope === "goal") return <>from a goal</>;
  if (!a.scopeLive) return <>from deleted channel {a.scopeName}</>;
  return (
    <>
      from <a href={`#/channels/${a.scopeId}`}>{a.scopeName}</a>
      {a.runId && `, run ${a.runId.slice(0, 8)}`}
    </>
  );
}

export function ArtifactsScreen({ empty }: { empty: { title: string; body: string } }) {
  const [kind, setKind] = useState("");
  const [scope, setScope] = useState("");
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    // A slower, older response must not overwrite the one for the filters now on screen.
    let stale = false;
    const q = new URLSearchParams();
    if (kind) q.set("kind", kind);
    if (scope) q.set("scope", scope);
    api<Artifact[]>(`/api/artifacts?${q}`)
      .then((list) => {
        if (stale) return;
        setItems(list);
        setProblem(null);
      })
      .catch((e: unknown) => {
        if (!stale) setProblem(String((e as Error).message));
      });
    return () => {
      stale = true;
    };
  }, [kind, scope]);

  const filtered = kind !== "" || scope !== "";
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Artifacts</h1>
      <div className="flex gap-2">
        <select aria-label="Kind" className={select} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {kinds.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <select aria-label="Scope" className={select} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">All scopes</option>
          {scopes.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      {problem && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
          {problem}
        </p>
      )}
      {items?.length === 0 &&
        (filtered ? (
          <p className="text-slate-600">No artifacts match.</p>
        ) : (
          <div>
            <h2 className="font-medium">{empty.title}</h2>
            <p className="text-slate-600">{empty.body}</p>
          </div>
        ))}
      <ul className="flex flex-col gap-2">
        {items?.map((a) => (
          <li key={a.id} className="rounded-lg border border-slate-200 p-3">
            <div className="font-medium">{a.title}</div>
            <div className="text-sm text-slate-600">
              {a.kind} · {new Date(a.createdAt).toLocaleString()} · <Source a={a} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
