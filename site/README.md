# ZeroGate site

The public documentation surface for [`zerogate`](https://www.npmjs.com/package/zerogate): eleven static routes covering what the library guarantees, how to use it, and what it does not do.

Next.js App Router, deployed to Vercel. No database, no API routes, no runtime configuration, and no environment variables required.

## Develop

```bash
npm ci
npm run dev
```

## Verify

```bash
npm run validate
```

Runs ESLint, strict TypeScript, the production build, and the content guards in `tests/`. Those guards exist because prose drifts: they check that every route referenced by navigation exists, that no component hardcodes a colour outside the token block, that the primary call to action appears exactly twice in identical wording, that security headers are declared, and that no retired host or toolchain is referenced.

## Deploy

Vercel builds `main` on push. `next build` is the only step; there is nothing to configure.

The production origin is resolved at build time from `VERCEL_PROJECT_PRODUCTION_URL`, falling back to `NEXT_PUBLIC_SITE_ORIGIN` if you set one. No domain is hardcoded, so preview deployments describe themselves correctly.

## Security headers

Declared in `next.config.ts` and applied to every route: a strict Content-Security-Policy, HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, and a `Permissions-Policy` that denies every sensor and payment API.

Development additionally allows `unsafe-eval` and websocket connections, because React's development build and hot reload require them. Neither is shipped.

## Design

The stylesheet is token-based; components reference token names and never literal colours. Buttons are slate ink, the accent is reserved for eyebrows, links, pills, and focus rings, and nothing is heavier than weight 600. Light theme only, with `prefers-reduced-motion` respected.
