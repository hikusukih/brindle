import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { getToken, setToken, unauthorizedEvent } from "./token";

type State = "checking" | "needed" | "ok";

// Asks the server whether the stored token (if any) works, and shows the form when it does not.
export function LoginGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>("checking");
  const [token, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const check = useCallback(async (candidate: string | null) => {
    try {
      const res = await fetch("/api/session", { headers: candidate ? { authorization: `Bearer ${candidate}` } : {} });
      if (res.status === 401) {
        setToken(null);
        setState("needed");
        return false;
      }
      setState("ok");
      return true;
    } catch (e) {
      setProblem(`Could not reach the server: ${String(e)}`);
      setState("needed");
      return false;
    }
  }, []);

  useEffect(() => {
    void check(getToken());
    const onUnauthorized = () => setState("needed");
    window.addEventListener(unauthorizedEvent, onUnauthorized);
    return () => window.removeEventListener(unauthorizedEvent, onUnauthorized);
  }, [check]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const value = token.trim();
    if (await check(value)) setToken(value);
    else setProblem((p) => p ?? "That token was not accepted.");
    setText("");
  };

  if (state === "ok") return <>{children}</>;
  if (state === "checking") return <p className="p-6 text-slate-500">Reaching the server…</p>;
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 p-6">
      <h1 className="text-2xl font-semibold">Brindle</h1>
      <p className="text-slate-600">
        Enter your login token. It is in the server's first-start output, or is the BRINDLE_TOKEN you set.
      </p>
      <form onSubmit={submit} className="flex gap-2">
        <input
          type="password"
          aria-label="Login token"
          autoComplete="current-password"
          value={token}
          onChange={(e) => setText(e.target.value)}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-300 px-3"
        />
        <button type="submit" className="min-h-11 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white">
          Continue
        </button>
      </form>
      {problem && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
          {problem}
        </p>
      )}
    </main>
  );
}
