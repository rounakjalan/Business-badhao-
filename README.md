# Business Badhao

AI-powered customer acquisition platform for growing businesses.

This repository currently contains the **application foundation**: the
Next.js project setup, routing structure, and UI shell that later phases
will build on. It does not yet include authentication, a database
connection, or any AI/business functionality.

## Tech stack

- [Next.js](https://nextjs.org) (App Router)
- TypeScript
- Tailwind CSS
- ESLint

Supabase (PostgreSQL + auth) will be integrated in a later phase.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project structure

```
src/
  app/
    page.tsx                 Public landing page ("/")
    login/                   Login page UI ("/login") — no auth logic yet
    (dashboard)/             Route group sharing the dashboard shell
      layout.tsx             Sidebar + responsive shell
      dashboard/              "/dashboard"
      campaigns/              "/campaigns"
      leads/                  "/leads"
      conversations/          "/conversations"
      deals/                  "/deals"
      analytics/              "/analytics"
      knowledge/              "/knowledge"
      settings/               "/settings"
  components/
    layout/                  Sidebar, dashboard shell, page header
    ui/                      Button, Card, EmptyState, icons
  lib/
    navigation.ts            Single source of truth for sidebar nav items
```

Every dashboard route currently renders a placeholder/empty state only.
Business logic, data fetching, and AI provider integrations are
intentionally out of scope for this phase.

## Scripts

```bash
npm run dev      # start the dev server
npm run build    # production build
npm run start    # run the production build
npm run lint     # run ESLint
```

## Environment variables

No environment variables are required yet. When Supabase is integrated,
configuration will be provided via environment variables (never committed
to the repository) — see `.env.example` once it is added in a later phase.
