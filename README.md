# go-parties-admin

Internal admin tool for The Go Event Group. Vite + React + TypeScript
frontend, Express + Prisma API, Postgres (Railway). No auth, no routing,
no deployment in this pass — local only.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — Railway Postgres connection string
   - `ANTHROPIC_API_KEY` — Claude API key
3. `npm run dev` — runs the Vite dev server (port 5173) and the API server (port 3001) together
