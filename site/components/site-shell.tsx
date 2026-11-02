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
 * The original ZeroGate mark, drawn from the supplied artwork's own geometry so
 * it stays crisp at every size and inherits the surrounding text colour.
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

/**
 * The ring that stands in for the "o" in Zero.
 *
 * Drawn rather than embedded so it stays crisp at any size, costs no request,
 * and takes its colours from the theme tokens. The accent arc is a quarter turn
 * starting at twelve o'clock: a gate part-way open, and a check still running.
 */
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const ARC_SWEEP = RING_CIRCUMFERENCE / 4;

export function RingGlyph() {
  return (
    <svg className="wordmark__ring" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle
        cx="12"
        cy="12"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
      />
      <circle
        cx="12"
        cy="12"
        r={RING_RADIUS}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeDasharray={`${ARC_SWEEP} ${RING_CIRCUMFERENCE - ARC_SWEEP}`}
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}

/**
 * The wordmark. Real text either side of the ring, with the whole thing
 * labelled so assistive technology reads "ZeroGate" and never "Zer Gate".
 */
export function Wordmark() {
  return (
    <span className="wordmark" role="img" aria-label="ZeroGate">
      <span aria-hidden="true">Zer</span>
      <RingGlyph />
      <span aria-hidden="true">Gate</span>
    </span>
  );
}

/** The lockup: the original symbol alongside the wordmark. */
export function Brand() {
  return (
    <Link className="brand" href="/">
      <LogoMark />
      <Wordmark />
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
          <a className="github-link" href={GITHUB_URL} aria-label="GitHub repository" title="GitHub" rel="noreferrer noopener" target="_blank">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
              <path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.769-.244.769-.542 0-.267-.01-.975-.015-1.914-3.13.68-3.79-1.508-3.79-1.508-.512-1.3-1.25-1.647-1.25-1.647-1.023-.7.078-.686.078-.686 1.13.08 1.724 1.16 1.724 1.16 1.006 1.724 2.64 1.226 3.283.938.102-.729.394-1.226.716-1.508-2.498-.284-5.124-1.25-5.124-5.563 0-1.23.44-2.233 1.16-3.02-.116-.285-.503-1.43.11-2.98 0 0 .945-.303 3.094 1.154a10.79 10.79 0 0 1 5.625 0c2.148-1.457 3.092-1.154 3.092-1.154.614 1.55.227 2.695.112 2.98.72.787 1.159 1.79 1.159 3.02 0 4.325-2.63 5.276-5.136 5.554.404.35.764 1.04.764 2.096 0 1.513-.014 2.733-.014 3.104 0 .3.203.65.774.54A11.252 11.252 0 0 0 12 .75Z" />
            </svg>
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
