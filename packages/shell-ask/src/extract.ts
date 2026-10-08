export type Extracted =
  | { ok: true; command: string }
  | { ok: false; reason: "empty" | "multiline"; text: string };

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

/**
 * Turns model output into one line that is safe to type into a terminal.
 * Control characters are removed so the text can never press Enter or send
 * escape sequences on its own.
 */
export function extractCommand(raw: string): Extracted {
  const lines = raw
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim())
    .filter((line) => line !== "" && !line.startsWith("```"))
    .map((line) => line.replace(/^\$\s+/, ""));

  if (lines.length === 0) return { ok: false, reason: "empty", text: raw };
  if (lines.length > 1) return { ok: false, reason: "multiline", text: lines.join("\n") };
  return { ok: true, command: lines[0] };
}
