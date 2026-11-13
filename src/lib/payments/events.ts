import { db } from "../db";
import { env, ownerDetails } from "../env";
import { enqueue } from "../jobs/queue";
import { queueMessage, queueOwnerMail, signature } from "../sending/outbox";
import { randomToken } from "../tokens";
import { formatLongDate } from "../time";
import { LIVE_SUBSCRIPTION } from "./checkout";
import { isSubscriptionPlan, minTermMonths, minTermText, stripeClient, PLAN_NAMES, type Plan, type StripeEventLike, type StripeLike } from "./stripe";

/**
 * Stripe webhook events. Every event is stored once (its id is the key) and
 * processed once. Each handler is also safe to run again: state changes are
 * guarded by the current status and every message or job has its own key.
 */

type Obj = Record<string, unknown>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
/** Stripe fields that hold either an id or the expanded object. */
const ref = (v: unknown): string | null => str(v) ?? str(obj(v).id);
const ts = (v: unknown): Date | null => (num(v) == null ? null : new Date(num(v)! * 1000));
const money = (cents: number | null, currency: string | null) =>
  cents == null ? "unknown amount" : `${(cents / 100).toFixed(2)} ${(currency ?? "cad").toUpperCase()}`;

/** Message types of the cold sequence, stopped the moment a clinic pays. */
const COLD_TYPES = ["first_email", "follow_up"];
const UNSENT = ["draft", "pending_review", "held", "approved", "scheduled"];

export const deliveryKey = (orderId: string) => `delivery:${orderId}`;
export const intakeUrl = (token: string) => `${env().APP_URL}/intake/${token}`;

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

export interface WebhookResponse {
  status: number;
  body: string;
}

/** Verify the signature on the raw body, store the event, queue it and try to process it now. */
export async function receiveWebhook(rawBody: string, signatureHeader: string | null, deps: { stripe?: StripeLike } = {}): Promise<WebhookResponse> {
  const secret = env().STRIPE_WEBHOOK_SECRET;
  const stripe = deps.stripe ?? stripeClient();
  if (!secret || !stripe) return { status: 503, body: "Stripe is not configured" };
  if (!signatureHeader) return { status: 400, body: "Missing signature" };
  let event: StripeEventLike;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
  } catch {
    return { status: 400, body: "Invalid signature" };
  }
  if (!event?.id || !event.type) return { status: 400, body: "Not an event" };
  await recordEvent(event);
  // The job is the retry path; processing inline just makes the common case immediate.
  await enqueue("stripe_event", `stripe:${event.id}`, { eventId: event.id }, { priority: 10 });
  try {
    await processEvent(event.id);
  } catch {
    // recorded on the event row; the job retries with backoff
  }
  return { status: 200, body: "ok" };
}

export async function recordEvent(event: StripeEventLike): Promise<boolean> {
  const sql = db();
  const rows = await sql`
    insert into stripe_events (id, type, payload) values (${event.id}, ${event.type}, ${sql.json(event as never)})
    on conflict (id) do nothing returning id`;
  return rows.length > 0;
}

/**
 * Process a stored event exactly once. The row is locked for the duration, so
 * the webhook request and the job cannot both run it.
 */
export async function processEvent(eventId: string): Promise<"processed" | "already" | "missing"> {
  const sql = db();
  try {
    return await sql.begin(async (tx) => {
      const [ev] = await tx<{ payload: StripeEventLike; processed_at: Date | null }[]>`
        select payload, processed_at from stripe_events where id = ${eventId} for update`;
      if (!ev) return "missing";
      if (ev.processed_at) return "already";
      await handleEvent(ev.payload);
      await tx`update stripe_events set processed_at = now(), error = null where id = ${eventId}`;
      return "processed";
    });
  } catch (e) {
    await sql`update stripe_events set error = ${(e as Error).message.slice(0, 1000)} where id = ${eventId} and processed_at is null`;
    throw e;
  }
}

async function handleEvent(ev: StripeEventLike): Promise<void> {
  switch (ev.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return checkoutCompleted(ev);
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed":
      return checkoutFailed(ev);
    case "invoice.paid":
      return invoicePaid(ev);
    case "invoice.payment_failed":
      return invoiceFailed(ev);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return subscriptionChanged(ev);
    case "charge.refunded":
      return chargeRefunded(ev);
    default:
      return; // stored, marked processed, nothing to do
  }
}

// ---------------------------------------------------------------------------
// checkout.session.*
// ---------------------------------------------------------------------------

interface OrderRow {
  id: string;
  clinic_id: string | null;
  kind: "one_time" | "subscription";
  plan: Plan | null;
  status: string;
  amount_cents: number | null;
  currency: string;
  customer_email: string | null;
  stripe_subscription_id: string | null;
  paid_at: Date | null;
}

async function clinicName(clinicId: string | null): Promise<string> {
  if (!clinicId) return "unknown clinic";
  const [c] = await db()<{ name: string }[]>`select coalesce(site_name, name) as name from clinics where id = ${clinicId}`;
  return c?.name ?? "unknown clinic";
}

async function checkoutCompleted(ev: StripeEventLike): Promise<void> {
  const sql = db();
  const s = ev.data.object;
  const sessionId = str(s.id);
  if (!sessionId) return;
  const meta = obj(s.metadata);
  const metaPlan = str(meta.plan);
  // the plan named at checkout; a session without one is read from its mode
  const sessionPlan: Plan = metaPlan === "report" || isSubscriptionPlan(metaPlan) ? metaPlan : s.mode === "subscription" ? "monthly" : "report";
  const kind = sessionPlan === "report" ? "one_time" : "subscription";

  let [order] = await sql<OrderRow[]>`select * from orders where stripe_checkout_session_id = ${sessionId}`;
  if (!order) {
    // Our pending row is missing (the insert after creating the session failed): rebuild it from the metadata.
    const clinicId = str(meta.clinic_id) ?? str(s.client_reference_id);
    const [clinic] = clinicId && UUID_RE.test(clinicId) ? await sql`select id from clinics where id = ${clinicId}` : [];
    if (!clinic) {
      await queueOwnerMail("owner_alert", `stripe:${ev.id}`, "Stripe payment could not be matched to a clinic",
        `Checkout session ${sessionId} (${money(num(s.amount_total), str(s.currency))}) completed, but it names no clinic we know.\nNothing was delivered. Check it in the Stripe dashboard.`);
      return;
    }
    await sql`insert into orders (clinic_id, kind, plan, stripe_checkout_session_id, status)
              values (${clinicId}, ${kind}, ${sessionPlan}, ${sessionId}, 'pending') on conflict (stripe_checkout_session_id) do nothing`;
    [order] = await sql<OrderRow[]>`select * from orders where stripe_checkout_session_id = ${sessionId}`;
  }
  if (s.payment_status === "unpaid") return; // a delayed payment method: wait for async_payment_succeeded

  const buyerEmail = (str(obj(s.customer_details).email) ?? str(s.customer_email) ?? order.customer_email)?.toLowerCase() ?? null;
  const subscriptionId = ref(s.subscription);
  const customerId = ref(s.customer);
  const paidAt = ts(ev.created) ?? new Date();
  // The payment and what follows from it for the clinic happen together, once: a later
  // event for the same session never moves the clinic's status again.
  await sql.begin(async (tx) => {
    const [paid] = await tx`
      update orders set status = 'paid', paid_at = coalesce(paid_at, ${paidAt}),
        amount_cents = ${num(s.amount_total)}, currency = ${str(s.currency) ?? order.currency},
        stripe_customer_id = ${customerId}, stripe_payment_intent_id = ${ref(s.payment_intent)},
        stripe_subscription_id = ${subscriptionId}, customer_email = ${buyerEmail}
      where id = ${order.id} and status in ('pending', 'failed') returning id`;
    if (!paid || !order.clinic_id) return;
    await tx`update clinics set status = 'customer', status_reason = null, updated_at = now() where id = ${order.clinic_id} and status <> 'customer'`;
    // stop the cold sequence: nothing unsent goes out to a paying clinic
    await tx`update messages set status = 'cancelled', review_reason = 'clinic became a customer', updated_at = now()
             where clinic_id = ${order.clinic_id} and type in ${tx(COLD_TYPES)} and status in ${tx(UNSENT)}`;
  });
  [order] = await sql<OrderRow[]>`select * from orders where id = ${order.id}`;
  if (order.status !== "paid") return; // refunded in the meantime: deliver nothing
  const clinicId = order.clinic_id;
  const name = await clinicName(clinicId);
  // what was bought: the plan stored with the order, else the one the session names
  const plan: Plan = order.kind === "one_time" ? "report" : isSubscriptionPlan(order.plan) ? order.plan : sessionPlan === "report" ? "monthly" : sessionPlan;

  // Two payments for the same thing (two tabs, an old link): deliver once and tell the owner.
  let duplicate = false;
  if (clinicId && order.kind === "one_time") {
    const [other] = await sql`
      select 1 from orders where clinic_id = ${clinicId} and kind = 'one_time' and id <> ${order.id}
        and status in ('paid', 'partially_refunded') and (paid_at, id) < (${order.paid_at}::timestamptz, ${order.id}::uuid) limit 1`;
    duplicate = !!other;
  }
  if (clinicId && order.kind === "subscription" && subscriptionId) {
    const [other] = await sql`
      select 1 from subscriptions where clinic_id = ${clinicId} and stripe_subscription_id <> ${subscriptionId}
        and status in ${sql(LIVE_SUBSCRIPTION)} limit 1`;
    duplicate = !!other;
  }

  let minTermEnd: Date | null = null;
  const months = plan === "report" ? null : Number(str(meta.min_term_months)) || minTermMonths(plan);
  if (order.kind === "subscription" && subscriptionId) {
    const [sub] = await sql<{ min_term_end: Date | null }[]>`
      insert into subscriptions (clinic_id, stripe_subscription_id, stripe_customer_id, plan, status, min_term_end, stripe_event_created)
      values (${clinicId}, ${subscriptionId}, ${customerId}, ${plan}, 'active',
              ${months ? sql`${order.paid_at}::timestamptz + make_interval(months => ${months}::int)` : null}, ${paidAt})
      on conflict (stripe_subscription_id) do update set
        clinic_id = coalesce(subscriptions.clinic_id, excluded.clinic_id),
        stripe_customer_id = coalesce(subscriptions.stripe_customer_id, excluded.stripe_customer_id),
        plan = excluded.plan, -- the checkout knows the plan for certain
        min_term_end = coalesce(subscriptions.min_term_end, excluded.min_term_end), updated_at = now()
      returning min_term_end`;
    minTermEnd = sub.min_term_end;
  }

  if (buyerEmail) {
    const r = receipt({ order, plan, name, tax: num(obj(s.total_details).amount_tax), months: months || null, minTermEnd, duplicate });
    await queueMessage({ type: "payment_receipt", toEmail: buyerEmail, subject: r.subject, bodyText: r.body, idempotencyKey: `receipt:${order.id}`, clinicId, priority: 10 });
  }

  if (duplicate) {
    await queueOwnerMail("owner_alert", `stripe-duplicate:${order.id}`, `Possible double payment: ${name}`,
      `${name} paid ${money(order.amount_cents, order.currency)} for ${plan === "report" ? "the full report" : `the ${PLAN_NAMES[plan].toLowerCase()}`}, but already has one.\nNothing new was built. Refund or cancel the extra payment in Stripe (session ${sessionId}).`);
    return;
  }
  if (!clinicId) return;
  if (!buyerEmail) {
    await queueOwnerMail("owner_alert", `stripe-noemail:${order.id}`, `Paid order without an email address: ${name}`,
      `Order ${order.id} is paid but Stripe gave no buyer email, so no receipt or report could be queued. Send them by hand.`);
  }
  // Only the full service needs the intake form and an onboarding task: monthly reports install nothing.
  if (plan === "monthly") {
    await sql`insert into intake_forms (clinic_id, order_id, token) values (${clinicId}, ${order.id}, ${randomToken(24)})
              on conflict (order_id) where order_id is not null do nothing`;
    await sql`insert into owner_tasks (kind, clinic_id, order_id, title, body)
              values ('onboarding', ${clinicId}, ${order.id}, ${`Onboard ${name} (full service plan)`},
                      ${"Paid. Waiting for the clinic's intake form. The welcome email with the form link and the full report is queued."})
              on conflict (order_id) where kind = 'onboarding' and order_id is not null do nothing`;
  }
  await enqueue("build_full_report", `full_report:${order.id}`, { orderId: order.id }, { priority: 20 });
}

function receipt(x: { order: OrderRow; plan: Plan; name: string; tax: number | null; months: number | null; minTermEnd: Date | null; duplicate: boolean }) {
  const o = ownerDetails();
  const monthly = x.plan !== "report";
  const lines = [
    "Hello,",
    "",
    `Thank you. We received your payment for ${x.name}.`,
    "",
    x.plan === "monthly" ? "Item: Full service plan, billed each month by card"
      : x.plan === "reports" ? "Item: Monthly reports, billed each month by card (the first month includes the first full report)"
      : "Item: Full report and fix files, one time",
    `Amount paid: ${money(x.order.amount_cents, x.order.currency)}${x.tax ? ` (includes ${money(x.tax, x.order.currency)} HST)` : ""}`,
    `Date: ${formatLongDate(x.order.paid_at ?? new Date())}`,
    `Reference: ${x.order.id}`,
    "",
  ];
  if (monthly) {
    lines.push(
      `The plan renews each month until it is cancelled.${x.months ? ` The minimum term is ${minTermText(x.months)}${x.minTermEnd ? `, to ${formatLongDate(x.minTermEnd)}` : ""}.` : ""}`,
      x.plan === "monthly"
        ? "A second email follows with your full report and a short form about your website, once the report has been checked."
        : "A second email follows with your first full report, once it has been checked. A new report follows each month.",
      "To cancel, write to us from this address.",
    );
  } else {
    lines.push(
      "Your full report is being prepared and checked. It is sent to this address when the check is done.",
      "Refunds for the one-time report are given when the report has not yet been delivered. To ask for one, write to us from this address.",
    );
  }
  lines.push("", `Questions: ${o.email}`, "", "--", signature());
  return { subject: x.plan === "monthly" ? "Receipt: In The Answer full service plan" : x.plan === "reports" ? "Receipt: In The Answer monthly reports" : "Receipt: In The Answer full report", body: lines.join("\n") };
}

async function checkoutFailed(ev: StripeEventLike): Promise<void> {
  const sessionId = str(ev.data.object.id);
  if (!sessionId) return;
  await db()`update orders set status = 'failed' where stripe_checkout_session_id = ${sessionId} and status = 'pending'`;
}

// ---------------------------------------------------------------------------
// invoice.* and customer.subscription.*
// ---------------------------------------------------------------------------

/** The subscription an invoice belongs to (the field moved between API versions). */
function invoiceSubscription(inv: Obj): string | null {
  return ref(obj(obj(inv.parent).subscription_details).subscription) ?? ref(inv.subscription);
}

async function invoicePaid(ev: StripeEventLike): Promise<void> {
  const inv = ev.data.object;
  const subId = invoiceSubscription(inv);
  if (!subId) return;
  const ends = ((obj(inv.lines).data as Obj[] | undefined) ?? []).map((l) => num(obj(l.period).end)).filter((n): n is number => n != null);
  const periodEnd = ends.length ? new Date(Math.max(...ends) * 1000) : null;
  await db()`
    update subscriptions set status = case when status in ('canceled', 'incomplete_expired') then status else 'active' end,
      current_period_end = greatest(current_period_end, ${periodEnd}::timestamptz), updated_at = now()
    where stripe_subscription_id = ${subId}`;
}

async function invoiceFailed(ev: StripeEventLike): Promise<void> {
  const sql = db();
  const inv = ev.data.object;
  const subId = invoiceSubscription(inv);
  const [sub] = subId
    ? await sql<{ clinic_id: string | null }[]>`
        update subscriptions set status = case when status = 'canceled' then status else 'past_due' end, updated_at = now()
        where stripe_subscription_id = ${subId} returning clinic_id`
    : [];
  const name = await clinicName(sub?.clinic_id ?? null);
  const title = `Monthly payment failed: ${name}`;
  const body = `Stripe could not collect ${money(num(inv.amount_due), str(inv.currency))} (invoice ${str(inv.id) ?? "?"}, attempt ${num(inv.attempt_count) ?? "?"}).\nStripe retries by its own schedule. Subscription ${subId ?? "unknown"}.`;
  if (sub?.clinic_id) {
    await sql`insert into owner_tasks (kind, clinic_id, title, body)
              select 'alert', ${sub.clinic_id}, ${title}, ${body}
              where not exists (select 1 from owner_tasks where kind = 'alert' and clinic_id = ${sub.clinic_id} and title = ${title} and status = 'open')`;
  }
  await queueOwnerMail("owner_alert", `stripe:${ev.id}`, title, body);
}

async function subscriptionChanged(ev: StripeEventLike): Promise<void> {
  const sql = db();
  const sub = ev.data.object;
  const id = str(sub.id);
  if (!id) return;
  const deleted = ev.type === "customer.subscription.deleted";
  const created = ev.type === "customer.subscription.created";
  const meta = obj(sub.metadata);
  const item = obj(((obj(sub.items).data as Obj[] | undefined) ?? [])[0]);
  const periodEnd = ts(item.current_period_end) ?? ts(sub.current_period_end);
  const cancelAt = ts(sub.cancel_at) ?? (sub.cancel_at_period_end === true ? periodEnd : null);
  const eventAt = ts(ev.created) ?? new Date();
  const canceledAt = ts(sub.canceled_at) ?? (deleted ? eventAt : null);
  const status = deleted ? "canceled" : (str(sub.status) ?? "incomplete");
  const metaClinic = str(meta.clinic_id);
  const [clinic] = metaClinic && UUID_RE.test(metaClinic) ? await sql<{ id: string }[]>`select id from clinics where id = ${metaClinic}` : [];
  const months = Number(str(meta.min_term_months)) || null;
  const subPlan = isSubscriptionPlan(str(meta.plan)) ? (str(meta.plan) as "reports" | "monthly") : null;
  const start = ts(sub.start_date) ?? ts(sub.created);

  const [before] = await sql<{ status: string; cancel_at: Date | null }[]>`select status, cancel_at from subscriptions where stripe_subscription_id = ${id}`;
  const [row] = await sql<{ clinic_id: string | null; min_term_end: Date | null; applied: boolean }[]>`
    insert into subscriptions (clinic_id, stripe_subscription_id, stripe_customer_id, plan, status, current_period_end, min_term_end,
                               cancel_at, canceled_at, stripe_event_created)
    values (${clinic?.id ?? null}, ${id}, ${ref(sub.customer)}, ${subPlan ?? "monthly"}, ${status}, ${periodEnd},
            ${months && start ? sql`${start}::timestamptz + make_interval(months => ${months}::int)` : null}, ${cancelAt}, ${canceledAt}, ${eventAt})
    on conflict (stripe_subscription_id) do update set
      clinic_id = coalesce(subscriptions.clinic_id, excluded.clinic_id),
      stripe_customer_id = coalesce(subscriptions.stripe_customer_id, excluded.stripe_customer_id),
      min_term_end = coalesce(subscriptions.min_term_end, excluded.min_term_end),
      current_period_end = greatest(subscriptions.current_period_end, excluded.current_period_end),
      -- a "created" event never overrides what later events already wrote; an older event never overrides a newer one
      status = case when ${!created}::boolean and (subscriptions.stripe_event_created is null or subscriptions.stripe_event_created <= excluded.stripe_event_created)
                    then excluded.status else subscriptions.status end,
      cancel_at = case when ${!created}::boolean and (subscriptions.stripe_event_created is null or subscriptions.stripe_event_created <= excluded.stripe_event_created)
                    then excluded.cancel_at else subscriptions.cancel_at end,
      canceled_at = case when ${!created}::boolean and (subscriptions.stripe_event_created is null or subscriptions.stripe_event_created <= excluded.stripe_event_created)
                    then excluded.canceled_at else subscriptions.canceled_at end,
      stripe_event_created = greatest(subscriptions.stripe_event_created, excluded.stripe_event_created),
      updated_at = now()
    returning clinic_id, min_term_end, (status = ${status}) as applied`;

  const newlyCancelled = deleted && before?.status !== "canceled";
  const newlyScheduled = !deleted && cancelAt != null && row.applied && before?.cancel_at?.getTime() !== cancelAt.getTime();
  if (newlyCancelled || newlyScheduled) {
    const name = await clinicName(row.clinic_id);
    const early = row.min_term_end && (cancelAt ?? canceledAt ?? eventAt) < row.min_term_end;
    await queueOwnerMail("owner_alert", `stripe:${ev.id}`,
      deleted ? `Full service plan ended: ${name}` : `Full service plan set to end: ${name}`,
      [
        deleted ? `The subscription for ${name} has ended.` : `The subscription for ${name} is set to end on ${formatLongDate(cancelAt!)}.`,
        row.min_term_end ? `Minimum term runs to ${formatLongDate(row.min_term_end)}${early ? ": this is before the end of the minimum term." : "."}` : "No minimum term end is recorded.",
        `Subscription ${id}.`,
      ].join("\n"));
  }
}

// ---------------------------------------------------------------------------
// charge.refunded
// ---------------------------------------------------------------------------

async function chargeRefunded(ev: StripeEventLike): Promise<void> {
  const sql = db();
  const ch = ev.data.object;
  const pi = ref(ch.payment_intent);
  const refunded = num(ch.amount_refunded) ?? 0;
  const amount = num(ch.amount) ?? 0;
  const full = ch.refunded === true || (amount > 0 && refunded >= amount);
  const [order] = pi ? await sql<OrderRow[]>`select * from orders where stripe_payment_intent_id = ${pi}` : [];
  if (!order) {
    // Monthly charges are invoices, not orders: tell the owner, change nothing.
    const customer = ref(ch.customer);
    const [sub] = customer ? await sql<{ clinic_id: string | null }[]>`select clinic_id from subscriptions where stripe_customer_id = ${customer} order by created_at desc limit 1` : [];
    await queueOwnerMail("owner_alert", `stripe:${ev.id}`, `Refund recorded in Stripe: ${await clinicName(sub?.clinic_id ?? null)}`,
      `${money(refunded, str(ch.currency))} of ${money(amount, str(ch.currency))} was refunded on charge ${str(ch.id) ?? "?"}.\nIt is not a one-time report order${sub ? " (it is a full service plan charge)" : ""}, so no order was changed.`);
    return;
  }
  await sql`
    update orders set status = ${full ? "refunded" : "partially_refunded"}, refunded_at = coalesce(refunded_at, now()),
      amount_refunded_cents = greatest(amount_refunded_cents, ${refunded})
    where id = ${order.id} and status in ('paid', 'partially_refunded', 'refunded') and amount_refunded_cents <= ${refunded}`;
  let delivery = "No report had been queued yet; none will be built.";
  const [msg] = await sql<{ id: string; status: string }[]>`select id, status::text from messages where idempotency_key = ${deliveryKey(order.id)}`;
  if (msg) {
    if (full && UNSENT.includes(msg.status)) {
      await sql`update messages set status = 'cancelled', review_reason = 'order refunded before delivery', updated_at = now()
                where id = ${msg.id} and status in ${sql(UNSENT)}`;
      delivery = "The report had not been sent; its delivery email is cancelled.";
    } else if (msg.status === "sent") {
      delivery = "The report had already been delivered. Published terms: refunds are given when the report has not yet been delivered.";
    } else {
      delivery = `The delivery email is ${msg.status}.`;
    }
  } else if (!full) {
    delivery = "The report has not been queued yet; it is still built for a partial refund.";
  }
  const name = await clinicName(order.clinic_id);
  await queueOwnerMail("owner_alert", `stripe:${ev.id}`, `${full ? "Refund" : "Partial refund"}: ${name}`,
    `${money(refunded, str(ch.currency))} of ${money(amount, str(ch.currency))} was refunded for ${name} (order ${order.id}).\n${delivery}`);
}
