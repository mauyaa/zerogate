import Link from "next/link";
import type { ReactNode } from "react";
import { PageShell } from "./site-shell";

export type DocsPage = { href: string; title: string; blurb: string };

/**
 * One ordered list drives the sidebar, the prev/next pager, and the index
 * cards. Adding a page anywhere else is therefore impossible to forget.
 */
export const docsPages: DocsPage[] = [
  { href: "/docs", title: "Overview", blurb: "What ZeroGate is, in one page." },
  {
    href: "/docs/quickstart",
    title: "Quickstart",
    blurb: "Define one effect and watch a dropped write resolve.",
  },
  {
    href: "/docs/concepts",
    title: "Concepts",
    blurb: "Six words. That is the whole vocabulary.",
  },
  {
    href: "/docs/state-model",
    title: "State model",
    blurb: "What the engine may conclude, and when.",
  },
  {
    href: "/docs/effect-contracts",
    title: "Effect contracts",
    blurb: "Pin an operation so approvals cannot outlive it.",
  },
  {
    href: "/docs/receipts",
    title: "Receipts",
    blurb: "Evidence you can check without trusting the runtime.",
  },
  {
    href: "/docs/limits",
    title: "Limits",
    blurb: "What is not true. Read before you depend on it.",
  },
];

export function DocsNav({ current }: { current: string }) {
  return (
    <nav className="docs-nav" aria-label="Documentation">
      {docsPages.map(({ href, title }) => (
        <Link key={href} href={href} aria-current={href === current ? "page" : undefined}>
          {title}
        </Link>
      ))}
    </nav>
  );
}

/** Sequential prev/next, derived from `docsPages` so the order is never wrong. */
function DocsPager({ current }: { current: string }) {
  const index = docsPages.findIndex((page) => page.href === current);
  const previous = index > 0 ? docsPages[index - 1] : undefined;
  const next = index >= 0 && index < docsPages.length - 1 ? docsPages[index + 1] : undefined;

  if (previous === undefined && next === undefined) return null;

  return (
    <nav
      aria-label="More documentation"
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        marginTop: "var(--space-16)",
        paddingTop: "var(--space-6)",
        borderTop: "1px solid var(--color-border)",
      }}
    >
      {previous === undefined ? (
        <span />
      ) : (
        <Link href={previous.href}>← {previous.title}</Link>
      )}
      {next === undefined ? null : <Link href={next.href}>{next.title} →</Link>}
    </nav>
  );
}

export function DocPage({
  current,
  title,
  lead,
  children,
}: {
  current: string;
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <PageShell>
      <div className="docs-layout">
        <DocsNav current={current} />
        <article>
          <header className="stack" style={{ marginBottom: "var(--space-10)" }}>
            <p className="eyebrow">Documentation</p>
            <h1 style={{ fontSize: "var(--text-4xl)" }}>{title}</h1>
            <p className="lede">{lead}</p>
          </header>
          <div className="prose">{children}</div>
          <DocsPager current={current} />
        </article>
      </div>
    </PageShell>
  );
}

export function Callout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="callout">
      <p>
        <strong>{title}</strong>
      </p>
      {children}
    </div>
  );
}
