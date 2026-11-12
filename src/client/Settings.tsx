import { useEffect, useState } from "react";
import { api, type ModelList, type ModelSettingsView, type ModelSettingValues } from "./api";

type Field = { key: Exclude<keyof ModelSettingValues, "warmCache">; label: string; unit?: number };
const fields: Field[] = [
  { key: "contextWindow", label: "Context window (tokens)" },
  { key: "maxSteps", label: "Steps per run" },
  { key: "maxTokens", label: "Tokens per run" },
  // Milliseconds in the file, seconds here, since nobody thinks of a time limit in thousandths.
  { key: "maxMillis", label: "Time limit per run (seconds)", unit: 1000 },
  { key: "housekeepingMillis", label: "Time limit per housekeeping call (seconds)", unit: 1000 },
];

/** One model's numbers. An empty box means "use the default", shown as its placeholder. */
function ModelLimits({ view, onSaved }: { view: ModelSettingsView; onSaved: (v: ModelSettingsView) => void }) {
  const initial = () => {
    const out: Record<string, string> = {};
    for (const f of fields) {
      const set = view.configured[f.key];
      out[f.key] = set === undefined ? "" : String(set / (f.unit ?? 1));
    }
    return out;
  };
  const [values, setValues] = useState(initial);
  const [warm, setWarm] = useState(
    view.configured.warmCache === undefined ? "default" : String(view.configured.warmCache),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    const settings: Record<string, number | boolean | null> = {};
    for (const f of fields) {
      const text = (values[f.key] ?? "").trim();
      settings[f.key] = text === "" ? null : Math.round(Number(text) * (f.unit ?? 1));
    }
    settings.warmCache = warm === "default" ? null : warm === "true";
    try {
      const next = await api<ModelSettingsView>("/api/settings/model-settings", {
        method: "PUT",
        body: { model: view.spec, settings },
      });
      onSaved(next);
      setProblem(null);
      setSaved(true);
    } catch (e) {
      setProblem((e as Error).message);
      setSaved(false);
    }
  };

  return (
    <details className="rounded-lg border border-slate-200 px-3 py-2">
      <summary className="min-h-11 cursor-pointer py-2">Limits for {view.spec}</summary>
      <div className="flex flex-col gap-3 pb-2">
        {(view.problem || problem) && (
          <p role="alert" className="text-sm text-red-700">
            {problem ?? view.problem}
          </p>
        )}
        {fields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-sm">
            {f.label}
            <input
              type="number"
              inputMode="numeric"
              min={1}
              className="min-h-11 rounded-lg border border-slate-300 px-3"
              placeholder={String(view.effective[f.key] / (f.unit ?? 1))}
              value={values[f.key] ?? ""}
              onChange={(e) => {
                setSaved(false);
                setValues({ ...values, [f.key]: e.target.value });
              }}
            />
            {f.key === "contextWindow" && (
              <span className="text-xs text-slate-500">
                {view.serverWindow === null
                  ? "The server does not report a window."
                  : `The server reports ${view.serverWindow}.`}
              </span>
            )}
          </label>
        ))}
        <label className="flex flex-col gap-1 text-sm">
          Warm the cache after a fold
          <select
            className="min-h-11 rounded-lg border border-slate-300 px-3"
            value={warm}
            onChange={(e) => {
              setSaved(false);
              setWarm(e.target.value);
            }}
          >
            <option value="default">Default ({view.effective.warmCache ? "on" : "off"})</option>
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        </label>
        <button type="button" className="min-h-11 self-start rounded-lg bg-slate-800 px-4 text-white" onClick={save}>
          Save limits
        </button>
        {saved && (
          <p role="status" className="text-sm text-slate-600">
            Saved.
          </p>
        )}
      </div>
    </details>
  );
}

// Only what the server shows: a model's name, its provider and whether its key is present. No key or address can be entered here.
export function SettingsScreen() {
  const [list, setList] = useState<ModelList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [views, setViews] = useState<ModelSettingsView[]>([]);

  useEffect(() => {
    api<ModelSettingsView[]>("/api/settings/model-settings")
      .then((v) => setViews(Array.isArray(v) ? v : []))
      .catch(() => {});
    api<ModelList>("/api/models")
      .then(setList)
      .catch((e: unknown) => setProblem(String((e as Error).message)));
  }, []);

  const choose = async (model: string) => {
    try {
      const { default: chosen } = await api<{ default: string | null }>("/api/settings/default-model", {
        method: "PUT",
        body: { model },
      });
      setList((l) => (l ? { ...l, default: chosen } : l));
      setProblem(null);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <section aria-label="Models" className="flex flex-col gap-2">
        <h2 className="font-medium">Models</h2>
        <p className="text-sm text-slate-600">
          Channels without a model of their own use the default. Models are added where the server is configured.
        </p>
        {problem && <p className="text-sm text-red-700">{problem}</p>}
        {list && list.models.length === 0 && <p className="text-slate-600">No models are configured on the server.</p>}
        <ul className="flex flex-col gap-2">
          {list?.models.map((m) => (
            <li key={m.spec} className="flex min-h-11 items-center gap-3 rounded-lg border border-slate-200 px-3">
              <label className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="radio"
                  name="default-model"
                  checked={list.default === m.spec}
                  disabled={!m.keyPresent}
                  onChange={() => choose(m.spec)}
                />
                <span className="truncate">{m.spec}</span>
              </label>
              <span className="text-xs text-slate-500">{m.keyPresent ? "ready" : "key missing"}</span>
            </li>
          ))}
        </ul>
      </section>
      {views.length > 0 && (
        <section aria-label="Limits" className="flex flex-col gap-2">
          <h2 className="font-medium">Limits per model</h2>
          <p className="text-sm text-slate-600">
            Leave a box empty to use the default shown in it. The window can't be larger than the one the server
            reports.
          </p>
          {views.map((v) => (
            <ModelLimits
              key={v.spec}
              view={v}
              onSaved={(next) => setViews((all) => all.map((x) => (x.spec === next.spec ? next : x)))}
            />
          ))}
        </section>
      )}
    </div>
  );
}
