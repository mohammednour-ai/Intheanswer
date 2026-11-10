import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../env";
import { sha256 } from "../tokens";

/**
 * Record / replay for external reads (Places, site fetches, Claude).
 * - live: call through, no recording
 * - record: call through and save the response under FIXTURES_DIR
 * - replay: never call out; read the saved response or throw
 * Tests run in replay mode so they are deterministic and free.
 */
export class ReplayMissError extends Error {}

export async function withRecording<T>(namespace: string, key: unknown, live: () => Promise<T>): Promise<T> {
  const mode = env().EXTERNAL_MODE;
  const file = path.join(env().FIXTURES_DIR, namespace, `${sha256(JSON.stringify(key)).slice(0, 24)}.json`);
  if (mode === "replay") {
    try {
      const raw = await fs.readFile(file, "utf8");
      return (JSON.parse(raw) as { value: T }).value;
    } catch {
      throw new ReplayMissError(`no recorded fixture for ${namespace} ${JSON.stringify(key).slice(0, 200)}`);
    }
  }
  const value = await live();
  if (mode === "record") {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ key, recordedAt: new Date().toISOString(), value }, null, 1));
  }
  return value;
}
