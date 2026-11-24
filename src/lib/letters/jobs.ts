import { register } from "../jobs/handlers";
import { registerScheduled } from "../schedule/tick";
import { postLetter, prepareLetters } from "./letters";

/** Post a letter the owner approved. */
register("send_letter", async (ctx) => postLetter((ctx.job.payload as { letterId: string }).letterId, ctx));

/** Each business day from 08:00 Toronto: prepare the day's letters for the owner to approve. Does nothing while letters are off. */
registerScheduled({
  name: "prepare_letters",
  every: "day",
  atHour: 8,
  businessDaysOnly: true,
  pipeline: true,
  run: async ({ now }) => prepareLetters(now),
});
