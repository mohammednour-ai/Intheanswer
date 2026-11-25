import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { outreachResults } from "@/lib/portal/results";
import { makeClinic, makeMessage, resetData } from "./helpers";

const NOW = new Date("2026-11-25T17:00:00Z"); // Wednesday, noon in Toronto
const at = (iso: string) => new Date(iso);

describe("Results page numbers", () => {
  beforeEach(async () => {
    await resetData();
  });

  it("counts sends, replies, real report opens and real calls by day, week and month", async () => {
    const sql = db();
    const a = await makeClinic({ name: "A Dental", domain: "a.example", website: "https://a.example" });
    const b = await makeClinic({ name: "B Dental", domain: "b.example", website: "https://b.example" });
    const repA = (await sql<{ id: string }[]>`insert into reports (clinic_id, kind, token, data, html) values (${a}, 'teaser', 'tok-a', '{}', '') returning id`)[0].id;
    const repB = (await sql<{ id: string }[]>`insert into reports (clinic_id, kind, token, data, html) values (${b}, 'teaser', 'tok-b', '{}', '') returning id`)[0].id;
    await makeMessage({ clinic_id: a, status: "sent", to_email: "info@a.example", report_id: repA, sent_at: at("2026-11-23T15:00:00Z"), dry_run: false });
    await makeMessage({ clinic_id: b, status: "sent", to_email: "info@b.example", report_id: repB, sent_at: at("2026-11-24T15:00:00Z"), dry_run: false });
    await makeMessage({ clinic_id: b, status: "sent", to_email: "x@b.example", sent_at: at("2026-11-24T15:30:00Z"), dry_run: true }); // dry run: not counted

    // A: the mail system checks the link 5 seconds after sending (not counted), a person opens it an hour later and comes back the next day
    await sql`insert into report_views (report_id, viewed_at, is_owner) values
      (${repA}, ${at("2026-11-23T15:00:05Z")}, false), (${repA}, ${at("2026-11-23T16:00:00Z")}, false), (${repA}, ${at("2026-11-24T14:00:00Z")}, false)`;
    // B: only the link check, and the owner's own visit
    await sql`insert into report_views (report_id, viewed_at, is_owner) values (${repB}, ${at("2026-11-24T15:00:20Z")}, false), (${repB}, ${at("2026-11-24T18:00:00Z")}, true)`;

    await sql`insert into inbound_messages (provider_id, from_email, to_email, subject, body_text, received_at, clinic_id, classification) values
      ('in-1', 'info@b.example', 'hello@x', 'Re', 'remove us', ${at("2026-11-24T17:26:00Z")}, ${b}, 'unsubscribe'),
      ('in-2', 'info@a.example', 'hello@x', 'Re', 'out of office', ${at("2026-11-23T15:01:00Z")}, ${a}, 'auto_reply')`;

    await sql`update app_settings set call_relay_numbers = array['+16475550100']`;
    await sql`insert into calls (token, direction, status, clinic_id, phone, started_at, dry_run) values
      ('c1', 'inbound', 'completed', ${a}, '+16475550100', ${at("2026-11-24T19:00:00Z")}, false),
      ('c2', 'inbound', 'completed', ${a}, '+17055550111', ${at("2026-11-24T20:00:00Z")}, false)`;

    const day = await outreachResults("day", NOW);
    expect(day.firstEmails).toBe(2);
    expect(day.totals).toMatchObject({ emails: 2, replies: 1, negative: 1, positive: 0, viewers: 1, returning: 1, calls: 1 });
    const byDay = Object.fromEntries(day.rows.map((r) => [r.start, r]));
    expect(byDay["2026-11-23"]).toMatchObject({ emails: 1, viewers: 1, returning: 0, replies: 0 });
    expect(byDay["2026-11-24"]).toMatchObject({ emails: 1, viewers: 1, returning: 1, replies: 1, negative: 1, calls: 1 });
    expect(day.rows).toHaveLength(30);
    expect(day.rows[0].start).toBe("2026-11-25"); // newest first

    const week = await outreachResults("week", NOW);
    expect(week.rows[0]).toMatchObject({ start: "2026-11-23", emails: 2, viewers: 1, replies: 1 });
    const month = await outreachResults("month", NOW);
    expect(month.rows[0]).toMatchObject({ start: "2026-11-01", emails: 2 });
  });
});
