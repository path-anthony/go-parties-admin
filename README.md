# go-parties-admin

Internal admin tool for The Go Event Group. Vite + React + TypeScript
frontend, Express + Prisma API, Postgres (Railway). No auth, no routing,
no deployment in this pass — local only.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — Railway Postgres connection string
   - `ANTHROPIC_API_KEY` — Claude API key
3. `npm run db:migrate` — creates the `accounts` and `items` tables
4. `npm run db:seed` — seeds the one Account row (The Go Event Group)
5. `npm run import:inventory -- /path/to/GEG-Master-Inventory-v2.xlsx` — imports the item catalog from the master spreadsheet's "All Items" sheet. Prints a row count and flags any rows that failed or were skipped.
6. `npm run dev` — runs the Vite dev server (port 5173) and the API server (port 3001) together

## Structure

- `prisma/schema.prisma` — Account and Item models
- `prisma/seed.ts` — seeds the single Account
- `scripts/import-inventory.ts` — one-time/re-runnable spreadsheet import
- `server/` — Express API
- `src/` — React admin UI
- `data/item-import-template.csv` — bulk-import template to hand to Andy directly, documented in `data/README.md`

## Notes on the data

The source spreadsheet is messy: most rows have no fixed price (TBD, custom
quote, or a rate description like "475 per day, 650 for weekend"). The
`Item.price` column is nullable rather than inventing numbers — see
`scripts/import-inventory.ts` for exactly how each row is mapped.
