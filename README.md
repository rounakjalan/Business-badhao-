# Business Badhao

AI-powered customer acquisition platform for growing businesses.

This repository contains:

- **Phase 1 — Application foundation**: the Next.js project setup, routing
  structure, and UI shell.
- **Phase 2 — Authentication and Supabase data foundation**: Supabase Auth
  (sign up / sign in / sign out / protected routes), the multi-tenant
  organization model, the full database schema with Row Level Security, and
  a dashboard wired to real (empty-by-default) data.
- **Dashboard redesign**: a full dark-theme UI (design system ported from a
  Figma Make prototype) covering every dashboard page — including two new
  sections, Prospects and Tasks — all wired to real Supabase data. See
  [Dashboard UI](#dashboard-ui) below for what's real vs. previewed.

It does **not** yet include AI agents, lead discovery/scraping, outreach
providers (email/SMS/WhatsApp), payments, or analytics logic — those are
later phases. Where the redesign's source material showed AI features
(campaign planning, reply generation, deal analysis), this app shows an
honest interactive **preview** of the UI/UX with a clear label — it never
calls a real AI provider or writes fabricated AI output into the database.

## Tech stack

- [Next.js](https://nextjs.org) (App Router)
- TypeScript
- Tailwind CSS
- ESLint
- [Supabase](https://supabase.com) — PostgreSQL database, authentication,
  and Row Level Security, accessed via `@supabase/ssr` (the current
  recommended package for Supabase Auth in Next.js Server Components,
  Server Actions, Route Handlers, and Proxy/Middleware)

## Architecture at a glance

- **Multi-tenant from day one.** Every piece of business data belongs to an
  `organization`. A user can be a member of one or more organizations via
  `organization_members`, with a role of `owner`, `admin`, or `member`.
- **Tenant isolation is enforced in the database**, not in application
  code. Every business table has Row Level Security enabled, and every
  policy checks organization membership through `SECURITY DEFINER` helper
  functions (`is_org_member`, `is_org_admin`, `is_org_owner`) — never by
  trusting an `organization_id` sent from the client.
- **No service-role key in the app.** The app only ever uses the public
  anon key, from both the browser and the server. Every request runs as
  the signed-in user; RLS is what actually protects the data. There is
  nothing in this codebase that can read across organizations.
- **AI-provider agnostic.** Nothing in the schema or app code assumes a
  specific AI vendor — `agent_runs`/`model_usage` use free-text
  `provider`/`model` columns for this reason. No AI provider is called in
  this phase.

## Local development

### 1. Install dependencies

```bash
npm install
```

### 2. Set up a Supabase project

You need a Supabase project (either the hosted [supabase.com](https://supabase.com)
or a local one via the [Supabase CLI](https://supabase.com/docs/guides/cli)).

**Option A — local Supabase stack (requires Docker):**

```bash
npx supabase start   # applies supabase/migrations/*.sql and supabase/seed.sql automatically
npx supabase status   # prints your local API URL and anon key
```

**Option B — hosted Supabase project:**

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push   # applies supabase/migrations/*.sql
```

### 3. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from
`supabase status` (local) or your project's Settings → API page (hosted).
Both are safe to expose to the browser — see the comments in
`.env.example` for why. **Never** add a service-role key to this file or
to any `NEXT_PUBLIC_` variable.

### 4. Run the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Sign up, then create
an organization when prompted — you'll become its owner.

If you started the local Supabase stack, you can also sign in directly
with the seeded dev account: `dev@businessbadhao.test` / `password123`
(organization "Acme Demo Co", already populated with a sample campaign,
leads, a conversation, and a deal).

## Authentication

Implemented with `@supabase/ssr`, following the current Supabase +
Next.js App Router pattern:

- `src/lib/supabase/client.ts` — browser client (Client Components)
- `src/lib/supabase/server.ts` — server client (Server Components, Server
  Actions, Route Handlers), backed by `next/headers` cookies
- `src/lib/supabase/middleware.ts` + `src/proxy.ts` — refreshes the
  session on every request and enforces the public/protected route
  boundary *before* any page code runs (Next.js 16 renamed the
  `middleware.ts` convention to `proxy.ts`; this app uses the current name)
- `src/app/auth/actions.ts` — `signIn` / `signUp` / `signOut` Server
  Actions
- `src/app/auth/callback/route.ts` — exchanges an email confirmation /
  magic link code for a session (also the landing spot for OAuth later)

Routes under `/dashboard`, `/campaigns`, `/leads`, `/conversations`,
`/deals`, `/analytics`, `/knowledge`, `/settings`, and `/onboarding` are
protected: an unauthenticated request is redirected to
`/login?redirectTo=<original path>`. `/login` and `/signup` redirect
already-authenticated users to `/dashboard`. The `(dashboard)` layout
re-checks the session server-side as defense-in-depth, then checks for an
organization membership and redirects to `/onboarding` if none exists.

Only email/password auth is wired up in this phase. OAuth was
intentionally left out per the Phase 2 brief, but the architecture doesn't
need to change to add it later — `/auth/callback` already handles a code
exchange, which is the same flow an OAuth provider redirect would use.

## Database

### Schema

All tables live in `supabase/migrations/`, applied in order:

| Migration | Contents |
|---|---|
| `..._extensions_and_helpers.sql` | extensions, `org_role` enum, shared `updated_at` trigger |
| `..._organizations_profiles_members.sql` | `organizations`, `profiles`, `organization_members`, the new-user → profile trigger, and the RLS helper functions |
| `..._campaign_foundation.sql` | `business_goals`, `ideal_customer_profiles`, `campaigns` |
| `..._leads_foundation.sql` | `lead_sources`, `prospects`, `leads`, `contacts`, `lead_research`, `lead_scores` |
| `..._outreach_and_conversations.sql` | `outreach_campaigns`, `conversations`, `messages`, `conversation_events` |
| `..._deals.sql` | `deals`, `deal_events`, `loss_analysis`, `recovery_attempts` |
| `..._agents_ops_audit.sql` | `agent_runs`, `agent_actions`, `tasks`, `model_usage`, `audit_logs` |
| `..._create_organization_rpc.sql` | `create_organization_with_owner()`, an atomic RPC used by onboarding |
| `..._dashboard_design_fields.sql` | `deals.probability`, a `negotiation` deal status, `leads.intent`/`next_action`, `campaigns.target_audience` |

Every business-owned table has `organization_id`, UUID primary keys,
`created_at`/`updated_at`, foreign keys to its related entities, and
indexes on `organization_id` plus whichever of `status` /
`campaign_id` / `lead_id` / `conversation_id` / `deal_id` /
`created_at` apply to it. Status-like columns use `text` + `CHECK`
constraints rather than native enums (except `organization_members.role`,
which is a real enum) — this keeps adding a new status a one-line
migration instead of an enum-alteration.

The conceptual flow the schema supports:

```
organization → business_goal → campaign → ideal_customer_profile
  → prospect → lead → lead_research → lead_score
  → outreach_campaign → message → conversation
  → deal → deal_event → (won/lost) → loss_analysis / recovery_attempts
```

`prospects` (raw, unqualified data) is deliberately kept separate from
`leads` (the tracked, working entity) so future scraping/discovery can
write to `prospects` without touching qualification state.

### Row Level Security

Every table has RLS enabled. Tenant isolation is enforced entirely by
policies that check organization membership — never by trusting a
client-supplied `organization_id`. The core pattern:

```sql
create policy "Members can view leads"
  on public.leads for select
  to authenticated
  using (public.is_org_member(organization_id));
```

`is_org_member` / `is_org_admin` / `is_org_owner` are `SECURITY DEFINER`
functions that query `organization_members` directly, bypassing that
table's own RLS. This is required to avoid infinite recursion (a policy on
`organization_members` that queries `organization_members` to check
membership would otherwise recurse into itself) — this is the
Supabase-recommended pattern for membership-based multi-tenant RLS.

Notable non-default policies:

- **Organization bootstrap.** A brand-new organization has no members yet,
  so the usual `is_org_member` check can't be used to let its creator add
  themselves. A dedicated policy allows exactly one bootstrap insert (the
  creator adding themselves as `owner`, and only while the org has zero
  members) before falling back to "an existing admin/owner can add
  members." In practice, organization creation goes through the
  `create_organization_with_owner()` RPC instead (see below), but the
  direct-insert policy remains as a safety net and is exercised by the
  test suite.
- **`audit_logs` is read-only for end users.** Only org admins/owners can
  `select` from it, and there is no `insert`/`update`/`delete` policy for
  the `authenticated` role at all — writes must come from a trusted server
  context (a `SECURITY DEFINER` function or the service role) added in a
  later phase. No audit-writing code exists yet.
- **`create_organization_with_owner(org_name)`** is a `SECURITY DEFINER`
  RPC that creates the organization row and the creator's owner membership
  row in one transaction, avoiding a race where the first insert succeeds
  and the second fails, orphaning the organization. It only ever acts on
  `auth.uid()` with a hardcoded `owner` role, so it can't be used to act on
  anyone else's behalf.

No policy anywhere uses `USING (true)`.

### Testing the database layer

```bash
npm run test:rls
```

This applies every migration to a scratch Postgres database (with a
minimal stand-in for Supabase's `auth` schema — see
`scripts/dev/pg-auth-stub.sql`) and runs the assertions in
`supabase/tests/*.test.sql`, which simulate two separate organizations and
verify:

- a user only ever sees their own organization's rows (`organizations`,
  `campaigns`, `leads`, `deals`, `conversations`, `organization_members`)
- a user cannot insert data into another organization
- a user cannot add themselves to another organization
- `audit_logs` cannot be written by the `authenticated` role, and can only
  be read by an org admin/owner (not a plain member)
- `create_organization_with_owner()` atomically creates an org and its
  owner membership, and can be called again to bootstrap a second,
  independent organization

This runs against plain Postgres (no Docker required) for fast iteration.
For a higher-fidelity check against the real Supabase stack (real GoTrue
auth, real PostgREST), use `supabase test db` instead, which requires
Docker.

### Types

`src/types/database.types.ts` mirrors the migrations in the same shape
`supabase gen types typescript` produces (`Database["public"]["Tables"][...]`
with `Row`/`Insert`/`Update`/`Relationships`). Once this project is linked
to a live Supabase project, regenerate it instead of hand-editing:

```bash
npm run db:types
```

### Seed data (local development only)

`supabase/seed.sql` is applied automatically by `supabase db reset` /
`supabase start` — both of which only ever touch your local Docker
Postgres instance. It is not part of `supabase db push` and is never
applied to a linked remote project. It seeds one confirmed dev user
(`dev@businessbadhao.test` / `password123`), an organization they own, and
a small amount of sample campaign/lead/conversation/deal data so the
dashboard has something real to render locally.

## Dashboard UI

The dashboard shell (`src/components/layout/dashboard-shell.tsx`,
`sidebar.tsx`) and every page under `src/app/(dashboard)/` use a dark
navy/indigo design system (`src/app/globals.css`'s `bb-*` tokens; Fraunces
for headings, Outfit for body text, JetBrains Mono for numbers), matching
a Figma Make prototype the product design was built from. Shared pieces
live in `src/components/dashboard-ui/` (`Badge`, `DarkCard`,
`DarkEmptyState`, `DataTable`, `DashButton`, `DarkAlert`).

**What's real, wired to Supabase:**

- `/dashboard` — live counts and a real acquisition funnel
  (`src/lib/dashboard.ts`), recent leads, open tasks, open deals
- `/campaigns`, `/campaigns/[id]`, `/campaigns/create` — real list, detail
  (with real linked conversations/deals), and a working create form
- `/leads`, `/leads/[id]` — real list and detail, including real research,
  conversations, tasks, deals, and an editable notes field
- `/prospects` — **new route**, backed by the `prospects` table
- `/conversations`, `/conversations/[id]` — real list and detail; replies
  are recorded as real `messages` rows, but nothing is sent externally (no
  outreach provider is connected — see the in-app notice on the compose box)
- `/deals`, `/deals/[id]` — real pipeline/list views; "Mark Won"/"Mark
  Lost" and the loss-reason picker write real `deals`/`deal_events`/
  `loss_analysis` rows
- `/tasks` — **new route**, backed by the `tasks` table, with working
  create/complete actions
- `/settings` — real profile and organization data, plus a real
  organization members list

**What's an honest preview, not a real feature:** anywhere the source
design showed an AI capability that doesn't exist yet (the campaign
AI-planner step, lead discovery, deal/loss analysis), this app shows the
same interactive UI clearly labeled as a preview — a client-side demo with
canned example content, never a real provider call, and nothing it
produces is written to the database. Settings sections with no backing
system yet (AI behavior toggles, notifications, integrations, security
sessions, danger zone) are visually complete but inert, matching how
Phase 1/2 already marked unbuilt features "Coming soon." `/analytics` is
now computed from real aggregate counts; `/knowledge` remains a static
placeholder since there's no knowledge-base table yet.

Two small additive schema fields were added to support the design:
`deals.probability` (nullable 0–100), a `negotiation` deal status,
`leads.intent`/`leads.next_action`, and `campaigns.target_audience` — see
`supabase/migrations/20260816130000_dashboard_design_fields.sql`.

Errors while loading a dashboard route are caught by
`src/app/(dashboard)/error.tsx` (a friendly retry state, not a stack
trace), and `src/app/(dashboard)/loading.tsx` shows a skeleton while data
is fetched.

## Project structure

```
src/
  app/
    page.tsx                     Public landing page ("/") — light theme
    login/, signup/               Auth pages (Server Action forms) — light theme
    auth/actions.ts               signIn / signUp / signOut Server Actions
    auth/callback/route.ts        Email confirmation / OAuth code exchange
    onboarding/                   "Create your organization" (first login)
    (dashboard)/                  Route group sharing the dark dashboard shell
      layout.tsx                  Enforces auth + organization membership
      error.tsx, loading.tsx      Shared error/loading states
      dashboard/                   "/dashboard" — live stats, funnel, activity
      campaigns/                   list, [id] detail, create — real + a real form
      leads/                       list, [id] detail — real, editable notes
      prospects/                   "/prospects" — new, real prospects table
      conversations/                list, [id] detail — real messages (internal only)
      deals/                        list/pipeline, [id] detail — real won/lost actions
      tasks/                        "/tasks" — new, real create/complete
      analytics/                    real aggregate funnel/campaign/source stats
      knowledge/                    static placeholder (no backing table yet)
      settings/                     real profile/org + sectioned settings UI
  components/
    layout/                       Sidebar, dashboard shell, global search, page header
    dashboard-ui/                 Badge, DarkCard, DarkEmptyState, DataTable,
                                   DashButton, DarkAlert — the dark design system
    ui/                           Button, Card, Alert, icons — used by the
                                   light-theme public/auth pages only
  lib/
    supabase/                     client.ts, server.ts, middleware.ts, env.ts
    organizations.ts              getCurrentOrg() — the signed-in user's org
    dashboard.ts                  Dashboard/analytics stat + funnel queries
    format.ts                     Shared date/currency/relative-time formatting
    navigation.ts                 Single source of truth for sidebar nav items
  proxy.ts                        Session refresh + route protection
  types/database.types.ts         Hand-authored, generation-shaped DB types
supabase/
  migrations/                     Schema, RLS policies, RPC (see table above)
  seed.sql                        Local dev-only seed data
  tests/*.test.sql                 RLS/tenant-isolation test suite
scripts/
  test-rls.sh                     Runs the test suite against scratch Postgres
  dev/pg-auth-stub.sql             Minimal local stand-in for Supabase's `auth` schema
```

## Scripts

```bash
npm run dev        # start the dev server
npm run build       # production build
npm run start        # run the production build
npm run lint          # run ESLint
npm run test:rls       # run the RLS/tenant-isolation test suite (no Docker required)
npm run db:types        # regenerate src/types/database.types.ts from a linked project
```

## Environment variables

See `.env.example`. Both required variables (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`) are public and safe to ship to the
browser — Supabase's security model relies on RLS, not on hiding the anon
key. This app does not use a service-role key anywhere.
