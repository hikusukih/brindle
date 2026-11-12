// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.unstubAllGlobals();
});

function server(initial: string | null) {
  let zone = initial;
  const puts: unknown[] = [];
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/settings/time-zone") {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { timeZone: string; onlyIfUnset?: boolean };
        puts.push(body);
        if (!(body.onlyIfUnset && zone)) zone = body.timeZone;
      }
      return Response.json({ timeZone: zone });
    }
    if (url.startsWith("/api/channels")) return Response.json([]);
    return Response.json({ message: "Hello from Brindle.", since: "2026-01-02T03:04:05.000Z" });
  });
  vi.stubGlobal("fetch", fetchStub);
  return { puts };
}

describe("the user's time zone in the app", () => {
  it("offers the browser's zone the first time and shows times in the zone that is set", async () => {
    const { puts } = server(null);
    render(<App />);
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(await screen.findByText(new RegExp(`Times are shown in ${browser}`))).toBeTruthy();
    expect(puts[0]).toEqual({ timeZone: browser, onlyIfUnset: true });
  });

  it("keeps a zone already chosen, shows times in it, and changes it from the app", async () => {
    const { puts } = server("Asia/Tokyo");
    render(<App />);
    expect(await screen.findByText(/Times are shown in Asia\/Tokyo/)).toBeTruthy();
    // 03:04 UTC is 12:04 in Tokyo, whatever zone the test machine is in.
    expect(await screen.findByText(/Running since .*12:04/)).toBeTruthy();
    expect(puts).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Europe/Lisbon" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Times are shown in Europe\/Lisbon/)).toBeTruthy();
    expect(puts).toEqual([{ timeZone: "Europe/Lisbon" }]);
  });
});
