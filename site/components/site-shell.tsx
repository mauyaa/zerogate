import Link from "next/link";
import type { ReactNode } from "react";

export const GITHUB_URL = "https://github.com/mauyaa/zerogate";
export const NPM_URL = "https://www.npmjs.com/package/zerogate";

// Three links and one button. Anything else that matters is reachable from
// inside a page, where the reader is already looking for it.
const navigation = [
  ["Docs", "/docs"],
  ["Security", "/security"],
] as const;

const footerLinks = [
  ["Quickstart", "/docs/quickstart"],
  ["Concepts", "/docs/concepts"],
  ["Receipts", "/docs/receipts"],
  ["State model", "/docs/state-model"],
  ["Limits", "/docs/limits"],
  ["Security", "/security"],
  ["Privacy", "/privacy"],
] as const;

/**
 * The ZeroGate mark, drawn from the supplied artwork's own geometry so it stays
 * crisp at every size and inherits the surrounding text colour.
 */
export function LogoMark() {
  return (
    <svg
      className="logo-mark"
      viewBox="0 0 111 115"
      fill="none"
      stroke="currentColor"
      strokeWidth="10.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M105.25 37.75V5.25H5.25v100h28" />
      <circle cx="78.25" cy="82.75" r="27" />
    </svg>
  );
}

export function Brand() {
  return (
    <Link className="brand" href="/">
      <LogoMark />
      <span>ZeroGate</span>
    </Link>
  );
}

export function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        <nav className="desktop-nav" aria-label="Primary">
          {navigation.map(([label, href]) => (
            <Link href={href} key={href}>{label}</Link>
          ))}
          <a href={GITHUB_URL} rel="noreferrer noopener" target="_blank">
            GitHub <span aria-hidden="true">↗</span>
          </a>
          <Link className="button button--primary button--small" href="/docs/quickstart">
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <Brand />
          <p>Find out what happened before retrying.</p>
        </div>
        <nav aria-label="Footer">
          {footerLinks.map(([label, href]) => (
            <Link href={href} key={href}>{label}</Link>
          ))}
          <a href={GITHUB_URL} rel="noreferrer noopener" target="_blank">GitHub</a>
          <a href={NPM_URL} rel="noreferrer noopener" target="_blank">npm</a>
        </nav>
      </div>
      <div className="footer-legal">
        <span>© 2026 mauyaa · Apache-2.0</span>
        <span>Every claim on this site is covered by a test in the repository.</span>
      </div>
    </footer>
  );
}

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main-content">{children}</main>
      <SiteFooter />
    </>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}
