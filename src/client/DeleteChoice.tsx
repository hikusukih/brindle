import { useState } from "react";
import type { Artifact } from "./api";

const quiet = "min-h-11 rounded-lg px-3 text-sm font-medium border border-slate-300 text-slate-700 hover:bg-slate-100";

/**
 * The question both a channel's delete and a goal's delete ask: what happens to the artifacts the channel made.
 * Keeping them all is the default; `onConfirm` gets the ids to delete (empty to keep every one).
 */
export function DeleteChoice({
  label,
  heading,
  confirmLabel,
  artifacts,
  onConfirm,
  onCancel,
}: {
  label: string;
  heading: string;
  confirmLabel: string;
  artifacts: Artifact[];
  onConfirm: (ids: string[]) => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<"keep" | "all" | "some">("keep");
  const [picked, setPicked] = useState<string[]>([]);
  const ids = choice === "all" ? artifacts.map((a) => a.id) : choice === "some" ? picked : [];

  return (
    <section aria-label={label} className="flex flex-col gap-2 rounded-lg border border-red-200 p-3">
      <h2 className="font-medium">{heading}</h2>
      {(
        [
          ["keep", "Keep all artifacts"],
          ["all", "Delete all artifacts"],
          ["some", "Choose which to delete"],
        ] as const
      ).map(([value, text]) => (
        <label key={value} className="flex min-h-11 items-center gap-2">
          <input type="radio" name="artifact-choice" checked={choice === value} onChange={() => setChoice(value)} />
          {text}
        </label>
      ))}
      {choice === "some" && (
        <ul className="flex flex-col">
          {artifacts.map((a) => (
            <li key={a.id}>
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  checked={picked.includes(a.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))}
                />
                {a.title}
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <button type="button" className={`${quiet} text-red-700`} onClick={() => onConfirm(ids)}>
          {confirmLabel}
        </button>
        <button type="button" className={quiet} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
