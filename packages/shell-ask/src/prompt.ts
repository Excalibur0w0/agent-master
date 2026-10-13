import type { TargetContext } from "./context.ts";

export const SYSTEM_PROMPT = `You convert the user's request into exactly ONE line of shell. The line is typed into the terminal described in <target>, where the user reviews it before pressing Enter.

Output rules:
- Output only the command line: no markdown, no code fences, no explanation, no leading "$" or prompt.
- Exactly one line. Chain steps with &&, ; or pipes, and use one-line loop forms (for f in ...; do ...; done).
- Write for the target's OS, userland (GNU vs BSD flags) and shell. Do not rely on tools that are unlikely to be installed there unless the request names them.
- The line is typed into a shell that is already running on the target, even when the target is a remote host. Never wrap it in ssh or otherwise connect to the target.
- Prefer read-only or safe forms. Do not add sudo unless the request needs root.
- If the request is ambiguous or cannot be done in one line, output a single shell comment starting with "# " that says what is missing.
- Any comment you write uses the same language as the request.`;

export function buildPrompt(target: TargetContext, request: string): string {
  const location =
    target.location === "ssh"
      ? `a shell already logged in to remote host "${target.host}"; the command runs there directly`
      : "a shell on the user's local machine";
  const lines = [
    "<target>",
    `location: ${location}`,
    `os: ${target.os}`,
    `shell: ${target.shell}`,
    `cwd: ${target.cwd ?? "unknown"}`,
  ];
  if (target.notes) lines.push(`notes: ${target.notes}`);
  lines.push("</target>", "<request>", request.trim(), "</request>");
  return lines.join("\n");
}
