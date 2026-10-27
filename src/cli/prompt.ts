import { createInterface, type Interface } from "node:readline/promises";

let rl: Interface | undefined;

/** Ask on stderr (stdout stays clean for --json). One shared interface, so piped answers aren't lost. */
export async function ask(question: string): Promise<string> {
  rl ??= createInterface({ input: process.stdin, output: process.stderr });
  return (await rl.question(question)).trim();
}

export async function confirm(question: string, byDefault = true): Promise<boolean> {
  const a = (await ask(`${question} ${byDefault ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return a ? a.startsWith("y") : byDefault;
}

export function closePrompts(): void {
  rl?.close();
  rl = undefined;
}
