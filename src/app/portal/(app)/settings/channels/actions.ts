"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { CHANNELS, saveChannel, saveRouting, setKillSwitch, validateRouting, type Channel, type RoutingRules } from "@/lib/channels/settings";
import { previewRouting, type Preview } from "@/lib/channels/routing";

function rulesFrom(form: FormData): RoutingRules {
  return {
    score_threshold: Number(form.get("score_threshold")),
    split_on: form.get("split_on") === "on",
    split_letter_pct: Number(form.get("split_letter_pct")),
    cooldown_days: Number(form.get("cooldown_days")),
  };
}

export type RoutingState = { preview?: Preview; saved?: boolean; error?: string; rules?: RoutingRules } | null;

/** "Preview" shows how the next 100 clinics would be routed; "Save" stores the rules and logs the change. */
export async function routingAction(_prev: RoutingState, form: FormData): Promise<RoutingState> {
  const owner = await requireOwner();
  try {
    const rules = validateRouting(rulesFrom(form));
    if (form.get("intent") === "save") {
      await saveRouting(rules, owner.email);
      revalidatePath("/portal/settings/channels");
      return { saved: true, rules };
    }
    return { preview: await previewRouting(rules, 100), rules };
  } catch (e) {
    return { error: (e as Error).message, rules: rulesFrom(form) };
  }
}

export async function saveChannelAction(channel: string, form: FormData) {
  const owner = await requireOwner();
  if (!CHANNELS.includes(channel as Channel)) throw new Error("unknown channel");
  const patch: Record<string, unknown> = {
    on: form.get("on") === "on",
    pause_until: String(form.get("pause_until") ?? "") || null,
    daily_cap: Number(form.get("daily_cap")),
    monthly_spend_cap_usd: Number(form.get("monthly_spend_cap_usd")),
    mode: String(form.get("mode") ?? "REVIEW"),
  };
  if (channel === "letter") {
    patch.cost_letter_cents = Math.round(Number(form.get("cost_letter")) * 100);
    patch.cost_postcard_cents = Math.round(Number(form.get("cost_postcard")) * 100);
    patch.headline_test = form.get("headline_test") === "on";
    patch.color = form.get("color") === "on";
  }
  if (channel === "inbound") patch.number = String(form.get("number") ?? "").trim();
  await saveChannel(channel as Channel, patch, owner.email);
  revalidatePath("/portal/settings/channels");
}

export async function killSwitchAction(on: boolean) {
  const owner = await requireOwner();
  await setKillSwitch(on, owner.email);
  revalidatePath("/portal", "layout");
}
