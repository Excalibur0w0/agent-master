import type { TargetContext } from "./context.ts";

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
