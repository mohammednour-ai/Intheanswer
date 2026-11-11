// Side-effect imports: each module registers its job handlers.
import "../pipeline/discover";
import "../pipeline/contact";
import "../pipeline/test";
import "../pipeline/audit/run";
import "../pipeline/score";
import "../pipeline/teaserJobs";
import "../sitetest/run";
import "../reviews/jobs";
import "../pages/jobs";
import { register } from "./handlers";
import { DeferJob } from "./queue";

// Sending and regeneration arrive in phase 4. Until then an approved item
// waits in the queue (nothing is sent and nothing is lost).
for (const kind of ["send_message", "regenerate_message"]) {
  register(kind, async () => {
    throw new DeferJob(6 * 3600, "sending is not built yet (phase 4)");
  });
}
