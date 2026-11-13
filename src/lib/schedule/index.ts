/**
 * Built-in scheduled tasks. Imported once by src/lib/jobs/register.ts, which
 * also brings in the retest and report job handlers.
 */
import "../retests/jobs";
import { registerScheduled } from "./tick";
import { runRetention } from "./retention";
import { runAlertChecks } from "../alerts/checks";
import { sendDigest } from "../alerts/digest";

// Daily clean-up, in the quiet hours.
registerScheduled({
  name: "retention",
  every: "day",
  atHour: 3,
  run: async ({ now, job }) => {
    const r = await runRetention(now);
    await job.log("retention done", r);
    return r;
  },
});

// Weekly safety net: Places content is never stored (see purge_places_data).
registerScheduled({
  name: "purge_places",
  every: "week",
  run: async ({ period, job }) => {
    const r = await job.enqueue("purge_places_data", `purge_places:${period}`, {});
    return { job: r.id };
  },
});

// Owner alerts: dead jobs, auto-pause, spend cap, failing cities, items waiting too long.
registerScheduled({
  name: "owner_alerts",
  every: "hour",
  run: ({ now }) => runAlertChecks(now),
});

// The owner's digest, business days at digest_hour_local (Toronto).
registerScheduled({
  name: "owner_digest",
  every: "day",
  atHour: (s) => s.digest_hour_local,
  businessDaysOnly: true,
  run: ({ now }) => sendDigest(now),
});
