import assert from "node:assert/strict";
import { access, readdir, readFile, stat } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

const read = (path) => readFile(new URL(path, root), "utf8");

async function sourceFiles(dir) {
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const next = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, current);
      if (entry.isDirectory()) {
        if (!["node_modules", ".next", "out"].includes(entry.name)) await walk(next);
      } else if (/\.(ts|tsx|mjs|css|json)$/.test(entry.name)) {
        found.push(next);
      }
    }
  }
  await walk(new URL(dir, root));
  return found;
}

test("every internal route referenced by navigation exists on disk", async () => {
  const [shell, docsShell] = await Promise.all([
    read("components/site-shell.tsx"),
    read("components/docs-shell.tsx"),
  ]);
  // Navigation lives in tuple arrays as well as JSX attributes, so match any
  // quoted internal path rather than only `href="..."`.
  const hrefs = new Set(
    [...shell.matchAll(/"(\/[a-z0-9/-]*)"/g), ...docsShell.matchAll(/"(\/[a-z0-9/-]*)"/g)].map(
      ([, href]) => href
    )
  );
  assert.ok(hrefs.size >= 9, `expected the full route set, found ${hrefs.size}`);
  for (const href of hrefs) {
    const segment = href === "/" ? "app/page.tsx" : `app${href}/page.tsx`;
    await access(new URL(segment, root));
  }
});

test("the docs set is complete and ordered by a single source of truth", async () => {
  const docsShell = await read("components/docs-shell.tsx");
  const hrefs = [...docsShell.matchAll(/href:\s*"(\/docs[^"]*)"/g)].map(([, href]) => href);
  assert.equal(hrefs.length, 7);
  assert.equal(hrefs[0], "/docs", "the overview must come first");
  assert.equal(hrefs.at(-1), "/docs/limits", "limits must come last");
  assert.equal(new Set(hrefs).size, hrefs.length, "duplicate docs entries");
});

test("no route, component, or asset references a retired host or toolchain", async () => {
  // Split so this file does not match its own guard.
  const banned = [
    "chat" + "gpt",
    "open" + "ai",
    "cloud" + "flare",
    "wran" + "gler",
    "vin" + "ext",
    "driz" + "zle",
    "mini" + "flare",
  ];
  const offenders = [];
  for (const file of [...(await sourceFiles("app/")), ...(await sourceFiles("components/"))]) {
    const source = (await readFile(file, "utf8")).toLowerCase();
    const hit = banned.find((word) => source.includes(word));
    if (hit) offenders.push(`${file.pathname.split("/").pop()}: ${hit}`);
  }
  assert.deepEqual(offenders, [], `retired references leaked back in: ${offenders.join(", ")}`);
});

test("no waitlist, demo, or database surface remains", async () => {
  for (const removed of [
    "app/waitlist",
    "app/demo",
    "app/video",
    "app/pilot",
    "app/build-log",
    "app/api",
    "db",
    "worker",
    "vite.config.ts",
  ]) {
    await assert.rejects(access(new URL(removed, root)), { code: "ENOENT" }, `${removed} still exists`);
  }
});

test("the hosted surface declares restrictive browser security headers", async () => {
  const config = await read("next.config.ts");
  for (const header of [
    "Content-Security-Policy",
    "Cross-Origin-Opener-Policy",
    "Permissions-Policy",
    "Referrer-Policy",
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
  ]) {
    assert.match(config, new RegExp(header), `${header} is not declared`);
  }
  assert.match(config, /frame-ancestors 'none'/);
  assert.match(config, /form-action 'none'/);
  assert.match(config, /poweredByHeader:\s*false/);
});

test("the home page asks for one thing, twice, in the same words", async () => {
  const home = await read("app/page.tsx");
  const primaries = [...home.matchAll(/>\s*Get started\s*</g)].length;
  assert.equal(primaries, 2, "one primary CTA, repeated top and bottom");
  // Exactly one primary button style per CTA; a third competing action is drift.
  assert.equal([...home.matchAll(/button--primary/g)].length, 2);
});

test("components reference design tokens, never raw colour values", async () => {
  const offenders = [];
  for (const file of [...(await sourceFiles("app/")), ...(await sourceFiles("components/"))]) {
    if (file.pathname.endsWith("globals.css")) continue;
    const source = await readFile(file, "utf8");
    for (const [hex] of source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      // The theme colour in metadata and SVG artwork are the documented exceptions.
      if (/themeColor|social-card/.test(source) && hex === "#ffffff") continue;
      offenders.push(`${file.pathname.split("/").pop()}: ${hex}`);
    }
  }
  assert.deepEqual(offenders, [], `hardcoded colours: ${offenders.join(", ")}`);
});

test("typography and buttons follow the design system", async () => {
  const css = await read("app/globals.css");
  // Buttons are slate ink, never the accent. This is what keeps the page calm.
  assert.match(css, /\.button--primary\s*\{\s*background:\s*var\(--color-action\)/);
  assert.doesNotMatch(
    css,
    /\.button--primary\s*\{\s*background:\s*var\(--color-accent\)/,
    "the primary button must not be accent-coloured"
  );
  // Nothing heavier than semibold anywhere.
  for (const [, weight] of css.matchAll(/font-weight:\s*(\d{3})/g)) {
    assert.ok(Number(weight) <= 600, `font-weight ${weight} exceeds the 600 ceiling`);
  }
  // `strong` and `b` default to 700 in every browser, so the ceiling only holds
  // if the stylesheet overrides them. This was rendering at 700 in production.
  // Matched by parsing rules rather than exact formatting, so reformatting the
  // stylesheet cannot silently disable this check.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => ({
      selectors: selector.split(",").map((part) => part.trim()),
      body,
    })
  );
  for (const element of ["strong", "b"]) {
    const pinned = rules.some(
      (rule) => rule.selectors.includes(element) && /font-weight:\s*600\b/.test(rule.body)
    );
    assert.ok(
      pinned,
      `${element} must be pinned to weight 600 or the browser default of 700 leaks through`
    );
  }
  // Section-head eyebrows must keep their own size: a bare `.section-head p`
  // rule out-specifies `.eyebrow` and silently rendered it at body size.
  assert.match(
    css,
    /\.section-head p:not\(\.eyebrow\)/,
    "scope .section-head p so it cannot override .eyebrow"
  );
  assert.match(
    css,
    /\.desktop-nav a:not\(\.button\)/,
    "scope .desktop-nav a so it cannot override .button--primary"
  );
  // Headings carry negative tracking.
  assert.match(css, /h1\s*\{[^}]*letter-spacing:\s*-0?\.03em/s);
  // The eyebrow is the signature move and must stay accent-coloured and spaced.
  assert.match(css, /\.eyebrow\s*\{[^}]*letter-spacing:\s*0?\.12em/s);
  assert.match(css, /\.eyebrow\s*\{[^}]*color:\s*var\(--color-accent\)/s);
});

test("the wordmark keeps its accessible name and takes colour from tokens", async () => {
  const [shell, css] = await Promise.all([
    read("components/site-shell.tsx"),
    read("app/globals.css"),
  ]);

  // The ring replaces a letter, so the name must still be announced whole.
  assert.match(shell, /aria-label="ZeroGate"/, "the wordmark needs an accessible name");
  assert.match(shell, /role="img"/);
  // Every inline SVG in the shell is decorative; names come from the wrappers.
  const svgTags = [...shell.matchAll(/<svg\b[^>]*>/g)].map(([tag]) => tag);
  assert.ok(svgTags.length >= 2, "expected the mark and the ring");
  for (const tag of svgTags) {
    assert.match(
      tag,
      /aria-hidden="true"/,
      `a decorative svg is exposed to assistive technology: ${tag.slice(0, 60)}`
    );
  }

  // The accent arc must come from the token, never a literal colour.
  assert.match(shell, /stroke="var\(--color-accent\)"/);

  // Sized in em so it scales with the surrounding text at any font size.
  assert.match(css, /\.wordmark__ring\s*\{[^}]*width:\s*[\d.]+em/s);
  assert.match(css, /\.wordmark__ring\s*\{[^}]*height:\s*[\d.]+em/s);

  // The original symbol is still part of the lockup.
  assert.match(shell, /viewBox="0 0 111 115"/, "the original mark must not be dropped");
});

test("the shell is light-only, accessible, and motion-safe", async () => {
  const [layout, css, shell, icon] = await Promise.all([
    read("app/layout.tsx"),
    read("app/globals.css"),
    read("components/site-shell.tsx"),
    read("public/icon.svg"),
  ]);
  // The mark is inline vector in `currentColor`, never a cropped raster tile.
  assert.match(shell, /viewBox="0 0 111 115"/);
  assert.match(shell, /stroke="currentColor"/);
  assert.match(icon, /viewBox="0 0 512 512"/);
  assert.match(layout, /colorScheme:\s*"light"/);
  assert.match(layout, /className="skip-link"/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /prefers-color-scheme:\s*dark/);
});

test("shipped icons stay small enough to be worth shipping", async () => {
  for (const asset of ["public/social-card.png", "public/apple-touch-icon.png"]) {
    const { size } = await stat(new URL(asset, root));
    assert.ok(size < 40_000, `${asset} is ${size} bytes; regenerate it`);
  }
});

test("no page pins a volatile count or an unsourced metric", async () => {
  for (const file of await sourceFiles("app/")) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /\b\d+\s+(?:passing\s+)?tests\b/i,
      `${file.pathname.split("/").pop()} contains a stale count that will rot`
    );
  }
});

test("external links are safe and marked", async () => {
  for (const file of [...(await sourceFiles("app/")), ...(await sourceFiles("components/"))]) {
    const source = await readFile(file, "utf8");
    for (const [tag] of source.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) {
      assert.match(
        tag,
        /rel="noreferrer noopener"/,
        `${file.pathname.split("/").pop()} opens a new tab without rel="noreferrer noopener"`
      );
    }
  }
});

test("the limits page states the boundaries the README also states", async () => {
  const limits = await read("app/docs/limits/page.tsx");
  for (const claim of [
    /not exactly-once/i,
    /depends entirely on your provider/i,
    /forward write, not a rollback/i,
    /One action per transaction/i,
  ]) {
    assert.match(limits, claim);
  }
});
