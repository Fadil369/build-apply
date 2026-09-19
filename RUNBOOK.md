# BrainSAIT BUILD Ecosystem — Runbook

Central operations reference for the BUILD incubation ecosystem. Single source of truth for how the pieces connect, where they live, and how to operate them.

## Architecture

```
                ┌──────────────────────────────────────────────┐
                │  brainsait.org (luxury landing · CF Pages)    │
                │  → storefront + newsletter + SPARK/GTM teaser │
                └──────────────┬───────────────────────────────┘
                               │ CTA
                ┌──────────────▼───────────────────────────────┐
                │  fadil369.github.io (storefront · React)      │
                │  LEARN · BUILD · SOLUTIONS · Track · Account  │
                └──────┬──────────────────────────┬────────────┘
                       │ shopifyUrl                │ applies (/apply)
                ┌──────▼──────────┐      ┌─────────▼──────────────────┐
                │ store.brainsait │      │  build-apply.brainsait.org │ ← THE HUB
                │ .org (Shopify)  │◄────►│  (Cloudflare Worker + D1)  │
                └──────┬──────────┘      │  webhooks · cert · bot ·   │
                       │ webhooks         │  commerce · events · pixel │
                       │ orders/paid      └─┬───┬───┬───┬───┬───┬──────┘
                       │ subscriptions      │   │   │   │   │   │
        ┌──────────────▼──┐  ┌──────────┐   │   │   │   │   │   └─► R2 (build-evidence)
        │ D1 (build-students) │ Notion  │◄──┘   │   │   │   │
        └─────────────────┘  └──────────┘       │   │   │   └─► Resend (email)
        ┌─────────────────┐  ┌──────────┐       │   │   └─► Telegram (FORGE bot)
        │ Airtable mirror │  │ GitHub   │◄──────┘   └─► Hub event bus
        └─────────────────┘  └──────────┘
        ┌─────────────────┐  ┌──────────────────────────┐
        │ n8n (localhost) │  │ simulator.brainsait.org  │
        │ workflows       │  │ Browser Run screenshots  │
        └─────────────────┘  └──────────────────────────┘
        ┌─────────────────┐  ┌──────────────────────────┐
        │ Canva registry  │  │ Shopify app (extensions) │
        │ hub.brainsait.org│  │ checkout·pixel·post-purchase│
        └─────────────────┘  └──────────────────────────┘
```

## Systems

| System | URL | Type | Role |
|---|---|---|---|
| **Landing** | `brainsait.org` | CF Pages (`Fadil369/Brainsait-org`) | Luxury gateway → storefront + newsletter |
| **Storefront** | `fadil369.github.io` | CF Pages + React | LEARN/BUILD/SOLUTIONS catalog |
| **Shopify store** | `store.brainsait.org` | Shopify (Horizon theme) | Checkout, orders, subscriptions |
| **build-apply** | `build-apply.brainsait.org` | CF Worker | Central hub: apply, webhooks, cert, bot, events |
| **Simulator** | `simulator.brainsait.org` | CF Worker + Browser Run | Live screenshots of taught systems |
| **D1** | `build-students` (`59354dc7…`) | Cloudflare D1 | Central student state + events |
| **R2** | `build-evidence` | Cloudflare R2 | Evidence files, certs, screenshot cache |
| **KV** | `APPLICATIONS` (`20ed085e…`) | Cloudflare KV | Applications + certs + webhook dedup |
| **n8n** | `127.0.0.1:5678` (podman) | n8n | Workflow automation (21 workflows) |
| **Canva** | `hub.brainsait.org/canva` | Node backend | Design Registry (Airtable-backed) |
| **Shopify app** | `app.brainsait.de` | Remix + extensions | Checkout UI, web pixel, post-purchase |
| **KB** | hub MCP | vector store | 16-day curriculum embeddings |

## D1 schema (`build-students`)

- `students` — email (PK), telegram_chat_id, notion_page_id, airtable_record_id, shopify_order_id, current_day, status, total_credits, certificates_earned, created_at, updated_at
- `events` — id, event_type, student_email, payload, created_at, processed
- `reviews` — id, product_slug, rating, name, body, created_at

## Key endpoints (build-apply)

| Endpoint | Method | Purpose |
|---|---|---|
| `/apply` | POST | New application (Turnstile-gated) |
| `/webhook/shopify` | POST | `orders/paid` + `subscriptions/*` (HMAC-verified) |
| `/events/:type` | POST | Event router → D1 + fan-out |
| `/pixel` | POST | Shopify web pixel sink |
| `/recommend` | POST | Basma "which track?" (public CORS) |
| `/reviews/:slug` | GET/POST | Product reviews |
| `/designs/:day` | GET | Canva templates for a BUILD day |
| `/certificate/:ref` | GET | Certificate HTML |
| `/certificate/:ref/pdf` | GET | Certificate PDF |
| `/progress/:ref` | GET | Student progress |
| `/bot/*` | POST | Telegram bot commands |
| `/admin/stats` | GET | Aggregate stats (x-admin-token) |
| `/admin/commerce` | GET | Commerce Pulse dashboard |
| `/admin/sweep` | POST | Re-provision missed paid orders |
| `/admin/advance` | POST | Manual day-advance (simulate billing) |

## Secrets (worker — `wrangler secret put`)

`NOTION_TOKEN`, `NOTION_*_DB_ID`, `TURNSTILE_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`, `ADMIN_TOKEN`, `HUB_URL`, `HUB_KEY`, `GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, `AIRTABLE_API_KEY`(+BASE/TABLE).

Local copies live in `~/.hermes/.env`.

## Standard flows

### Enrollment (apply → paid)
1. `/apply` → KV app + Notion page + Airtable record + D1 student (status=pending)
2. Shopify `orders/paid` webhook (or `/admin/sweep` cron) → `provisionPaidApplication`
3. → KV Paid/Approved + Notion milestones + GitHub repo + D1 (status=active) + Airtable (Paid) + welcome email + Telegram

### Daily progress
1. Telegram `/bot/day` or n8n cron → curriculum message + email
2. Day completion → `advanceStudentDay` → D1 `current_day++` + Telegram ping

### Graduation (16/16)
1. `checkAndIssueCertificate` → `CERT_KEY` in KV + luxury email + hub event
2. `/certificate/:ref` + `/pdf` render the certificate

### Subscription billing
1. `subscriptions/billing_attempts/success` webhook → `advanceStudentDay` (unlocks next day)

## Operations

| Task | Command |
|---|---|
| Deploy build-apply | `cd workers/build-apply && wrangler deploy` |
| Deploy simulator | `cd workers/build-simulator && wrangler deploy` |
| Deploy storefront | `cd fadil369.github.io && npm run deploy && git push` |
| Deploy landing | edit `brainsait-org/index.html` + push (CF Pages auto) |
| Deploy Shopify app | `cd brainsait-shopify-app && shopify app deploy --allow-updates` |
| Warm simulator cache | `curl simulator.brainsait.org/admin/warm` |
| Re-provision orders | `curl -X POST build-apply/…/admin/sweep -H 'x-admin-token: …'` |
| Commerce dashboard | `curl build-apply/…/admin/commerce -H 'x-admin-token: …'` |

## Brand tokens

- Ink `#070b14` · Gold `#c9a227` / `#e9c46a` · Cyan `#29d8ff` · Text `#f4f1ea`
- Tracking: GTM `GTM-TP24GSTF` · GA4 `G-75ZCDM8R74` · Meta `850048551165707`

## Gotchas (learned the hard way)

- **KV binding is required** — `APPLICATIONS` namespace must stay in `wrangler.toml` (once removed by accident, breaking the entire enrollment flow).
- **D1 uses `prepare().bind().run()` / `.all()`** — not `execute()`.
- **`waitUntil` is on `ExecutionContext`, not `Env`** — pass `ctx` down.
- **Notion pages timeout Browser Run** — use fast URLs (storefront) for day 0 screenshots.
- **Shopify menus need `write_menus`** — not granted by default; scope added to `shopify.app.toml`.
