"use client";

import { useState, useTransition } from "react";
import { bulkApproveAction } from "./actions";

export function BulkApprove({ ids }: { ids: string[] }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  if (ids.length === 0) return null;
  return (
    <div className="row">
      <button
        className="btn"
        disabled={pending}
        onClick={() => {
          if (!confirm(`Approve and send ${ids.length} item(s) with zero flags?`)) return;
          start(async () => {
            const res = await bulkApproveAction(ids);
            setMsg(`${res.filter((r) => r.ok).length} approved`);
          });
        }}
      >
        Bulk approve {ids.length} with zero flags
      </button>
      {msg && <span className="small muted" role="status">{msg}</span>}
    </div>
  );
}
