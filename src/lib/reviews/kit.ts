import QRCode from "qrcode";
import { esc } from "../reports/html";
import { writeReviewUrl } from "./placesLive";

/**
 * Review-request kit (fix file for low review volume): a short message and a
 * printable card with a QR code to the clinic's Google review link. It must
 * say: ask every patient, no incentive, no filtering by satisfaction.
 */
export const KIT_RULES = [
  "Ask every patient, not only the ones you expect to be happy.",
  "Offer nothing in return: no discount, gift or draw for a review.",
  "Do not filter or screen patients by satisfaction before asking.",
  "Never reply to a review with any detail about the person's care; reply in general terms only.",
];

export function kitMessage(clinicName: string, link: string): string {
  return [
    `Thank you for visiting ${clinicName}.`,
    `If you are willing, you can share your experience on Google. It takes a minute and helps other patients find information about us: ${link}`,
    `Please do not include personal health details in a review.`,
  ].join(" ");
}

export async function reviewKitHtml(clinicName: string, placeId: string): Promise<{ html: string; link: string; message: string }> {
  const link = writeReviewUrl(placeId);
  const qr = await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#14181F", light: "#FFFFFF" } });
  const message = kitMessage(clinicName, link);
  const html = `<div class="kit">
  <h3>Review-request kit</h3>
  <ol>${KIT_RULES.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>
  <p><strong>Message for email or text after a visit</strong></p>
  <pre class="file">${esc(message)}</pre>
  <p><strong>Printable card</strong> (front desk, 3.5 by 2 inches)</p>
  <div class="card" style="border:1.5px solid #14181F;border-radius:10px;width:3.5in;height:2in;padding:12px;display:flex;gap:12px;align-items:center;box-sizing:border-box;break-inside:avoid">
    <div style="width:1.3in;height:1.3in" role="img" aria-label="QR code to leave a Google review">${qr}</div>
    <div style="font-size:12px;line-height:1.35"><div style="font-weight:700;font-size:13px">${esc(clinicName)}</div>
      Share your experience on Google. Scan the code with your phone camera.<div style="font-size:10.5px;margin-top:6px;color:#4A5361">Every patient is invited. No reward is offered.</div></div>
  </div>
</div>`;
  return { html, link, message };
}
