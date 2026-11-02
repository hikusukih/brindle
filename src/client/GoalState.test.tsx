// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalStateView, goalStateIdFromHash } from "./GoalState";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("goalStateIdFromHash", () => {
  it("opens only #/goals/<id>/state", () => {
    expect(goalStateIdFromHash("#/goals/g1/state")).toBe("g1");
    expect(goalStateIdFromHash("#/goals/g1")).toBeNull();
    expect(goalStateIdFromHash("#/channels/g1/state")).toBeNull();
  });
});

describe("GoalStateView", () => {
  it("shows the document and its history, saves an edit against the version it read, and restores", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const versions = [
      {
        version: 1,
        text: "old",
        author: "agent",
        note: "first draft",
        createdAt: "2026-01-02T03:04:05.000Z",
        runId: null,
        id: "a",
        goalId: "g1",
      },
      {
        version: 2,
        text: "new",
        author: "user",
        note: "edited by you",
        createdAt: "2026-01-03T03:04:05.000Z",
        runId: null,
        id: "b",
        goalId: "g1",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? "GET";
        calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
        if (path.endsWith("/state/versions")) return Response.json(versions);
        if (path.endsWith("/state")) return Response.json(versions[1]);
        return Response.json({});
      }),
    );
    render(<GoalStateView goalId="g1" />);
    const box = (await screen.findByLabelText("State document")) as HTMLTextAreaElement;
    expect(box.value).toBe("new");
    expect(screen.getByText(/Version 1 · agent · first draft/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(box, { target: { value: "newer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ text: "newer", baseVersion: 2 }));

    fireEvent.click(screen.getByRole("button", { name: "Restore version 1" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/goals/g1/state/versions/1/restore")).toBe(true));
    expect(screen.queryByRole("button", { name: "Restore version 2" })).toBeNull();
  });

  it("shows the server's message when a save is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: { method?: string }) => {
        if (init?.method === "PUT")
          return Response.json({ message: "The document changed while you were editing." }, { status: 409 });
        return Response.json(path.endsWith("/versions") ? [] : { version: 0, text: "" });
      }),
    );
    render(<GoalStateView goalId="g1" />);
    fireEvent.change(await screen.findByLabelText("State document"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed while you were editing/);
  });
});
