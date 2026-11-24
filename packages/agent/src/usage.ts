/** Whether a command's arguments ask for its help: -h or --help, before any "--" (what follows goes to the agent). */
export function asksHelp(args: string[]): boolean {
  const end = args.indexOf("--");
  return args.slice(0, end < 0 ? args.length : end).some((arg) => arg === "-h" || arg === "--help");
}

/**
 * The part of a usage text about one command, given as the words typed (["am", "wait", "fix-login"]): the sections
 * of the longest run of them it documents, an argument such as the name being none of the command. Undefined when it
 * documents no more than the first `least` words.
 */
export function usageOf(usage: string, words: string[], least = 1): string | undefined {
  const lines = usage.split("\n");
  for (let n = words.length; n > least; n--) {
    const command = `${words.slice(0, n).join(" ")} `;
    let within = false;
    const own = lines.filter((line) => {
      // A command's own line is indented by two spaces and may name another ("am install | am uninstall"); the lines
      // indented further belong to it.
      if (/^ {2}\S/.test(line)) within = line.startsWith("  am ") && line.slice(2).split(/ \| (?=am )/).some((form) => `${form} `.startsWith(command));
      else if (!/^ {3}/.test(line)) within = false;
      return within;
    });
    if (own.length) return own.join("\n");
  }
  return undefined;
}
