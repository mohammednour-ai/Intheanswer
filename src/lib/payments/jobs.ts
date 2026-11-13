import { register } from "../jobs/handlers";
import { PermanentJobError, type JobContext } from "../jobs/queue";
import { processEvent } from "./events";
// fulfilment: registers build_full_report
import "../reports/fullReportJobs";

/** Retry path for a webhook event that could not be processed inline. A processed event is a no-op. */
register("stripe_event", async (ctx: JobContext) => {
  const { eventId } = ctx.job.payload as { eventId?: string };
  if (!eventId) throw new PermanentJobError("no eventId");
  const status = await processEvent(eventId);
  if (status === "missing") throw new PermanentJobError(`stripe event ${eventId} is not stored`);
  return { status };
});
