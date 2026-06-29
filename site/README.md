# merge-god site

The marketing + docs website for merge-god, built with [Astro](https://astro.build)
and deployed to GitHub Pages at **<https://jrepp.github.io/merge-god/>**.

## Stack

- Astro 5 (static output)
- Plain `.astro` components + scoped styles — no UI framework
- Docs rendered from the **repo-root [`docs/`](../docs/)** directory and design
  RFCs rendered from **[`docs-cms/rfcs/`](../docs-cms/rfcs/)** via content
  collections (`src/content.config.ts`).

## Develop

```bash
cd site
npm install
npm run dev      # http://localhost:4321/merge-god/
```

## Build / preview

```bash
npm run build    # outputs dist/
npm run preview  # serve the production build locally
```

## Project layout

```text
site/
├── astro.config.mjs        # site URL + base path (/merge-god)
├── public/                 # static assets (favicon)
└── src/
    ├── components/         # Header, Footer, Logo, …
    ├── layouts/            # BaseLayout, DocsLayout
    ├── lib/site.ts         # normalized base-path helper
    ├── pages/
    │   ├── index.astro     # landing page
    │   ├── design/         # docs-cms RFC index + [...slug] route
    │   └── docs/           # docs index + [...slug] route
    └── styles/global.css   # theme + design tokens
```

The markdown source for every docs page lives one level up, in
[`../docs/`](../docs/) — not under `site/`.

Design RFC pages are sourced from [`../docs-cms/rfcs/`](../docs-cms/rfcs/) and
rendered under `/design/rfcs/<slug>/`.

## Adding a docs page

1. Create `../docs/<slug>.md` (repo-root `docs/`) with frontmatter:

   ```yaml
   ---
   title: My Page
   description: One-line summary.
   group: Guides        # Getting Started | Guides | Reference | Project
   order: 13            # controls sidebar + card ordering within the group
   ---
   ```

2. Link to it from elsewhere as `./<slug>/` (relative) so it works under the
   `/merge-god/` base path.
3. `npm run dev` to preview.

## Deployment

`.github/workflows/site.yml` builds and deploys on every push to `main` that
touches `site/**`. Pull requests run the build only (no deploy). GitHub Pages
must be set to deploy from **GitHub Actions** in the repo settings.
