// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactsScreen } from "./Artifacts";
import type { Artifact } from "./api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const empty = { title: "No artifacts yet", body: "Made things are collected here." };
const art = (over: Partial<Artifact>): Artifact => ({
  id: "a",
  title: "Plan",
  kind: "document",
  scope: "channel",
  scopeId: "c1",
  scopeName: "Trip",
  runId: "0123456789",
  mime: "text/markdown",
  size: 1,
  createdAt: "2026-01-02T03:04:05.000Z",
  scopeLive: true,
  ...over,
});

describe("ArtifactsScreen", () => {
  it("shows the empty state until the first artifact exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([])),
    );
    render(<ArtifactsScreen empty={empty} />);
    expect(await screen.findByText("No artifacts yet")).toBeTruthy();
  });

  it("links an artifact to its channel, or says the channel is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([art({}), art({ id: "b", title: "Old", scopeLive: false, scopeName: "Lost" })])),
    );
    render(<ArtifactsScreen empty={empty} />);
    expect(await screen.findByRole("link", { name: "Trip" })).toHaveProperty("hash", "#/channels/c1");
    expect(screen.getByText(/from deleted channel Lost/)).toBeTruthy();
  });

  it("asks the server for the chosen kind and scope", async () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    render(<ArtifactsScreen empty={empty} />);
    fireEvent.change(await screen.findByLabelText("Kind"), { target: { value: "code" } });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "goal" } });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith("/api/artifacts?kind=code&scope=goal", expect.anything()),
    );
    expect(await screen.findByText("No artifacts match.")).toBeTruthy();
  });
});
