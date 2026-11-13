import { markSvg } from "@/lib/brand";
import { ownerDetails } from "@/lib/env";

/** Plain frame for the checkout and intake pages: brand, content, who we are. */
export function Shell({ children }: { children: React.ReactNode }) {
  const o = ownerDetails();
  return (
    <main className="wrap" style={{ maxWidth: 720, paddingTop: 32, paddingBottom: 64 }}>
      <div className="row" style={{ gap: 10 }}>
        <span dangerouslySetInnerHTML={{ __html: markSvg({ width: 28 }) }} />
        <strong style={{ fontFamily: "var(--font-head)" }}>In The Answer</strong>
      </div>
      {children}
      <p className="small muted" style={{ marginTop: 32 }}>
        In The Answer · {o.businessName} · {o.mailingAddress} · <a href={`mailto:${o.email}`}>{o.email}</a>
      </p>
    </main>
  );
}
