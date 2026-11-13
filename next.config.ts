import type { NextConfig } from "next";

/** Sent with every response. */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Our pages may be framed only by our own site (the portal previews a report in a frame).
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  // Browsers ignore this over plain http (local development).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

/**
 * Report pages (/r/<token>) are a single self-contained document: inline
 * styles, fonts and images embedded as data: URIs, inline SVG, ordinary links.
 * No scripts, no forms, nothing loaded from anywhere. The policy allows
 * exactly that, so injected markup could not run or load anything.
 * The PDF download (/r/<token>/pdf) is not HTML and keeps the general headers.
 */
const REPORT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

const nextConfig: NextConfig = {
  // The portal and pipeline are database-driven and render per request; the
  // classic dynamic model is simpler here than Cache Components.
  cacheComponents: false,
  // Chromium for PDF rendering ships as a server-only external package.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core", "lighthouse", "chrome-launcher", "axe-core"],
  poweredByHeader: false,
  // Report fonts are read from disk at run time (src/lib/reports/html.ts) and
  // embedded in the HTML. Listing them here makes the deployment include them.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2",
      "./node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2",
      "./node_modules/@fontsource/inter/files/inter-latin-700-normal.woff2",
      "./node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff2",
      "./node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-600-normal.woff2",
      "./node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2",
    ],
    // Chromium's compressed binaries are read at run time, so tracing misses them.
    // Only the routes that run jobs (PDFs, site checks) need them.
    "/api/cron/worker": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/cron/pdf-check": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // Later entries override earlier ones for the same header.
      {
        source: "/r/:token",
        headers: [
          { key: "Content-Security-Policy", value: REPORT_CSP },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      { source: "/r/:token/pdf", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default nextConfig;
