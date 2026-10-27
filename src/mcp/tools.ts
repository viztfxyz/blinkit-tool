import { HandcartError } from "../core/errors.js";

export const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

/** Wrap a handler so HandcartErrors come back as tool errors the agent can read. */
export const tool =
  <A>(fn: (args: A) => unknown) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      const text = e instanceof HandcartError ? e.message : `unexpected error: ${(e as Error).message}`;
      return { content: [{ type: "text" as const, text }], isError: true };
    }
  };
