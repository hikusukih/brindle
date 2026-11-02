import { useEffect, useState } from "react";
import type { Greeting } from "../server/app";
import { ArtifactsScreen } from "./Artifacts";
import { api, type Channel, channelsChanged } from "./api";
import { ChannelsScreen } from "./Channels";
import { LoginGate } from "./Login";
import { channelIdFromHash, type ScreenId, screenFromHash, screens } from "./screens";

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
function useScreen(): ScreenId {
  const [screen, setScreen] = useState(() => screenFromHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setScreen(screenFromHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return screen;
}

// Wide screens only: the bottom bar has no room for children, so the narrow Channels tab opens the list itself.
function RailChannels() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [hash, setHash] = useState(window.location.hash);
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    const onChanged = () => setChanges((n) => n + 1);
    window.addEventListener("hashchange", onHash);
    window.addEventListener(channelsChanged, onChanged);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(channelsChanged, onChanged);
    };
  }, []);
  // A hash change or a channels-changed event reloads the list, which picks up a channel created, renamed, archived or deleted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hash and changes are reload triggers, not inputs
  useEffect(() => {
    let cancelled = false;
    api<Channel[]>("/api/channels?archived=false")
      .then((list) => !cancelled && setChannels(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hash, changes]);
  const open = channelIdFromHash(hash);
  if (channels.length === 0) return null;
  return (
    <ul aria-label="Your channels" className="mt-1 mb-1 flex flex-col gap-1 pl-4">
      {channels.map((c) => (
        <li key={c.id}>
          <a
            href={`#/channels/${encodeURIComponent(c.id)}`}
            aria-current={c.id === open ? "page" : undefined}
            className={`flex min-h-10 items-center truncate rounded-lg px-3 text-sm ${
              c.id === open ? "bg-slate-200 font-medium text-slate-900" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {c.name}
          </a>
        </li>
      ))}
    </ul>
  );
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
          {orientation === "rail" && s.id === "channels" && <RailChannels />}
        </li>
      ))}
    </ul>
  );
}

function Shell() {
  const screen = useScreen();
  const status = useServerStatus();
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
        className={`mx-auto flex min-h-dvh max-w-md flex-1 flex-col ${screen === "channels" || screen === "artifacts" ? "" : "justify-center"} gap-2 p-6 pb-24 md:pb-6`}
      >
        {screen === "channels" ? (
          <ChannelsScreen />
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
