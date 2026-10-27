import { createInterface, type Interface } from "node:readline";

let rl: Interface | undefined;
let input: NodeJS.ReadableStream = process.stdin;
const lines: string[] = [];
const waiting: ((line: string) => void)[] = [];
let ended = false;

/** Read answers from `stream` instead of stdin (tests). */
export function usePromptInput(stream: NodeJS.ReadableStream): void {
  closePrompts();
  input = stream;
  lines.length = 0;
  ended = false;
}

/** One shared reader that queues lines, so answers piped in ahead of their questions aren't lost. */
function reader(): Interface {
  if (rl) return rl;
  rl = createInterface({ input, terminal: false });
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

/** Yes only for a typed yes: Enter, or input that has ended, is No. */
export async function confirm(question: string): Promise<boolean> {
  return (await ask(`${question} [y/N] `)).toLowerCase().startsWith("y");
}

export function closePrompts(): void {
  rl?.close();
  rl = undefined;
}
