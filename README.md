# Codex Usage Dashboard

A local dashboard for tracking Codex quota windows, token history, API-equivalent token cost, and estimated model efficiency.

The dashboard runs entirely on your computer. It starts `codex app-server`, reads account-level quota information, scans local Codex session logs, and stores its own historical snapshots in SQLite.

## What it shows

- Current 5-hour usage, reset time, recent burn rate, and projected usage at reset.
- Current 7-day usage, reset time, recent burn rate, and projected usage at reset.
- Graceful handling when Codex does not report a 5-hour window. The card shows **Not reported** while older history remains stored.
- Graphs for the active 5-hour and 7-day quota windows.
- Daily token activity for the last seven days.
- Per-thread model, input tokens, cached input tokens, output tokens, total tokens, and estimated API-equivalent cost.
- Total indexed tokens and total API-equivalent cost.
- Estimated minutes per 1% of quota for each model.
- Accuracy notes that distinguish direct Codex data from calculated estimates.

## Requirements

- Node.js 22.5 or newer.
- The current Codex CLI installed and available as `codex` in your terminal.
- A working Codex login, normally through ChatGPT-managed authentication.

Check the prerequisites:

```powershell
node --version
codex --version
```

If Codex is installed but not signed in, run:

```powershell
codex login
```

## Run in development mode

Open PowerShell in this folder:

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Then open:

```text
http://localhost:5173
```

The frontend runs on port 5173 and proxies `/api` requests to the local backend on port 8787.

## Run the production build

```powershell
npm install
npm run build
npm start
```

Then open:

```text
http://localhost:8787
```

## Test the interface without Codex data

Edit `.env` and set:

```dotenv
DEMO_MODE=true
```

Restart the app. Demo mode uses generated data and does not start Codex App Server or read local session logs.

## Configuration

Copy `.env.example` to `.env`. Supported values:

| Variable | Default | Purpose |
|---|---:|---|
| `CODEX_BIN` | `codex` | Codex executable or full path to it. |
| `CODEX_HOME` | `~/.codex` | Folder containing Codex sessions and archived sessions. |
| `RATE_LIMIT_POLL_MS` | `60000` | Account quota polling interval. |
| `ACCOUNT_USAGE_POLL_MS` | `900000` | Account daily-token summary polling interval. |
| `SESSION_SCAN_MS` | `120000` | Local session-log scan interval. |
| `DEMO_MODE` | `false` | Use generated sample data. |
| `PORT` | `8787` | Backend and production-web port. |
| `DEBUG_CODEX_DASHBOARD` | `false` | Print App Server and parser diagnostics. |

On Windows, `CODEX_HOME` can be written as:

```dotenv
CODEX_HOME=C:\Users\YourName\.codex
```

## Project structure

```text
codex-usage-dashboard/
├─ config/
│  └─ pricing.json              API token prices and model aliases
├─ server/
│  ├─ codex/
│  │  ├─ AppServerClient.ts     JSON-RPC client for codex app-server
│  │  └─ normalize.ts           Compatibility layer for App Server payloads
│  ├─ analytics.ts              Trend, projection, and efficiency calculations
│  ├─ db.ts                     Local SQLite schema and queries
│  ├─ demo.ts                   Generated UI test data
│  ├─ index.ts                  Express API, polling, and static hosting
│  ├─ pricing.ts                API-equivalent cost calculation
│  ├─ sessionLogs.ts            Best-effort local Codex JSONL parser
│  └─ types.ts                  Backend data types
├─ src/
│  ├─ App.tsx                   Dashboard components and charts
│  ├─ api.ts                    Frontend API calls
│  ├─ styles.css                Design system and responsive layout
│  └─ types.ts                  Frontend data types
├─ .env.example
├─ package.json
└─ vite.config.ts
```

The generated database is stored at:

```text
data/codex-usage.sqlite
```

Delete that file only when you intentionally want to erase the dashboard's collected history.

## How the data works

### Quota windows

The backend calls these documented Codex App Server methods:

- `account/read`
- `account/rateLimits/read`
- `account/usage/read`

It also listens for `account/rateLimits/updated` and immediately refreshes the full snapshot.

The app identifies windows by `windowDurationMins`, not by their position in the response:

- approximately `300` minutes → 5-hour window
- approximately `10080` minutes → 7-day window

This avoids assuming that `primary` always means one specific window. When the 5-hour window is missing, the application does not invent a value.

### Projections

For each active quota window, the backend fits a linear trend to recent local snapshots. It calculates:

- percent used per hour
- projected percentage at reset
- estimated time the quota would reach 100%
- pace compared with the rate required to last until reset
- confidence based on the number and time span of collected samples

The projection is an estimate. The reported `usedPercent` and `resetsAt` values remain the authoritative values.

### Thread tokens and models

The session scanner reads JSONL files under:

```text
~/.codex/sessions
~/.codex/archived_sessions
```

It looks for incremental token-usage events, model metadata, timestamps, working directory, thread ID, and the first user prompt. This parser is intentionally isolated in `server/sessionLogs.ts` because local log formats can change.

The parser can recover prior usage only when the corresponding local session files still exist and contain incremental usage records. It does not invent missing tokens. A thread whose model cannot be matched to `config/pricing.json` remains visible, but its price is excluded from the total.

### API-equivalent cost

The cost is an estimate of what the observed text tokens would cost at the public API rate. It is **not** an amount charged to the ChatGPT subscription.

The calculator separates:

- uncached input tokens
- cached input tokens
- output tokens

For supported long-context models, a request whose input exceeds the configured threshold uses the configured long-context multiplier. Prices and aliases are stored in `config/pricing.json` so they can be updated without changing the application code.

`reasoningOutputTokens` is displayed separately when available, but is not added again to cost if it is already included in output-token accounting.

### Minutes per 1% by model

Codex does not directly attribute account quota percentage to individual models. The dashboard estimates this metric by correlating:

1. changes between adjacent quota snapshots, and
2. locally observed token events during the same interval.

When multiple models were active in one interval, the quota change is divided using estimated API cost as the weight, falling back to token count when cost is unavailable. Treat this graph as comparative rather than exact. It improves after the dashboard has run through several usage intervals.

## Accuracy limits

- No application can reconstruct old quota-percentage snapshots that were never recorded. Historical quota graphs begin when this dashboard starts collecting data.
- `account/usage/read` may provide older daily token buckets, depending on the account and authentication mode.
- A separate dashboard does not automatically receive every live per-thread event from another Codex client, so local session logs are used for thread accounting.
- Token totals do not convert directly into ChatGPT quota percentage. Model, caching, reasoning, tools, images, and Codex service accounting can affect quota use.
- API-equivalent prices can become outdated. Review `config/pricing.json` after model or pricing changes.

## Updating Codex safely

The dashboard does not modify the official Codex interface, so normal UI updates do not affect it. App Server or local session-log changes can require adjustments.

To limit update breakage:

1. Keep all App Server payload handling in `server/codex/`.
2. Keep all local-log assumptions in `server/sessionLogs.ts`.
3. Ignore unknown fields and tolerate missing optional fields.
4. Test an updated Codex version with `npm run typecheck`, `npm run build`, and a manual refresh.
5. When needed, generate schemas from the installed Codex version with Codex App Server's schema-generation command and compare them with the adapter types.

The dashboard's React components, database, projections, and charts should normally remain unchanged when the Codex protocol evolves.

## Useful commands

```powershell
npm run dev        # Backend and frontend with live reload
npm run typecheck  # TypeScript checks for both sides
npm run build      # Compile backend and production frontend
npm start          # Run the compiled production application
```

## Troubleshooting

### `codex` is not recognized

Set an absolute executable path in `.env`:

```dotenv
CODEX_BIN=C:\path\to\codex.exe
```

### Dashboard says Codex is disconnected

Run `codex` directly first and confirm it is signed in. Set `DEBUG_CODEX_DASHBOARD=true`, restart the dashboard, and inspect the terminal output.

### No local threads appear

Confirm `CODEX_HOME` points to the folder containing `sessions` or `archived_sessions`. Create or finish a Codex thread, wait for the next scan, and press the refresh button.

### A model has no estimated price

Add an entry or alias to `config/pricing.json`, then restart the backend. Keep the price date current.

### SQLite warning on Node 22

Node 22 may print an experimental warning for its built-in SQLite module. The dashboard still works. Newer Node releases may no longer print that warning.

## Official protocol references

- Codex App Server README: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- OpenAI API model pricing: https://developers.openai.com/api/docs/models
