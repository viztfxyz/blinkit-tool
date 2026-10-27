import { createInterface, type Interface } from "node:readline";

let rl: Interface | undefined;
let lines: AsyncIterator<string> | undefined;

/**
 * Ask on stderr (stdout stays clean for --json). The line iterator buffers, so answers piped in ahead of
 * their questions aren't lost. An empty answer once input has ended.
 */
export async function ask(question: string): Promise<string> {
  process.stderr.write(question);
  if (!rl) {
    rl = createInterface({ input: process.stdin, terminal: false });
    lines = rl[Symbol.asyncIterator]();
  }
  const r = await lines?.next();
  return r && !r.done ? r.value.trim() : "";
}

/** Yes only for a typed yes: Enter, or input that has ended, is No. */
export async function confirm(question: string): Promise<boolean> {
  return (await ask(`${question} [y/N] `)).toLowerCase().startsWith("y");
}

export function closePrompts(): void {
  rl?.close();
  rl = lines = undefined;
}
