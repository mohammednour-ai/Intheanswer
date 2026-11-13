import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { resolveCode } from "@/lib/qr";

export const metadata: Metadata = { title: "Checkout", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function load(code: string, offerKey: string) {
  const hit = await resolveCode(code);
  const [offer] = await db()<{ key: string; name: string; price_cents: number; currency: string; billing: string }[]>`
    select key, name, price_cents, currency, billing from offers where key=${offerKey} and active`;
  if (!hit || !offer) return null;
  const [c] = await db()<{ name: string }[]>`select coalesce(site_name, name) as name from clinics where id=${hit.clinicId}`;
  return { hit, offer, clinic: c.name };
}

async function interest(code: string, offerKey: string) {
  "use server";
  const x = await load(code, offerKey);
  if (!x) return;
  await db()`insert into owner_tasks (kind, clinic_id, title, body)
             values ('escalation', ${x.hit.clinicId}, ${`Wants to buy: ${x.offer.name}`}, ${`${x.clinic} pressed the checkout button for ${x.offer.name} on its results page. Card checkout is not built yet (phase 5): send a payment link by hand.`})`;
  redirect(`/buy/${code}/${offerKey}?done=1`);
}

/** Checkout by card arrives with Stripe (phase 5). Until then the button records the request for the owner. */
export default async function Buy(props: PageProps<"/buy/[code]/[offer]">) {
  const { code, offer: offerKey } = await props.params;
  const sp = await props.searchParams;
  const x = await load(code, offerKey);
  if (!x) notFound();
  const price = `${(x.offer.price_cents / 100).toFixed(0)} ${x.offer.currency}${x.offer.billing === "monthly" ? " per month" : ", one time"}`;
  return (
    <section style={{ padding: "48px 0", maxWidth: 560 }}>
      <h1>{x.offer.name}</h1>
      <p>For {x.clinic}: {price}, plus HST.</p>
      {sp.done ? (
        <p role="status">Thank you. We will send a secure payment link to the clinic. Nothing has been charged.</p>
      ) : (
        <form action={interest.bind(null, code, offerKey)} className="stack">
          <p>Online card checkout is being set up. Press the button and we will send your clinic a secure payment link. Nothing is charged now.</p>
          <button className="btn btn-primary">Send me a payment link</button>
        </form>
      )}
    </section>
  );
}
