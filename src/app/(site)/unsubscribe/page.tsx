import type { Metadata } from "next";
import { unsubscribeByEmail } from "../actions";

export const metadata: Metadata = {
  title: "Unsubscribe",
  description: "Stop all emails from In The Answer. No login needed; it takes effect at once.",
};

export default async function Unsubscribe(props: PageProps<"/unsubscribe">) {
  const sp = await props.searchParams;
  return (
    <div className="wrap">
      <section style={{ padding: "clamp(40px, 5vw, 72px) 0", maxWidth: 560 }}>
      <h1>Unsubscribe</h1>
      {sp.done ? (
        <p role="status">Done. If that address was on our list, it will not receive any more emails from In The Answer.</p>
      ) : (
        <form action={unsubscribeByEmail} className="stack">
          <p>Enter the address that received our email. It takes effect at once, and no login is needed.</p>
          <div>
            <label htmlFor="email">Email address</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <button className="btn btn-primary">Unsubscribe</button>
        </form>
      )}
    </section>
    </div>
  );
}
