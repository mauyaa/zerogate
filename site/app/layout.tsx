import type { Metadata, Viewport } from "next";
import { Instrument_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Loaded under `*-loaded` names so they feed the design tokens in globals.css
// rather than competing with them for the same custom property.
const sans = Instrument_Sans({
  variable: "--font-sans-loaded",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono-loaded",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

/**
 * Resolved at build time. Vercel supplies the production host, so no domain is
 * hardcoded here and a preview deployment describes itself correctly.
 */
const productionOrigin =
  process.env.NEXT_PUBLIC_SITE_ORIGIN ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

const description =
  "When a provider stops answering mid-write, ZeroGate finds out what actually landed, verifies it against authoritative state, and signs a receipt — without dispatching twice to find out.";

export const metadata: Metadata = {
  metadataBase: new URL(productionOrigin),
  applicationName: "ZeroGate",
  title: {
    default: "ZeroGate — find out what happened before retrying",
    template: "%s · ZeroGate",
  },
  description,
  authors: [{ name: "mauyaa" }],
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    siteName: "ZeroGate",
    title: "ZeroGate — find out what happened before retrying",
    description,
    type: "website",
    url: "/",
    images: [{ url: "/social-card.png", width: 512, height: 512, alt: "ZeroGate" }],
  },
  twitter: {
    card: "summary",
    title: "ZeroGate — find out what happened before retrying",
    description,
    images: ["/social-card.png"],
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light",
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
