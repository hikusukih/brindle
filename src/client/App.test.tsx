// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { setToken } from "./token";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("shows the greeting fetched from the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/channels") || url.startsWith("/api/artifacts")
          ? Response.json([])
          : Response.json({ message: "Hello from Brindle.", since: "2026-01-02T03:04:05.000Z" }),
      ),
    );
    render(<App />);
    expect(await screen.findByText("Hello from Brindle.")).toBeTruthy();
  });

  it("sends the login token with the greeting request, since the route is gated", async () => {
    setToken("test-token-1234abcd");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) =>
        init?.headers?.authorization !== "Bearer test-token-1234abcd"
          ? new Response("", { status: 401 })
          : url.startsWith("/api/channels")
            ? Response.json([])
            : Response.json({ message: "Hello from Brindle.", since: "2026-01-02T03:04:05.000Z" }),
      ),
    );
    render(<App />);
    expect(await screen.findByText("Hello from Brindle.")).toBeTruthy();
    setToken(null);
  });

  it("says so when the server cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    render(<App />);
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
  });

  it("shows an empty state for each screen and marks the current one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/channels") || url.startsWith("/api/artifacts")
          ? Response.json([])
          : Response.json({ message: "Hello from Brindle.", since: "2026-01-02T03:04:05.000Z" }),
      ),
    );
    render(<App />);
    expect(await screen.findByText("No channels yet")).toBeTruthy();
    const expected = { goals: "No goals yet", feed: "Nothing in the feed", artifacts: "No artifacts yet" };
    for (const [id, title] of Object.entries(expected)) {
      act(() => {
        window.location.hash = `#/${id}`;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(await screen.findByText(title)).toBeTruthy();
      const current = screen.getAllByRole("link", { current: "page" });
      expect(current.every((a) => a.getAttribute("href") === `#/${id}`)).toBe(true);
    }
  });

  it("offers all four screens in the navigation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => Response.json(url.startsWith("/api/channels") ? [] : { message: "", since: "" })),
    );
    render(<App />);
    await screen.findByText("No channels yet");
    for (const label of ["Channels", "Goals", "Feed", "Artifacts"]) {
      expect(screen.getAllByRole("link", { name: label }).length).toBeGreaterThan(0);
    }
  });

  it("lists channels under the Channels heading in the wide rail only", async () => {
    const list = [
      { id: "c1", name: "Trip planning", archivedAt: null },
      { id: "c2", name: "Budget", archivedAt: null },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => Response.json(url.startsWith("/api/channels") ? list : { message: "", since: "" })),
    );
    render(<App />);
    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    // Once in the rail; the bar (narrow) renders no children.
    const children = await nav.findAllByRole("link", { name: "Trip planning" });
    expect(children).toHaveLength(1);
    expect(children[0]?.getAttribute("href")).toBe("#/channels/c1");
    expect(nav.getAllByRole("link", { name: "Budget" })).toHaveLength(1);
    for (const tab of screen.getAllByRole("link", { name: "Channels" }))
      expect(tab.getAttribute("href")).toBe("#/channels");
  });

  it("takes an archived channel out of the rail without a navigation", async () => {
    let list = [
      { id: "c1", name: "Trip planning", archivedAt: null },
      { id: "c2", name: "Budget", archivedAt: null },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/channels/c2/archive") {
          list = list.filter((c) => c.id !== "c2");
          return Response.json({});
        }
        if (url === "/api/channels?archived=false") return Response.json(list);
        if (url === "/api/greeting") return Response.json({ message: "", since: "" });
        return Response.json([]);
      }),
    );
    window.location.hash = "#/channels";
    render(<App />);
    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    expect(await nav.findAllByRole("link", { name: "Budget" })).toHaveLength(1);
    const budgetRow = (await screen.findAllByText("Budget")).find((el) => el.closest("main"));
    const row = (budgetRow as HTMLElement).closest("li") as HTMLElement;
    await act(async () => {
      within(row).getByRole("button", { name: "Archive" }).click();
    });
    await vi.waitFor(() => expect(nav.queryByRole("link", { name: "Budget" })).toBeNull());
    expect(nav.getByRole("link", { name: "Trip planning" })).toBeTruthy();
  });
});
