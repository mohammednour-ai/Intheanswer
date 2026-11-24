import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ownerDetails } from "@/lib/env";
import { LETTER_CODE_RE } from "@/lib/letters/content";
import { letterForStop } from "@/lib/letters/letters";
import { stopClinic } from "@/lib/calls/rules";
import { db } from "@/lib/db";
import { Shell } from "../../../buy/Shell";
import site from "../../../(site)/site.module.css";
import s from "../../../buy/buy.module.css";

export const metadata: Metadata = { title: "Stop letters, emails and calls", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Printed on every letter: intheanswer.ca/l/<code>/stop. Opening the page changes nothing (a link
 * checker may open it); pressing the button stops all contact with the clinic.
 */
async function stop(code: string) {
  "use server";
  const l = await letterForStop(code);
  if (!l) notFound();
  if (!l.stopped) {
    await stopClinic(l.clinicId, "asked on the stop page of our letter not to be contacted", "letter");
    await db()`update letters set stopped_at = now(), updated_at = now() where id = ${l.id} and stopped_at is null`;
  }
  redirect(`/l/${code}/stop?done=1`);
}

export default async function StopPage(props: PageProps<"/l/[code]/stop">) {
  const code = (await props.params).code.toLowerCase();
  if (!LETTER_CODE_RE.test(code)) notFound();
  const l = await letterForStop(code);
  if (!l) notFound();
  const sp = await props.searchParams;
  const o = ownerDetails();
  const done = l.stopped || sp.done === "1";

  return (
    <Shell>
      <div className={s.intro}>
        <h1>Stop letters, emails and calls</h1>
        <p className={s.for}>For {l.clinicName}</p>
      </div>
      {done ? (
        <p className={`${s.notice} ${s.noticeOk}`} role="status">
          Done. We will not write to, email or phone {l.clinicName} again. If anything already in the post arrives, please ignore it.
        </p>
      ) : (
        <form action={stop.bind(null, code)} className={s.panel}>
          <p>Press the button and we stop all contact with {l.clinicName}: no more letters, emails or calls from {o.businessName}.</p>
          <button className={`${site.btnPrimary} ${site.go}`}>Stop all contact</button>
        </form>
      )}
      <p className={s.fine}>
        Questions? Write to <a href={`mailto:${o.email}`}>{o.email}</a> or call {o.phone}.
      </p>
    </Shell>
  );
}
