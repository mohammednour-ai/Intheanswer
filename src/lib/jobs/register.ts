// Side-effect imports: each module registers its job handlers.
import "../pipeline/discover";
import "../pipeline/contact";
import "../pipeline/test";
import "../pipeline/audit/run";
import "../pipeline/score";
import "../pipeline/teaserJobs";
import "../sitetest/run";
import "../reviews/jobs";
import "../pages/jobs";
import "../payments/jobs";
import "../sending/send";
import "../sending/dns";
import "../sending/events";
import "../replies/ingest";
import "../schedule"; // scheduler tasks, retests, monthly reports, owner alerts
