import { db } from "../db";
import type { Sql } from "../db";

/**
 * Per-message-type REVIEW / AUTO switches.
 *
 * - The mode is read when a message is CREATED and stored on the message
 *   (mode_at_creation, requires_review). Changing a mode never touches items
 *   already in the queue.
 * - When a type is switched to AUTO, the first `review_first_n` messages of
 *   that type created afterwards still go to review; after that it runs alone.
 * - Payment receipts and unsubscribe confirmations are always automatic.
 * - The verification gate runs in both modes; a flagged item is held either way.
 */

export const ALWAYS_AUTO = new Set(["payment_receipt", "unsubscribe_confirmation", "owner_digest", "owner_alert"]);

/** Types that are governed by another type's switch. */
const MODE_ALIAS: Record<string, string> = {
  retest_upgrade: "monthly_report",
  final_files: "full_report_delivery",
  self_serve_teaser: "first_email",
};

export async function setTypeMode(type: string, mode: "REVIEW" | "AUTO", reviewFirstN: number) {
  const sql = db();
  const [cur] = await sql<{ mode: string }[]>`select mode::text from message_type_modes where type = ${type}`;
  if (!cur) throw new Error(`unknown message type ${type}`);
  if (mode === "AUTO" && cur.mode !== "AUTO") {
    await sql`update message_type_modes set mode='AUTO', review_first_n=${reviewFirstN}, auto_since=now(),
              auto_created_count=0, updated_at=now() where type=${type}`;
  } else if (mode === "REVIEW") {
    await sql`update message_type_modes set mode='REVIEW', auto_since=null, updated_at=now() where type=${type}`;
  } else {
    await sql`update message_type_modes set review_first_n=${reviewFirstN}, updated_at=now() where type=${type}`;
  }
}

export interface ReviewDecision {
  mode: "REVIEW" | "AUTO";
  requiresReview: boolean;
  reason: string | null;
}

/**
 * Decide, at creation time, whether a new message needs owner review.
 * Must be called inside the transaction that inserts the message so the
 * "first N" counter is consumed atomically.
 */
export async function decideReview(tx: Sql, type: string): Promise<ReviewDecision> {
  if (ALWAYS_AUTO.has(type)) return { mode: "AUTO", requiresReview: false, reason: null };
  const key = MODE_ALIAS[type] ?? type;
  const [m] = await tx<{ mode: "REVIEW" | "AUTO"; review_first_n: number; auto_created_count: number }[]>`
    select mode, review_first_n, auto_created_count from message_type_modes where type = ${key} for update`;
  if (!m) return { mode: "REVIEW", requiresReview: true, reason: "unknown type: review by default" };
  if (m.mode === "REVIEW") return { mode: "REVIEW", requiresReview: true, reason: "REVIEW mode" };
  await tx`update message_type_modes set auto_created_count = auto_created_count + 1 where type = ${key}`;
  if (m.auto_created_count < m.review_first_n) {
    return {
      mode: "AUTO",
      requiresReview: true,
      reason: `AUTO, but item ${m.auto_created_count + 1} of the first ${m.review_first_n} still reviewed`,
    };
  }
  return { mode: "AUTO", requiresReview: false, reason: null };
}
