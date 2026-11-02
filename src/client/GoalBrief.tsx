import { useEffect, useState } from "react";
import { type Artifact, api } from "./api";
import { DeleteChoice } from "./DeleteChoice";

type Goal = { id: string; title: string; status: string; brief: { text: string } };

const quiet = "min-h-11 rounded-lg px-3 text-sm font-medium border border-slate-300 text-slate-700 hover:bg-slate-100";

/** A goal's brief, pinned at the top of its channel, with the goal's delete (which asks about the artifacts). */
export function GoalBrief({ goalId, channelId }: { goalId: string; channelId: string }) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Artifact[] | null>(null);

  useEffect(() => {
    api<Goal>(`/api/goals/${goalId}`)
      .then(setGoal)
      .catch((e: unknown) => setProblem((e as Error).message));
  }, [goalId]);

  const askDelete = async () => {
    try {
      const made = await api<Artifact[]>(`/api/channels/${channelId}/artifacts`);
      if (made.length) setDeleting(made);
      else if (window.confirm("Delete this goal and its channel? This can't be undone.")) await remove([]);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  const remove = async (ids: string[]) => {
    setDeleting(null);
    try {
      await api(`/api/goals/${goalId}`, { method: "DELETE", body: ids.length ? { deleteArtifacts: ids } : undefined });
      window.location.hash = "#/channels";
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  return (
    <section
      aria-label="Goal"
      className="sticky top-0 z-[1] flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3"
    >
      <h2 className="font-medium">Goal: {goal?.title ?? "…"}</h2>
      {goal && <p className="whitespace-pre-wrap text-sm text-slate-700">{goal.brief.text}</p>}
      {problem && (
        <p role="alert" className="text-sm text-red-800">
          {problem}
        </p>
      )}
      {deleting ? (
        <DeleteChoice
          label="Delete goal"
          heading={`Delete this goal and its channel? The channel made ${deleting.length} ${deleting.length === 1 ? "artifact" : "artifacts"}.`}
          confirmLabel="Delete goal"
          artifacts={deleting}
          onConfirm={(ids) => void remove(ids)}
          onCancel={() => setDeleting(null)}
        />
      ) : (
        <button type="button" className={`${quiet} self-start text-red-700`} onClick={() => void askDelete()}>
          Delete goal
        </button>
      )}
    </section>
  );
}
