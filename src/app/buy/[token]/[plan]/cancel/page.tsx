import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ownerDetails } from "@/lib/env";
import { isPlan, resolveBuyToken } from "@/lib/payments/checkout";
import { Shell } from "../../../Shell";
import site from "../../../../(site)/site.module.css";
import s from "../../../buy.module.css";

export const metadata: Metadata = { title: "Payment not completed", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function BuyCancel(props: PageProps<"/buy/[token]/[plan]/cancel">) {
  const { token, plan } = await props.params;
  if (!isPlan(plan)) notFound();
  if (!(await resolveBuyToken(token))) notFound();
  const o = ownerDetails();
  return (
    <Shell>
      <h1>Payment not completed</h1>
      <p>You left the payment page. Nothing was charged.</p>
      <div className={s.actions}>
        <Link className={site.btnPrimary} href={`/buy/${token}/${plan}`}>Try again</Link>
        <Link className={site.btnOutline} href={`/r/${token}`}>Back to your report</Link>
      </div>
      <p>Questions: <a href={`mailto:${o.email}`}>{o.email}</a></p>
    </Shell>
  );
}
