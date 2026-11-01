import { useEffect, useState } from "react";
import { api, type ModelList } from "./api";

// Only what the server shows: a model's name, its provider and whether its key is present. No key or address can be entered here.
export function SettingsScreen() {
  const [list, setList] = useState<ModelList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
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
    </div>
  );
}
