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

  it("opens a document as text with the token in the header, and never as markup", async () => {
    window.sessionStorage.setItem("brindle-token", "tok");
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("/api/artifacts/")
        ? new Response("<h1>Hi</h1><script>alert(1)</script>", { headers: { "content-type": "text/plain" } })
        : Response.json([art({})]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<ArtifactsScreen empty={empty} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByText("<h1>Hi</h1><script>alert(1)</script>")).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect([...container.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Artifacts"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/artifacts/a/file", { headers: { authorization: "Bearer tok" } });
    window.sessionStorage.clear();
  });

  it("offers an HTML page as a download and never puts its markup in the page", async () => {
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("/api/artifacts/")
        ? new Response("<h1>Planted</h1><script>alert(1)</script>", { headers: { "content-type": "text/html" } })
        : Response.json([art({ kind: "page", title: "Site", mime: "text/html" })]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<ArtifactsScreen empty={empty} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    const link = (await screen.findByRole("link", { name: "Download Site" })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("blob:test");
    expect(link.getAttribute("download")).toBe("Site");
    expect(container.querySelector("script, iframe")).toBeNull();
    expect([...container.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Artifacts"]);
    expect(container.textContent).not.toContain("Planted");
    const made = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Blob;
    expect(made.type).toBe("application/octet-stream");
  });

  it("says so when the file cannot be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/artifacts/")
          ? Response.json({ message: "No such artifact." }, { status: 404 })
          : Response.json([art({})]),
      ),
    );
    render(<ArtifactsScreen empty={empty} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No such artifact.");
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
