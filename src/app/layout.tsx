import type { Metadata } from "next";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/atkinson-hyperlegible-next/500.css";
import "@fontsource/atkinson-hyperlegible-next/600.css";
import "@fontsource/atkinson-hyperlegible-next/700.css";
import "./globals.css";

const DESCRIPTION =
  "In The Answer tests whether AI assistants name your Ontario clinic when patients ask for a recommendation, and shows you what to fix. Free report for dental, family and medspa clinics.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "https://intheanswer.ca"),
  title: { default: "In The Answer", template: "%s | In The Answer" },
  description: DESCRIPTION,
  // The picture for both is src/app/opengraph-image.jpg, drawn by `npm run brand:assets`.
  openGraph: { type: "website", siteName: "In The Answer", locale: "en_CA", title: "In The Answer", description: DESCRIPTION },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-CA">
      <body>{children}</body>
    </html>
  );
}
