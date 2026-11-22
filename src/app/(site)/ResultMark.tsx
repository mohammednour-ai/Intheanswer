import type { RowStatus } from "@/lib/reports/types";
import site from "./site.module.css";

/** The answer mark, drawn for one result: the middle line filled, outlined or dashed. */
export function ResultMark({ status, width = 26 }: { status: RowStatus; width?: number }) {
  return (
    <svg width={width} height={Math.round((width * 104) / 120)} viewBox="0 0 120 104" aria-hidden="true">
      <rect className={site.markGrey} x="8" y="8" width="84" height="20" rx="10" />
      {status === "recommended" ? (
        <rect className={site.markBlue} x="8" y="42" width="104" height="20" rx="10" />
      ) : status === "listed_only" ? (
        <rect className={site.markListed} x="11" y="45" width="98" height="14" rx="7" strokeWidth="6" />
      ) : (
        <rect className={site.markNone} x="11" y="45" width="98" height="14" rx="7" strokeWidth="5" strokeDasharray="9 9" />
      )}
      <rect className={site.markGrey} x="8" y="76" width="64" height="20" rx="10" />
    </svg>
  );
}
