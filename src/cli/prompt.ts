import { createInterface, type Interface } from "node:readline";

let rl: Interface | undefined;
const lines: string[] = [];
const waiting: ((line: string) => void)[] = [];
let ended = false;

/** One shared reader that queues lines, so answers piped in ahead of their questions aren't lost. */
function reader(): Interface {
  if (rl) return rl;
  rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => (waiting.length ? waiting.shift()?.(line) : lines.push(line)));
  rl.on("close", () => {
    ended = true;
    for (const w of waiting.splice(0)) w("");
  });
  return rl;
}

/** Ask on stderr (stdout stays clean for --json). An empty answer once input has ended. */
export async function ask(question: string): Promise<string> {
  reader();
  process.stderr.write(question);
  const line = lines.length ? lines.shift() : ended ? "" : await new Promise<string>((r) => waiting.push(r));
  if (!process.stdin.isTTY) process.stderr.write("\n");
  return (line ?? "").trim();
}

export async function confirm(question: string, byDefault = true): Promise<boolean> {
  const a = (await ask(`${question} ${byDefault ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return a ? a.startsWith("y") : byDefault;
}

export function closePrompts(): void {
  rl?.close();
  rl = undefined;
}
