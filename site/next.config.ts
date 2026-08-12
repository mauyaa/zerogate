import type { NextConfig } from "next";

/**
 * A static content site: no database, no API routes, no runtime configuration.
 * Everything below the headers is Next.js defaults on purpose.
 */
const isDev = process.env.NODE_ENV === "development";

/**
 * The production policy is the strict one. Development additionally needs
 * eval() for React's debugging features and a websocket for hot reload, and it
 * must not upgrade requests to https on localhost — so those three allowances
 * are scoped to `next dev` and never shipped.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js inlines a small hydration bootstrap; styles are inlined per route.
  isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  isDev ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"])
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()"
  }
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // The site is a sibling of the library package, so both have a lockfile.
  // Pinning the root stops Turbopack inferring the parent directory.
  turbopack: { root: import.meta.dirname },
  headers: () => Promise.resolve([{ source: "/:path*", headers: securityHeaders }])
};

export default nextConfig;
