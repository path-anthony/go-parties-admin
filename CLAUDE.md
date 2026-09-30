# go-parties-admin · working rules for Claude Code

The admin command center and the API (Express + Prisma + Vite/React, one process, Railway). The customer storefront is a separate repo, `go-parties-app`; its `CLAUDE.md` and `docs/` (GO-PRODUCT, GO-ROADMAP, GO-LOG, BRAND) are the shared source of truth. Read them first. Docs-only commits to that repo's `docs/` are fine when architecture changes; never edit storefront code from here.

## Navigation rule (permanent)

The admin is built from one config, `src/nav.tsx`. The sidebar, the routes, the breadcrumb and the redirects all come from it, so adding a page is one line there.

- A section with one screen is a direct sidebar link (`path` + `element`).
- A section with two or more screens is an expandable sidebar group (`pages`). Each sub-page is its own address and gets a full page.
- No in-page tabs anywhere in admin. A long stacked page is split into sub-pages. (Filters on one list, like a status filter, are not navigation; they are buttons with `aria-pressed` or a select, never `role="tab"`.)
- Every screen has its own URL. Filters that a link needs to carry (from an Overview card, say) go in the query string, and are read by a small route component in `nav.tsx`.
- The group containing the current route opens itself on load. Each group's open or closed state is remembered per group (localStorage).
- Collapsed to icons, a group's icon opens a small flyout of its sub-pages. On narrow screens the sidebar is a drawer opened from the top bar.
- The breadcrumb at the top of each page is the nav path ("Settings / Business rules").
- Every old address, including old tab query strings, redirects to its new home. When a page moves, add the old address to `LEGACY_REDIRECTS` (or `LEGACY_TABS` for a group's old `?tab=`). Never leave a bookmark or an already-sent link broken.
- `src/nav.test.tsx` enforces this (groups have two or more pages, addresses are unique, every redirect lands on a real page). Run `npm test`.

Room is left, not built, for: Leads groups, Crew & Gigs > Bids, Settings > Account and access. (Messages > Upcoming exists, first in the Messages group.)

## How work is done here

- Node: `source ~/.nvm/nvm.sh && nvm use 20` before any npm or npx. Build gate, always with pipefail: `set -o pipefail && npx tsc -b && npx oxlint . && npm run build`.
- Production is the only database (Railway Postgres). Test rows are prefixed "ZZ ", cleaned up afterward, and the cleanup is confirmed with a count.
- Migrations: Railway does not run them on deploy (start is `tsx server/index.ts`). Apply with `npx prisma migrate deploy` before pushing code that needs them; never `migrate dev` against production. Make schema changes additive first (add columns, then drop later) so the running build keeps working.
- Writing rules for chat, code comments, commits and docs: no em dashes, no hype, plain direct sentences. Brand voice for customer-facing copy is in the storefront's `docs/BRAND.md` section 10.
- Every automated text and email goes through `sendTemplatedMessage` (`server/sendTemplated.ts`) and a trigger in `server/triggers.ts`. Do not call the Twilio or email wrappers directly for an automated message.
- Anything timed goes through the planner (`server/automation/planner.ts`). The sender, the record timelines, the Leads chips and Messages > Upcoming all read its output; never add a second place that decides what is due. New timed messages are a milestone in the planner, a trigger in the registry, and a test in `server/tests/planner.test.ts`.
- Server tests need DATABASE_URL in the environment: `npx tsx --env-file=.env --test server/tests/*.test.ts` (or `set -a; source .env; set +a` before `npm test`). They use the production database with stubbed Twilio and clean up their own rows.
