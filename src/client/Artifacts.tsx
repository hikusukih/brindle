import { useEffect, useState } from "react";
import { type Artifact, api, fetchArtifactFile } from "./api";

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

type Opened = { kind: "text"; text: string } | { kind: "download"; url: string; name: string };

// A model wrote these files, perhaps from fetched web text. They are only ever shown as text through React (which
// escapes it) or handed over as a download of opaque bytes; nothing here puts a file's content into the page as markup.
function OpenArtifact({ a }: { a: Artifact }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    return () => {
      if (opened?.kind === "download") URL.revokeObjectURL(opened.url);
    };
  }, [opened]);

  const open = async () => {
    setBusy(true);
    try {
      const blob = await fetchArtifactFile(a.id);
      if (a.kind === "document" || a.kind === "code") {
        setOpened({ kind: "text", text: await blob.text() });
      } else {
        const bytes = new Blob([blob], { type: "application/octet-stream" });
        setOpened({
          kind: "download",
          url: URL.createObjectURL(bytes),
          name: a.title.replace(/[^\w.-]+/g, "_") || "artifact",
        });
      }
      setProblem(null);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-2">
      {!opened && (
        <button
          type="button"
          onClick={open}
          disabled={busy}
          className="min-h-11 self-start rounded-lg border border-slate-300 px-3 text-sm font-medium"
        >
          Open
        </button>
      )}
      {problem && (
        <p role="alert" className="text-sm text-red-800">
          {problem}
        </p>
      )}
      {opened?.kind === "text" && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm">
          {opened.text}
        </pre>
      )}
      {opened?.kind === "download" && (
        <a href={opened.url} download={opened.name} className="min-h-11 self-start text-sm font-medium underline">
          Download {a.title}
        </a>
      )}
    </div>
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
            <OpenArtifact a={a} />
          </li>
        ))}
      </ul>
    </div>
  );
}
