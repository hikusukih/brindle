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
});
