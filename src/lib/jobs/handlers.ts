import type { Handler } from "./queue";

/**
 * Registry of job kinds. Each pipeline module registers its handler here.
 * Filled in as phases land.
 */
export const handlers: Record<string, Handler> = {};

export function register(kind: string, h: Handler) {
  handlers[kind] = h;
}
