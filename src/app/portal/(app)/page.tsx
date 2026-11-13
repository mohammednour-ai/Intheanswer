import { requireOwner } from "@/lib/auth";
import { listMessages } from "@/lib/portal/queries";
import { MessageList } from "./MessageList";
import { BulkApprove } from "./BulkApprove";

export default async function QueuePage() {
  await requireOwner();
  const items = await listMessages(["pending_review"]);
  const zeroFlag = items.filter((m) => !Array.isArray(m.flags) || m.flags.length === 0).map((m) => m.id);
  return (
    <section>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Queue</h1>
        <BulkApprove ids={zeroFlag} />
      </div>
      <p className="muted">
        Messages waiting for your approval. Nothing here sends by itself. Items expire after 7 days and the clinic
        is re-audited before it is queued again. The list is in send order: highest priority first, and you can
        reorder it by hand.
      </p>
      <MessageList items={items} empty="Nothing is waiting." reorderable />
    </section>
  );
}
