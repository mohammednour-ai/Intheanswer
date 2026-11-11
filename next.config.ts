import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The portal and pipeline are database-driven and render per request; the
  // classic dynamic model is simpler here than Cache Components.
  cacheComponents: false,
  // Chromium for PDF rendering ships as a server-only external package.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core", "lighthouse", "chrome-launcher", "axe-core"],
  poweredByHeader: false,
};

export default nextConfig;
