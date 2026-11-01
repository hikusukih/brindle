// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, Run } from "./api";
import { ChannelsScreen } from "./Channels";

const stamp = "2026-01-02T03:04:05.000Z";
const channel = (id: string, name: string, archivedAt: string | null = null): Channel => ({
  id,
  name,
  createdAt: stamp,
  updatedAt: stamp,
  archivedAt,
  model: null,
});

// Stands in for the browser's EventSource; a test pushes events through the most recent instance.
class FakeSource {
  static last: FakeSource | undefined;
  static CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: Event) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, seq: number, data: object) {
    const e = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: String(seq) });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  close() {
    this.readyState = FakeSource.CLOSED;
  }
}

type Handler = (method: string, body: unknown) => Response | undefined;

function stubFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      const res = routes[path]?.(method, init?.body ? JSON.parse(init.body) : undefined);
      return res ?? new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  window.confirm = vi.fn(() => true);
  FakeSource.last = undefined;
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.unstubAllGlobals();
});

describe("channel list", () => {
  it("creates a channel and opens it", async () => {
    let list = [] as Channel[];
    stubFetch({
      "/api/channels?archived=false": () => Response.json(list),
      "/api/channels": (method) => {
        list = [channel("c1", "Plans")];
        return method === "POST" ? Response.json(list[0], { status: 201 }) : Response.json(list);
      },
      "/api/channels/c1/runs": () => Response.json([]),
      "/api/channels?archived=true": () => Response.json([]),
    });
    render(<ChannelsScreen />);
    expect(await screen.findByText("No channels yet")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("New channel name"), { target: { value: "Plans" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(window.location.hash).toBe("#/channels/c1"));
  });

  it("renames, archives, restores and deletes", async () => {
    const calls = stubFetch({
      "/api/channels?archived=false": () => Response.json([channel("c1", "Plans")]),
      "/api/channels?archived=true": () => Response.json([channel("c2", "Old", stamp)]),
      "/api/channels/c1": () => new Response(null, { status: 204 }),
      "/api/channels/c1/artifacts": () => Response.json([]),
      "/api/channels/c1/archive": () => Response.json({}),
      "/api/channels/c2/restore": () => Response.json({}),
    });
    render(<ChannelsScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: "Plans 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toContain("PATCH /api/channels/c1"));

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    await waitFor(() => expect(calls).toContain("POST /api/channels/c1/archive"));

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls).toContain("DELETE /api/channels/c1"));

    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls).toContain("POST /api/channels/c2/restore"));
  });

  it("asks what to do with the artifacts a channel made, keeping them by default", async () => {
    const art = (id: string, title: string) => ({ id, title });
    let deleteBody: unknown = "unset";
    const calls = stubFetch({
      "/api/channels?archived=false": () => Response.json([channel("c1", "Plans")]),
      "/api/channels/c1/artifacts": () => Response.json([art("a1", "Itinerary"), art("a2", "Budget")]),
      "/api/channels/c1": (_m, body) => {
        deleteBody = body;
        return new Response(null, { status: 204 });
      },
    });
    render(<ChannelsScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("radio", { name: "Keep all artifacts" })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));
    await waitFor(() => expect(calls).toContain("DELETE /api/channels/c1"));
    expect(deleteBody).toBeUndefined();

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Choose which to delete" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Budget" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));
    await waitFor(() => expect(deleteBody).toEqual({ deleteArtifacts: ["a2"] }));

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Delete all artifacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));
    await waitFor(() => expect(deleteBody).toEqual({ deleteArtifacts: ["a1", "a2"] }));
  });

  it("shows the server's message when an action fails", async () => {
    stubFetch({
      "/api/channels?archived=false": () => Response.json([]),
      "/api/channels": () => Response.json({ message: "A channel name is 1 to 120 characters." }, { status: 400 }),
    });
    render(<ChannelsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toContain("1 to 120 characters");
  });
});

describe("channel view", () => {
  const event = (seq: number, type: string, data: object) => ({
    id: `e${seq}`,
    runId: "r1",
    seq,
    type,
    data: JSON.stringify(data),
    createdAt: stamp,
  });
  const run = (status: Run["status"], stopReason: string | null, events: Run["events"]): Run => ({
    id: "r1",
    channelId: "c1",
    status,
    stopReason,
    startedAt: stamp,
    endedAt: stamp,
    events,
  });

  it("sends a message, streams the reply and shows it", async () => {
    window.location.hash = "#/channels/c1";
    let runs: Run[] = [];
    stubFetch({
      "/api/channels": () => Response.json([channel("c1", "Plans")]),
      "/api/channels/c1/runs": (method) => {
        if (method === "POST") return Response.json(run("running", null, []), { status: 201 });
        return Response.json(runs);
      },
    });
    render(<ChannelsScreen />);
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "hi" } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(FakeSource.last).toBeDefined());
    const source = FakeSource.last as FakeSource;
    act(() => {
      source.emit("message", 1, { text: "hi" });
      source.emit("text", 2, { text: "Hello there." });
      source.emit("text", 2, { text: "Hello there." });
    });
    expect(await screen.findByText("Hello there.")).toBeTruthy();
    expect(screen.getAllByText("Hello there.").length).toBe(1);

    runs = [run("done", null, [event(1, "message", { text: "hi" }), event(2, "text", { text: "Hello there." })])];
    act(() => source.emit("end", 0, { status: "done" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
  });

  it("shows a failed run's error in place and keeps the channel usable", async () => {
    window.location.hash = "#/channels/c1";
    stubFetch({
      "/api/channels": () => Response.json([channel("c1", "Plans")]),
      "/api/channels/c1/runs": () =>
        Response.json([
          run("failed", "model unreachable", [
            event(1, "message", { text: "hi" }),
            event(2, "error", { message: "The model could not be reached." }),
          ]),
        ]),
    });
    render(<ChannelsScreen />);
    expect((await screen.findByRole("alert")).textContent).toBe("The model could not be reached.");
    expect(screen.getByText("hi")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("shows an approval card for an external tool and sends the decision", async () => {
    window.location.hash = "#/channels/c1";
    const calls = stubFetch({
      "/api/channels": () => Response.json([channel("c1", "Plans")]),
      "/api/channels/c1/runs": () =>
        Response.json([
          run("waiting", null, [
            event(1, "message", { text: "mail it" }),
            event(2, "approval_request", {
              callId: "k1",
              tool: "send_email",
              reason: "Send an email to Sam",
              arguments: { to: "sam@example.com" },
            }),
          ]),
        ]),
      "/api/runs/r1/approvals/k1": (_m, body) => {
        expect(body).toEqual({ decision: "approve" });
        return Response.json({});
      },
    });
    render(<ChannelsScreen />);
    expect(await screen.findByText("Send an email to Sam")).toBeTruthy();
    expect(screen.getByText(/sam@example.com/)).toBeTruthy();
    // A waiting run keeps the channel busy, so the message box offers Cancel rather than Send.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls).toContain("POST /api/runs/r1/approvals/k1"));
  });

  it("shows a settled approval as answered, without buttons", async () => {
    window.location.hash = "#/channels/c1";
    stubFetch({
      "/api/channels": () => Response.json([channel("c1", "Plans")]),
      "/api/channels/c1/runs": () =>
        Response.json([
          run("done", null, [
            event(1, "approval_request", { callId: "k1", tool: "send_email", reason: "Send it", arguments: {} }),
            event(2, "approval_decision", { callId: "k1", decision: "decline" }),
          ]),
        ]),
    });
    render(<ChannelsScreen />);
    expect(await screen.findByText("Declined.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("shows which model the channel uses and lets the user set one", async () => {
    window.location.hash = "#/channels/c1";
    const calls = stubFetch({
      "/api/models": () => Response.json({ default: "openai:gpt-test" }),
      "/api/channels": () => Response.json([channel("c1", "Plans")]),
      "/api/channels/c1/runs": () => Response.json([]),
      "/api/channels/c1/model": (_m, body) =>
        Response.json({ ...channel("c1", "Plans"), model: (body as { model: string | null }).model }),
    });
    render(<ChannelsScreen />);
    expect(await screen.findByText("Model: openai:gpt-test (default)")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Model for this channel"), { target: { value: "anthropic:claude-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Set model" }));
    expect(await screen.findByText("Model: anthropic:claude-test")).toBeTruthy();
    expect(calls).toContain("POST /api/channels/c1/model");
  });

  it("rebuilds each channel's own history and failure after a reload", async () => {
    stubFetch({
      "/api/channels": () => Response.json([channel("c1", "Plans"), channel("c2", "Cooking")]),
      "/api/channels/c1/runs": () => Response.json([run("done", null, [event(1, "message", { text: "Plan it." })])]),
      "/api/channels/c2/runs": () =>
        Response.json([
          run("failed", "model unreachable", [
            event(1, "message", { text: "Soup?" }),
            event(2, "error", { message: "The model could not be reached." }),
          ]),
        ]),
    });
    for (const [hash, shown, hidden] of [
      ["#/channels/c2", "Soup?", "Plan it."],
      ["#/channels/c1", "Plan it.", "Soup?"],
      ["#/channels/c2", "Soup?", "Plan it."],
    ] as const) {
      window.location.hash = hash;
      const { unmount } = render(<ChannelsScreen />);
      expect(await screen.findByText(shown)).toBeTruthy();
      expect(screen.queryByText(hidden)).toBeNull();
      expect(screen.queryAllByRole("alert").length).toBe(hash === "#/channels/c2" ? 1 : 0);
      unmount();
    }
  });

  it("is read-only when the channel is archived", async () => {
    window.location.hash = "#/channels/c1";
    stubFetch({
      "/api/channels": () => Response.json([]),
      "/api/channels?archived=true": () => Response.json([channel("c1", "Old", stamp)]),
      "/api/channels/c1/runs": () => Response.json([]),
    });
    render(<ChannelsScreen />);
    expect(await screen.findByText(/This channel is archived/)).toBeTruthy();
    expect(screen.queryByLabelText("Message")).toBeNull();
  });
});
