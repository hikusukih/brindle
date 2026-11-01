/** The most a single tool result may cost the model, whatever a tool asks for. */
export const globalMaxResultTokens = 8_000;
export const defaultMaxResultTokens = 4_000;

// Tokens are estimated as characters over four; an exact tokenizer isn't worth a dependency.
const charsPerToken = 4;

/** The one place a token count is guessed; assembly and sizing must agree. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / charsPerToken);
}

export type SizedResult = { text: string; truncated: boolean };

/**
 * Cuts a result to fit the model's budget, keeping the head and a short tail because errors and
 * summaries tend to sit at the end, and says plainly how much was dropped. The caller keeps the full
 * text for the UI; only the model's copy is cut.
 */
export function sizeResult(full: string, toolMaxTokens = defaultMaxResultTokens): SizedResult {
  const maxChars = Math.min(toolMaxTokens, globalMaxResultTokens) * charsPerToken;
  if (full.length <= maxChars) return { text: full, truncated: false };
  const tail = Math.floor(maxChars * 0.15);
  const head = maxChars - tail;
  const dropped = full.length - head - tail;
  const marker = `\n\n[${dropped} of ${full.length} characters omitted to fit the context budget]\n\n`;
  return { text: full.slice(0, head) + marker + full.slice(full.length - tail), truncated: true };
}
