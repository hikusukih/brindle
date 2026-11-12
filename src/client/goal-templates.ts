/**
 * The category buttons on the Goals screen. Each is a prompt template: its text goes to the same drafting call as the
 * user's own words, so a button only ever fills the edit form, and nothing is created until the user confirms it.
 */
export type GoalCategory = { id: string; label: string; template: string };

const ask = (subject: string, detail: string) =>
  `I want a goal about ${subject}: something I can keep up over time. ${detail} Make it specific and small enough to start this week, say what doing it well looks like, and leave out a schedule unless one is obvious.`;

export const goalCategories: GoalCategory[] = [
  {
    id: "interests",
    label: "Interests",
    template: ask(
      "my interests",
      "Pick something I enjoy or want to get better at, such as a hobby, a craft, reading or music.",
    ),
  },
  {
    id: "relationships",
    label: "Relationships",
    template: ask(
      "my relationships",
      "Think of staying in touch with friends and family, remembering dates and making time for people.",
    ),
  },
  {
    id: "health",
    label: "Health",
    template: ask("my health", "Think of sleep, movement, food, checkups and anything else that keeps me well."),
  },
  {
    id: "finance",
    label: "Finance",
    template: ask(
      "my money",
      "Think of tracking spending, saving, bills and the dates that matter, without moving any money.",
    ),
  },
  {
    id: "career",
    label: "Career",
    template: ask("my work and career", "Think of skills to build, people to meet, and progress to record for later."),
  },
  {
    id: "learning",
    label: "Learning",
    template: ask(
      "learning something new",
      "Think of a subject or skill, with a steady way to practice and a way to tell I am improving.",
    ),
  },
  {
    id: "home",
    label: "Home",
    template: ask("my home and belongings", "Think of upkeep, projects, planning and the chores that pile up."),
  },
];
