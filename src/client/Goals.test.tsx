// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalsScreen, hueOf, initials } from "./Goals";

const empty = { title: "No goals yet", body: "A goal is something you want kept up over time." };
const stamp = "2026-01-02T03:04:05.000Z";

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("tile icons", () => {
  it("are deterministic: the same title gives the same letters and hue", () => {
    expect(initials("Learn Rust")).toBe("LR");
    expect(initials("rust")).toBe("RU");
    expect(initials("  ")).toBe("?");
    expect(hueOf("Learn Rust")).toBe(hueOf("Learn Rust"));
    expect(hueOf("Learn Rust")).not.toBe(hueOf("Morning brief"));
  });
});

describe("Goals screen", () => {
  it("with no goals is the text box and the empty note", async () => {
    stubFetch({ "/api/goals": () => Response.json([]) });
    render(<GoalsScreen empty={empty} />);
    expect(await screen.findByText("No goals yet")).toBeTruthy();
    expect(screen.getByLabelText("Describe a goal")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Your goals" })).toBeNull();
  });

  it("shows tiles that open the goal's channel, with the next run or that it is not scheduled", async () => {
    stubFetch({
      "/api/goals": () =>
        Response.json([
          { id: "g1", title: "Learn Rust", channelId: "c1", brief: { text: "A chapter a week." }, nextRunAt: stamp },
          { id: "g2", title: "Garden", channelId: "c2", brief: { text: "Water things." }, nextRunAt: null },
        ]),
    });
    render(<GoalsScreen empty={empty} />);
    const rust = await screen.findByRole("link", { name: /Learn Rust/ });
    expect(rust.getAttribute("href")).toBe("#/channels/c1");
    expect(rust.textContent).toContain("A chapter a week.");
    expect(rust.textContent).toContain("Next:");
    expect(screen.getByRole("link", { name: /Garden/ }).textContent).toContain("Not scheduled");
  });

  it("drafts into an editable form and creates nothing until Create goal is pressed", async () => {
    let goals: unknown[] = [];
    const calls = stubFetch({
      "/api/goals": (method, body) => {
        if (method === "POST") {
          goals = [{ id: "g1", title: "Learn Rust", channelId: "c1", brief: { text: "Weekly." }, nextRunAt: null }];
          expect(body).toEqual({
            title: "Learn Rust",
            brief: "Weekly, with exercises.",
            schedule: { cron: "0 9 * * 1", prompt: "Next chapter." },
          });
          return Response.json({}, { status: 201 });
        }
        return Response.json(goals);
      },
      "/api/goals/options": () => Response.json({ schedulesAvailable: true }),
      "/api/goals/draft": (_m, body) => {
        expect(body).toEqual({ text: "Rust, Mondays at 9" });
        return Response.json({
          title: "Learn Rust",
          brief: "Weekly.",
          schedule: { cron: "0 9 * * 1", prompt: "Next chapter." },
        });
      },
    });
    render(<GoalsScreen empty={empty} />);
    fireEvent.change(await screen.findByLabelText("Describe a goal"), { target: { value: "Rust, Mondays at 9" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByLabelText("Title")).toHaveProperty("value", "Learn Rust");
    expect(calls).not.toContain("POST /api/goals");
    fireEvent.change(screen.getByLabelText("Brief"), { target: { value: "Weekly, with exercises." } });
    fireEvent.click(screen.getByRole("button", { name: "Create goal" }));
    expect(await screen.findByRole("link", { name: /Learn Rust/ })).toBeTruthy();
    expect(calls).toContain("POST /api/goals");
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("shows why a draft failed and lets the user write the goal by hand", async () => {
    stubFetch({
      "/api/goals": () => Response.json([]),
      "/api/goals/draft": () => Response.json({ message: "No model is configured to draft with." }, { status: 503 }),
    });
    render(<GoalsScreen empty={empty} />);
    fireEvent.change(await screen.findByLabelText("Describe a goal"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toContain("No model is configured");
    fireEvent.click(screen.getByRole("button", { name: "Write it myself" }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toBeTruthy());
  });

  it("hides the schedule fields when the server has no scheduler", async () => {
    stubFetch({
      "/api/goals": () => Response.json([]),
      "/api/goals/options": () => Response.json({ schedulesAvailable: false }),
      "/api/goals/draft": () =>
        Response.json({ title: "Learn Rust", brief: "Weekly.", schedule: { cron: "0 9 * * 1", prompt: "x" } }),
    });
    render(<GoalsScreen empty={empty} />);
    fireEvent.change(await screen.findByLabelText("Describe a goal"), { target: { value: "Rust" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByLabelText("Title");
    expect(screen.queryByLabelText(/Schedule/)).toBeNull();
  });
});
