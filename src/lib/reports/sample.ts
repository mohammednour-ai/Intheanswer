import { ownerDetails, env } from "../env";
import { LIMITS_LINE } from "./teaser";
import type { TeaserData } from "./types";

/**
 * The public sample report. Every clinic in it is INVENTED and labelled as
 * such; it shows the format, not anyone's real result.
 */
export function sampleTeaser(): TeaserData {
  const o = ownerDetails();
  const q = [
    "I just moved to Orillia, Ontario. Can you recommend a good dentist that is accepting new patients?",
    "Which dentists in Orillia can see me the same day for a dental emergency?",
    "I do not have dental insurance. Which dental clinics in Orillia are affordable or list their prices?",
    "I am looking for a family dentist in Orillia who is good with kids. Who would you suggest?",
    "Which dentists in Orillia bill my insurance directly so I do not pay up front?",
    "Are there dentists in Orillia open evenings or Saturdays?",
  ];
  const named = [
    ["Lakeside Smiles (invented)", "Northgate Family Dental (invented)"],
    ["Northgate Family Dental (invented)"],
    ["Couchiching Dental Care (invented)", "Lakeside Smiles (invented)"],
    [],
    ["Lakeside Smiles (invented)"],
    ["Northgate Family Dental (invented)", "Couchiching Dental Care (invented)"],
  ];
  const status = ["not_named", "not_named", "listed_only", "recommended", "not_named", "not_named"] as const;
  return {
    kind: "sample",
    clinic: { id: null, name: "Birchwood Dental Clinic (invented)", city: "Orillia", website: "https://birchwood-dental.example", domain: "birchwood-dental.example" },
    sector: { name: "dental clinic", patientNoun: "dentist", regulatorNote: "Check all wording against the RCDSO advertising standards before publishing." },
    test: { assistant: "Claude", model: env().CLAUDE_MODEL, servedModels: [env().CLAUDE_MODEL], date: "a sample date", dateIso: "", questionCount: 6 },
    score: { recommended: 1, listedOnly: 1, total: 6 },
    summary: [
      "We asked Claude 6 questions a patient in Orillia might ask when looking for a dentist. It recommended Birchwood Dental Clinic in 1 of them, and mentioned it without recommending it in 1.",
      "On the 9 pages we read on birchwood-dental.example, we found 6 gaps in what the site states for patients and for the tools assistants use to read it. The three most concrete are below.",
    ],
    rows: q.map((question, i) => ({ questionIndex: i, question, status: status[i], matchedAs: null, namedInstead: named[i], answerId: `sample-${i}` })),
    findings: [
      {
        checkKey: "hours_conflict",
        title: "Hours that disagree",
        text: 'Two different sets of hours appear on your site: "Saturday 9:00 am to 2:00 pm" (birchwood-dental.example/) and "Saturday closed" (birchwood-dental.example/contact).',
        evidence: [],
      },
      {
        checkKey: "new_patients",
        title: "New-patient status",
        text: "We did not find a statement on the 9 pages we read on birchwood-dental.example saying whether you are accepting new patients.",
        evidence: [],
      },
      {
        checkKey: "fees",
        title: "Fees for uninsured services",
        text: "We did not find any fees for services not covered by insurance on the 9 pages we read on birchwood-dental.example. Patients asked about cost directly.",
        evidence: [],
      },
    ],
    pagesRead: 9,
    findingsTotal: 6,
    offers: { oneTimeUrl: `${env().APP_URL}/pricing`, reportsUrl: `${env().APP_URL}/pricing`, monthlyUrl: `${env().APP_URL}/pricing`, minTerm: o.minTerm, reportsMinTerm: o.reportsMinTerm },
    limits:
      "SAMPLE: every clinic named in this report is invented, and the answers are illustrative. " +
      LIMITS_LINE("Claude", env().CLAUDE_MODEL, "the test date", "the clinic's city", 6),
    owner: { name: o.name, businessName: o.businessName, mailingAddress: o.mailingAddress, phone: o.phone, email: o.email },
    claims: [],
  };
}
