import { useEffect, useState } from "react";
import type { Greeting } from "../server/app";
import { ArtifactsScreen } from "./Artifacts";
import { api } from "./api";
import { ChannelsScreen } from "./Channels";
import { GoalStateView, goalStateIdFromHash } from "./GoalState";
import { LoginGate } from "./Login";
import { type ScreenId, screenFromHash, screens } from "./screens";

type State = { kind: "loading" } | { kind: "ready"; greeting: Greeting } | { kind: "error"; message: string };

function useServerStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    // Through api() so the login token goes along; the route is gated like every other.
    api<Greeting>("/api/greeting")
      .then((greeting) => !cancelled && setState({ kind: "ready", greeting }))
      .catch((err: unknown) => !cancelled && setState({ kind: "error", message: String(err) }));
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

// The hash keeps each screen linkable and the back button working without a router dependency.
function useScreen(): { screen: ScreenId; hash: string } {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return { screen: screenFromHash(hash), hash };
}

function NavLinks({ current, orientation }: { current: ScreenId; orientation: "rail" | "bar" }) {
  const layout = orientation === "rail" ? "flex-col gap-1 p-3" : "justify-around pb-[env(safe-area-inset-bottom)]";
  return (
    <ul className={`flex ${layout}`}>
      {screens.map((s) => (
        <li key={s.id} className={orientation === "bar" ? "flex-1" : undefined}>
          <a
            href={`#/${s.id}`}
            aria-current={s.id === current ? "page" : undefined}
            className={`flex min-h-12 items-center justify-center rounded-lg px-3 text-sm font-medium ${
              orientation === "rail" ? "justify-start" : ""
            } ${s.id === current ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
          >
            {s.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function Shell() {
  const { screen, hash } = useScreen();
  const status = useServerStatus();
  const stateGoal = goalStateIdFromHash(hash);
  const active = screens.find((s) => s.id === screen) ?? screens[0];

  return (
    <div className="min-h-dvh font-sans text-slate-800 md:flex">
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-200 bg-white md:static md:w-52 md:shrink-0 md:border-t-0 md:border-r"
      >
        <div className="hidden px-6 pt-5 pb-2 text-lg font-semibold md:block">Brindle</div>
        <div className="md:hidden">
          <NavLinks current={screen} orientation="bar" />
        </div>
        <div className="hidden md:block">
          <NavLinks current={screen} orientation="rail" />
        </div>
      </nav>
      <main
        className={`mx-auto flex min-h-dvh max-w-md flex-1 flex-col ${screen === "channels" || screen === "artifacts" || stateGoal ? "" : "justify-center"} gap-2 p-6 pb-24 md:pb-6`}
      >
        {screen === "channels" ? (
          <ChannelsScreen />
        ) : stateGoal ? (
          <GoalStateView goalId={stateGoal} />
        ) : screen === "artifacts" ? (
          <ArtifactsScreen empty={active.empty} />
        ) : (
          <>
            <h1 className="text-2xl font-semibold">{active.label}</h1>
            <h2 className="font-medium">{active.empty.title}</h2>
            <p className="text-slate-600">{active.empty.body}</p>
          </>
        )}
        <div className="mt-6 text-sm text-slate-500">
          {status.kind === "loading" && <p>Reaching the server…</p>}
          {status.kind === "ready" && (
            <>
              <p>{status.greeting.message}</p>
              <p>Running since {new Date(status.greeting.since).toLocaleString()}</p>
            </>
          )}
          {status.kind === "error" && <p className="text-red-700">Could not reach the server: {status.message}</p>}
        </div>
      </main>
    </div>
  );
}

export function App() {
  return (
    <LoginGate>
      <Shell />
    </LoginGate>
  );
}
