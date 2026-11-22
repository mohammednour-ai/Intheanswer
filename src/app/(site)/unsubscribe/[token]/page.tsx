import type { Metadata } from "next";
import Link from "next/link";
import { verifyUnsubscribeToken } from "@/lib/tokens";
import { unsubscribeByToken } from "../../actions";
import site from "../../site.module.css";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false, follow: false } };

export default async function UnsubscribeToken(props: PageProps<"/unsubscribe/[token]">) {
  const { token } = await props.params;
  const sp = await props.searchParams;
  const email = verifyUnsubscribeToken(token);
  return (
    <div className={site.container}>
      <section className={`${site.prose} ${site.proseNarrow}`}>
        <h1>Unsubscribe</h1>
        {!email ? (
          <p>This link is not valid. You can unsubscribe with your email address on the <Link href="/unsubscribe">unsubscribe page</Link>.</p>
        ) : sp.done ? (
          <p role="status"><strong>{email}</strong> is unsubscribed. You will not receive any more emails from In The Answer.</p>
        ) : (
          // A button, not an automatic action: mail scanners open links, and must not unsubscribe people by accident.
          <form action={unsubscribeByToken.bind(null, token)} className={site.form}>
            <p>Stop all emails from In The Answer to <strong>{email}</strong>?</p>
            <button className={`${site.btnPrimary} ${site.go}`}>Unsubscribe</button>
          </form>
        )}
      </section>
    </div>
  );
}
