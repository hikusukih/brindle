// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { AuthedEventSource } from "./events";
import { LoginGate } from "./Login";
import { getToken } from "./token";

const token = "test-token-1234abcd1234abcd";

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const server = () =>
  vi.fn(async (path: string, init?: { headers?: Record<string, string> }) => {
    const ok = init?.headers?.authorization === `Bearer ${token}`;
    return ok
      ? new Response(path === "/api/session" ? null : "{}", { status: path === "/api/session" ? 204 : 200 })
      : new Response("{}", { status: 401 });
  });

describe("LoginGate", () => {
  it("asks once, keeps the token for the session, and sends it as a header", async () => {
    const fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <LoginGate>
        <p>inside</p>
      </LoginGate>,
    );
    fireEvent.change(await screen.findByLabelText("Login token"), { target: { value: "wrong-token-1234abcd" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not accepted/);
    expect(getToken()).toBeNull();

    fireEvent.change(screen.getByLabelText("Login token"), { target: { value: token } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("inside")).toBeTruthy();
    expect(getToken()).toBe(token);

    await api("/api/channels");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/channels",
      expect.objectContaining({ headers: { authorization: `Bearer ${token}` } }),
    );
  });

  it("skips the form when the stored token still works, and returns to it when the server refuses", async () => {
    window.sessionStorage.setItem("brindle-token", token);
    vi.stubGlobal("fetch", server());
    render(
      <LoginGate>
        <p>inside</p>
      </LoginGate>,
    );
    expect(await screen.findByText("inside")).toBeTruthy();
    window.sessionStorage.setItem("brindle-token", "changed-token-1234abcd");
    await expect(api("/api/channels")).rejects.toThrow();
    expect(await screen.findByLabelText("Login token")).toBeTruthy();
    expect(getToken()).toBeNull();
  });
});

describe("AuthedEventSource", () => {
  it("sends the token and turns the stream into events", async () => {
    window.sessionStorage.setItem("brindle-token", token);
    const body = new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('id: 1\nevent: text\ndata: {"text":"hi"}\n\nid: 2\nevent: te'));
        c.enqueue(enc.encode('xt\ndata: {"text":"yo"}\n\nevent: end\ndata: {"status":"done"}\n\n'));
        c.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const es = new AuthedEventSource("/api/runs/r1/events");
    const got: string[] = [];
    es.addEventListener("text", (e) => got.push(`${(e as MessageEvent).lastEventId}:${(e as MessageEvent).data}`));
    let ended = false;
    es.addEventListener("end", () => {
      ended = true;
    });
    const failed = vi.fn();
    es.onerror = failed;
    await waitFor(() => expect(ended).toBe(true));
    expect(got).toEqual(['1:{"text":"hi"}', '2:{"text":"yo"}']);
    expect((fetchMock.mock.calls as unknown[][])[0]?.[1]).toMatchObject({
      headers: { authorization: `Bearer ${token}` },
    });
    expect(failed).not.toHaveBeenCalled();
  });

  it("reports a refused or dropped stream as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    const es = new AuthedEventSource("/api/runs/r1/events");
    const failed = vi.fn();
    es.onerror = failed;
    await waitFor(() => expect(failed).toHaveBeenCalled());
    expect(es.readyState).toBe(AuthedEventSource.CLOSED);
  });
});
