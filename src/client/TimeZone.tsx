import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api";

// The user's own zone, not the browser's, so a phone on a trip does not disagree with the schedules.
type Value = { zone: string | null; format: (iso: string) => string; change: (zone: string) => Promise<void> };

const Context = createContext<Value>({
  zone: null,
  format: (iso) => new Date(iso).toLocaleString(),
  change: async () => {},
});

export const useTimeZone = () => useContext(Context);

export function TimeZoneProvider({ children }: { children: ReactNode }) {
  const [zone, setZone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The first time the app opens nothing is set, so the browser's zone is offered; a choice already made wins.
    const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
    api<{ timeZone: string | null }>("/api/settings/time-zone")
      .then((got) =>
        got.timeZone
          ? got
          : api<{ timeZone: string }>("/api/settings/time-zone", {
              method: "PUT",
              body: { timeZone: guess, onlyIfUnset: true },
            }),
      )
      .then((got) => !cancelled && setZone(got.timeZone))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const change = useCallback(async (next: string) => {
    const got = await api<{ timeZone: string }>("/api/settings/time-zone", { method: "PUT", body: { timeZone: next } });
    setZone(got.timeZone);
  }, []);

  const value = useMemo<Value>(
    () => ({
      zone,
      format: (iso) =>
        new Date(iso).toLocaleString(undefined, zone ? { timeZone: zone, timeZoneName: "short" } : undefined),
      change,
    }),
    [zone, change],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Shows the zone times are read in and lets the user change it. */
export function TimeZoneSetting() {
  const { zone, change } = useTimeZone();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  if (!zone) return null;

  const save = async () => {
    try {
      await change(draft.trim());
      setEditing(false);
      setProblem(null);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  if (!editing) {
    return (
      <p>
        Times are shown in {zone}.{" "}
        <button
          type="button"
          className="underline"
          onClick={() => {
            setDraft(zone);
            setEditing(true);
          }}
        >
          Change
        </button>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        Time zone
        <input
          list="time-zones"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-11 rounded-lg border border-slate-300 px-3"
        />
      </label>
      <datalist id="time-zones">
        {Intl.supportedValuesOf("timeZone").map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {problem && (
        <p role="alert" className="text-red-700">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" onClick={save} className="min-h-11 rounded-lg bg-slate-900 px-3 text-white">
          Save
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="min-h-11 rounded-lg border border-slate-300 px-3"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
