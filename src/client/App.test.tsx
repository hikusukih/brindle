// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

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

  it("offers all four screens in the navigation", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => Response.json(url.startsWith("/api/channels") ? [] : { message: "", since: "" })),
    );
    render(<App />);
    for (const label of ["Channels", "Goals", "Feed", "Artifacts"]) {
      expect(screen.getAllByRole("link", { name: label }).length).toBeGreaterThan(0);
    }
  });
});
