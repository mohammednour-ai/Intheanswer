// SYNTHETIC test fixtures (invented clinic). Not real data.
import { parsePage } from "@/lib/site/parse";
import type { SiteRead } from "@/lib/site/crawl";

export const HOME = `<!doctype html><html><head><title>Maple Grove Dental | Barrie</title>
<meta name="description" content="Maple Grove Dental is a family dental clinic in Barrie, Ontario accepting new patients. Direct billing available.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Dentist","name":"Maple Grove Dental","telephone":"705-555-0100"}</script>
<style>.x{color:red}</style></head><body>
<header><nav><a href="/contact/">Contact us</a> <a href="/team">Our team</a> <a href="/fees">Fees</a> <a href="/blog/post-1">Blog</a> <a href="https://facebook.com/x">FB</a></nav></header>
<h1>Maple Grove Dental</h1>
<p>We are accepting new patients. Call 705-555-0100.</p>
<p>Hours: Monday to Friday 9:00 am to 5:00 pm</p>
<footer><address>12 Maple Street, Barrie, ON L4M 1A1</address> <a href="mailto:info@maplegrove.example">Email us</a></footer>
</body></html>`;

export const CONTACT = `<html><body><h1>Contact</h1><p>Reach the front desk at hello@maplegrove.example or office.manager@gmail.com.</p>
<p>Hours: Monday to Friday 8:00 am to 4:00 pm</p><img src="logo@2x.png"></body></html>`;

export const TEAM = `<html><body><h2>Our team</h2><p>Dr. Ana Patel, DDS, has practised since 2010.</p><p>We speak English, Punjabi and French.</p></body></html>`;

export const FEES = `<html><body><p>New patient exam and cleaning: $180. Children under 5: $60.</p>
<p>Notice: masks are required in the clinic during the COVID-19 pandemic.</p></body></html>`;

export function siteFrom(pages: Record<string, string>): SiteRead {
  const parsed = Object.entries(pages).map(([u, h]) => parsePage(u, h));
  return { website: parsed[0].url, domain: "maplegrove.example", home: parsed[0], pages: parsed, failures: [], readable: parsed[0].text.length >= 50 };
}

export const SITE = () =>
  siteFrom({
    "https://maplegrove.example/": HOME,
    "https://maplegrove.example/contact/": CONTACT,
    "https://maplegrove.example/team": TEAM,
    "https://maplegrove.example/fees": FEES,
  });
