export const screens = [
  {
    id: "channels",
    label: "Channels",
    empty: {
      title: "No channels yet",
      body: "A channel is a named conversation with its own history. Start one to talk to your agent.",
    },
  },
  {
    id: "goals",
    label: "Goals",
    empty: {
      title: "No goals yet",
      body: "A goal is something you want kept up over time, with its own brief and schedule.",
    },
  },
  {
    id: "feed",
    label: "Feed",
    empty: { title: "Nothing in the feed", body: "Items from your scheduled goals will show up here for you to skim." },
  },
  {
    id: "artifacts",
    label: "Artifacts",
    empty: { title: "No artifacts yet", body: "Documents, pages and files your agent makes are collected here." },
  },
  {
    id: "settings",
    label: "Settings",
    // Settings has no empty state; the field keeps every screen the same shape.
    empty: { title: "Settings", body: "How your agent is set up." },
  },
] as const;

export type ScreenId = (typeof screens)[number]["id"];

export function screenFromHash(hash: string): ScreenId {
  const id = hash.replace(/^#\/?/, "").split("/")[0];
  return screens.find((s) => s.id === id)?.id ?? "channels";
}

/** `#/channels/<id>` opens one channel; any other hash shows the list. */
export function channelIdFromHash(hash: string): string | null {
  const [screen, id] = hash.replace(/^#\/?/, "").split("/");
  return screen === "channels" && id ? decodeURIComponent(id) : null;
}
