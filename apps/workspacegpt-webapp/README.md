# workspacegpt.in

The WorkspaceGPT website and user docs: Next.js 15 (App Router) with Tailwind v4.

| Route | File |
|---|---|
| `/` | `src/app/page.tsx`: hero, modes, features, install (`#install`), getting started |
| `/docs` | `src/app/docs/page.tsx`: the user guide, one page with anchored sections |
| `/docs/deployment` | `src/app/docs/deployment/page.tsx`: deployment automation guide |
| `/privacy`, `/support` | `src/app/privacy/page.tsx`, `src/app/support/page.tsx` |

Shared pieces are in `src/app/_components/`: `SiteNav`, `Icon` (the site's
stroke icon set; use it rather than emoji) and `Reveal` (fade-in on scroll for
`data-reveal` sections). Colour tokens (`bg-surface`, `border-line`,
`text-muted`, `text-brand`, …) are defined in `src/app/globals.css`. SEO
metadata and JSON-LD live in `src/app/layout.tsx`; see also `sitemap.ts`,
`robots.ts` and `opengraph-image.tsx`.

```bash
pnpm --filter workspacegpt-webapp dev     # http://localhost:3000
pnpm --filter workspacegpt-webapp build
```

Vercel deploys `main` to production. PRs get a preview deployment, and
`vercel.json` skips builds when nothing here changed.
