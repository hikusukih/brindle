import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useTimeZone } from "./TimeZone";

type Goal = { id: string; title: string; channelId: string; brief: { text: string }; nextRunAt: string | null };
type Draft = { title: string; brief: string; schedule: { cron: string; prompt: string } | null };

const field = "rounded-lg border border-slate-300 p-2";
const button = "min-h-11 rounded-lg border border-slate-300 px-3";

/** Two letters from the title's words, so the same title always gets the same icon without an image. */
export function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters =
    words.length === 1
      ? Array.from(words[0] as string).slice(0, 2)
      : words.slice(0, 2).map((w) => Array.from(w)[0] as string);
  return letters.join("").toUpperCase();
}

/** A hue from the title, so tiles differ from each other but never change between visits. */
export function hueOf(title: string): number {
  let h = 0;
  for (const ch of title) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return h;
}

export type GoalValues = { title: string; brief: string; cron: string; prompt: string };

/** The title, brief and schedule fields of a goal draft, drawn here for the Goals screen and on the approval card of a proposed goal. */
export function GoalFields({
  values,
  onChange,
  schedulesAvailable,
}: {
  values: GoalValues;
  onChange: (next: GoalValues) => void;
  schedulesAvailable: boolean;
}) {
  const { title, brief, cron, prompt } = values;
  const set = (patch: Partial<GoalValues>) => onChange({ ...values, ...patch });
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        Title
        <input className={field} value={title} onChange={(e) => set({ title: e.target.value })} maxLength={120} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Brief
        <textarea className={`min-h-24 ${field}`} value={brief} onChange={(e) => set({ brief: e.target.value })} />
      </label>
      {schedulesAvailable && (
        <label className="flex flex-col gap-1 text-sm">
          Schedule (five-field cron, optional)
          <input
            className={field}
            value={cron}
            onChange={(e) => set({ cron: e.target.value })}
            placeholder="0 9 * * 1"
          />
        </label>
      )}
      {schedulesAvailable && cron.trim() && (
        <label className="flex flex-col gap-1 text-sm">
          What each run should do
          <input className={field} value={prompt} onChange={(e) => set({ prompt: e.target.value })} />
        </label>
      )}
    </>
  );
}

function GoalForm({
  draft,
  schedulesAvailable,
  onDone,
  onCancel,
}: {
  draft: Draft;
  schedulesAvailable: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<GoalValues>({
    title: draft.title,
    brief: draft.brief,
    cron: draft.schedule?.cron ?? "",
    prompt: draft.schedule?.prompt ?? "",
  });
  const { title, brief, cron, prompt } = values;
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    try {
      const schedule =
        schedulesAvailable && cron.trim()
          ? { cron: cron.trim(), prompt: prompt.trim() || brief.trim() || title.trim() }
          : undefined;
      await api("/api/goals", { method: "POST", body: { title, brief, schedule } });
      onDone();
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  return (
    <form
      aria-label="New goal"
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <GoalFields values={values} onChange={setValues} schedulesAvailable={schedulesAvailable} />
      {problem && (
        <p role="alert" className="text-sm text-red-700">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className="min-h-11 rounded-lg bg-slate-900 px-3 text-white">
          Create goal
        </button>
        <button type="button" className={button} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function GoalsScreen({ empty }: { empty: { title: string; body: string } }) {
  const { format } = useTimeZone();
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [words, setWords] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Goal[]>("/api/goals")
      .then((list) => setGoals(Array.isArray(list) ? list : []))
      .catch(() => setGoals([]));
  }, []);
  useEffect(load, [load]);
  // Hidden until the server says it can schedule, so the form never offers what creating the goal would refuse.
  const [schedulesAvailable, setSchedulesAvailable] = useState(false);
  useEffect(() => {
    api<{ schedulesAvailable: boolean }>("/api/goals/options")
      .then((o) => setSchedulesAvailable(o.schedulesAvailable))
      .catch(() => setSchedulesAvailable(false));
  }, []);

  const create = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setDraft(await api<Draft>("/api/goals/draft", { method: "POST", body: { text: words } }));
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="text-2xl font-semibold">Goals</h1>
      {draft ? (
        <GoalForm
          draft={draft}
          schedulesAvailable={schedulesAvailable}
          onCancel={() => setDraft(null)}
          onDone={() => {
            setDraft(null);
            setWords("");
            load();
          }}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label="Describe a goal"
            className={`min-h-24 ${field}`}
            placeholder="Describe something you want kept up, or paste notes about it"
            value={words}
            onChange={(e) => setWords(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="min-h-11 rounded-lg bg-slate-900 px-3 text-white disabled:opacity-50"
              disabled={busy || !words.trim()}
              onClick={() => void create()}
            >
              {busy ? "Drafting…" : "Create"}
            </button>
            <button type="button" className={button} onClick={() => setDraft({ title: "", brief: "", schedule: null })}>
              Write it myself
            </button>
          </div>
          {problem && (
            <p role="alert" className="text-sm text-red-700">
              {problem}
            </p>
          )}
        </div>
      )}
      {goals?.length === 0 && (
        <>
          <h2 className="font-medium">{empty.title}</h2>
          <p className="text-slate-600">{empty.body}</p>
        </>
      )}
      {goals && goals.length > 0 && (
        <ul aria-label="Your goals" className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
          {goals.map((g) => (
            <li key={g.id}>
              <a
                href={`#/channels/${encodeURIComponent(g.channelId)}`}
                className="flex aspect-square max-w-[200px] flex-col gap-1 overflow-hidden rounded-lg border border-slate-200 p-3 hover:bg-slate-50"
              >
                <span
                  aria-hidden="true"
                  className="flex size-12 shrink-0 items-center justify-center rounded-lg text-lg font-semibold text-white"
                  style={{ backgroundColor: `hsl(${hueOf(g.title)} 45% 40%)` }}
                >
                  {initials(g.title)}
                </span>
                <span className="font-medium">{g.title}</span>
                <span className="line-clamp-1 text-sm text-slate-600">{g.brief.text}</span>
                <span className="mt-auto text-xs text-slate-500">
                  {g.nextRunAt ? `Next: ${format(g.nextRunAt)}` : "Not scheduled"}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
