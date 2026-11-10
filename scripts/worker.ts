/**
 * Local worker loop: `npm run worker` (Ctrl+C to stop). In production the
 * /api/cron/worker route does the same work on a schedule.
 * Flags: --once (single pass), --kinds a,b
 */
import "../src/lib/jobs/register";
import { runWorkerOnce } from "../src/lib/jobs/worker";
import { closeDb } from "../src/lib/db";

const args = process.argv.slice(2);
const once = args.includes("--once");
const kindsArg = args.find((a) => a.startsWith("--kinds="));
const kinds = kindsArg ? kindsArg.split("=")[1].split(",") : undefined;

async function main() {
  for (;;) {
    const r = await runWorkerOnce({ limit: 10, kinds });
    if (r.claimed) console.log(new Date().toISOString(), r);
    if (once && r.claimed === 0) break;
    if (!once) await new Promise((res) => setTimeout(res, r.claimed ? 200 : 5000));
  }
  await closeDb();
}
main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
