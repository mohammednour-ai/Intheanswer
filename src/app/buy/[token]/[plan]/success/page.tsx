import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { ownerDetails } from "@/lib/env";
import { isPlan, resolveBuyToken } from "@/lib/payments/checkout";
import { Shell } from "../../../Shell";

export const metadata: Metadata = { title: "Thank you", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function BuySuccess(props: PageProps<"/buy/[token]/[plan]/success">) {
  const { token, plan } = await props.params;
  const sp = await props.searchParams;
  if (!isPlan(plan)) notFound();
  const target = await resolveBuyToken(token);
  if (!target) notFound();
  // Stripe sends the buyer here; the payment itself is confirmed by the webhook, not by this page.
  const sessionId = typeof sp.session_id === "string" && /^[A-Za-z0-9_]{10,200}$/.test(sp.session_id) ? sp.session_id : null;
  const [order] = sessionId
    ? await db()<{ status: string }[]>`select status from orders where stripe_checkout_session_id = ${sessionId} and clinic_id = ${target.clinicId}`
    : [];
  const paid = order?.status === "paid";
  const o = ownerDetails();
  return (
    <Shell>
      <h1 style={{ marginTop: 24 }}>Thank you</h1>
      <p className={paid ? "pill pill-ok" : "pill pill-blue"} role="status">
        {paid ? "Payment received." : "Your payment is being confirmed. This can take a minute."}
      </p>
      <p>A receipt is sent to the email address you gave at payment.</p>
      {plan === "reports" ? (
        <p>A second email follows with the first full report for {target.clinicName}. It is checked before it is sent, and a new report follows each month.</p>
      ) : plan === "monthly" ? (
        <p>A second email follows with the full report for {target.clinicName} and a short form about your website. The report is checked before it is sent.</p>
      ) : (
        <p>The full report for {target.clinicName} follows by email. It is checked before it is sent.</p>
      )}
      <p>Questions: <a href={`mailto:${o.email}`}>{o.email}</a></p>
    </Shell>
  );
}
