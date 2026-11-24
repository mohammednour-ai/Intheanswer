/** How a letter's status reads in the portal. */
export const LETTER_STATUS: Record<string, { t: string; cls: string }> = {
  review: { t: "Waiting for you", cls: "pill-blue" },
  held: { t: "Held", cls: "pill-warn" },
  approved: { t: "Approved, posting", cls: "pill-blue" },
  sent: { t: "Posted", cls: "pill-ok" },
  cancelled: { t: "Cancelled", cls: "" },
  failed: { t: "Failed", cls: "pill-bad" },
};
