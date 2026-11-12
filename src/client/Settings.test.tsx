// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "./Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const list = {
  default: "openai:gpt-test",
  models: [
    { spec: "openai:gpt-test", provider: "openai", keyPresent: true },
    { spec: "anthropic:claude-test", provider: "anthropic", keyPresent: true },
    { spec: "openai:no-key", provider: "openai", keyPresent: false },
  ],
};

describe("Settings", () => {
  it("lists the configured models, marks a missing key, and saves a new default", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`.trim());
        return url === "/api/models" ? Response.json(list) : Response.json({ default: "anthropic:claude-test" });
      }),
    );
    render(<SettingsScreen />);
    const first = (await screen.findByLabelText("openai:gpt-test")) as HTMLInputElement;
    expect(first.checked).toBe(true);
    expect((screen.getByLabelText("openai:no-key") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("key missing")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("anthropic:claude-test"));
    await vi.waitFor(() =>
      expect((screen.getByLabelText("anthropic:claude-test") as HTMLInputElement).checked).toBe(true),
    );
    expect(calls).toContain('PUT /api/settings/default-model {"model":"anthropic:claude-test"}');
  });

  it("has no field for a key or an address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(list)),
    );
    render(<SettingsScreen />);
    await screen.findByLabelText("openai:gpt-test");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows each model's limits with the server's window, saves them in seconds and shows a refusal", async () => {
    const calls: string[] = [];
    const view = {
      spec: "openai:gpt-test",
      configured: { maxMillis: 60_000 },
      effective: {
        contextWindow: 32_000,
        maxSteps: 10,
        maxTokens: 100_000,
        maxMillis: 60_000,
        housekeepingMillis: 600_000,
        warmCache: true,
      },
      serverWindow: 8192,
      problem: null,
    };
    let refuse = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (url === "/api/models") return Response.json(list);
        if (url === "/api/settings/model-settings" && init?.method === "GET") return Response.json([view]);
        calls.push(init?.body ?? "");
        if (refuse)
          return Response.json(
            { message: "the configured contextWindow (9000) is larger than the server's (8192)." },
            { status: 400 },
          );
        return Response.json({ ...view, configured: { contextWindow: 4096, maxMillis: 90_000 } });
      }),
    );
    render(<SettingsScreen />);
    const window = (await screen.findByLabelText(/Context window/)) as HTMLInputElement;
    expect(screen.getByText("The server reports 8192.")).toBeTruthy();
    expect(window.placeholder).toBe("32000");
    expect((screen.getByLabelText(/Time limit per run/) as HTMLInputElement).value).toBe("60");

    fireEvent.change(window, { target: { value: "9000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/larger than the server's/);

    refuse = false;
    fireEvent.change(window, { target: { value: "4096" } });
    fireEvent.change(screen.getByLabelText(/Time limit per run/), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(JSON.parse(calls.at(-1) ?? "")).toEqual({
      model: "openai:gpt-test",
      settings: {
        contextWindow: 4096,
        maxSteps: null,
        maxTokens: null,
        maxMillis: 90_000,
        housekeepingMillis: null,
        warmCache: null,
      },
    });
  });
});
