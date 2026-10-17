# waitwhile-autobooker

A 24/7 monitor and auto-booker for appointment slots on [Waitwhile](https://waitwhile.com),
built to get a Personal Shopping appointment at a store whose calendar was always fully booked.
It runs serverless on a Cloudflare Worker. It polls availability every ~7 seconds, books a slot
over HTTP when one opens, and sends phone push alerts.

## Quick start with an AI coding agent

Paste this into Claude Code, Codex, Cursor or any coding agent. It will set the project up
for your store and deploy it:

```text
Set up https://github.com/paablobello/waitwhile-autobooker for me and deploy it.

1. Clone the repo and read README.md and cloud/src/index.js to understand how it works.
2. Ask me for:
   - the Waitwhile link of the store I want (waitwhile.com/locations/<slug>)
   - which service, the dates I want, and the earliest/latest time if I care
   - party size, my full name, email, phone, and guest names if the form asks for them
   - whether it should book automatically or only alert me
3. Call GET https://api.waitwhile.com/v2/public/locations/<slug> to get the store's
   time zone, its services (show me the list and let me pick), the service duration,
   and the booking form fields. Tell me if the store needs anything the code doesn't fill.
4. Fill in [vars] in cloud/wrangler.toml. Pick a long random NTFY_TOPIC and tell me
   how to subscribe to it in the ntfy phone app, then send a test push.
5. Help me log in to Cloudflare (npx wrangler login), create the KV namespace, and
   set the secrets. Let me type CAPMONSTER_KEY (and TWOCAPTCHA_KEY if I have one)
   myself; never print or commit my keys. Set PROBE_TOKEN to a random string.
6. Deploy, then call /probe?t=<PROBE_TOKEN> to check that a captcha is accepted
   (it uses a date that can't be booked, so nothing gets booked).
7. Check the Worker URL and the logs to confirm it is polling, and explain how to stop it
   (npx wrangler delete) once I have my appointment.
```

## How it works

```
Cloudflare cron (every minute)
  └─ ~53 s loop, poll every 6.5–8.5 s
       ├─ GET  /v2/public/visits/{location}/first-available-slots   (light check)
       ├─ GET  /v2/public/visits/{location}/availability             (full check, every 5 min)
       └─ slot in wanted dates?
            ├─ push "slot open" (ntfy)          ┐ run in parallel
            └─ POST /v2/public/visits/{id}       ┘ with reCAPTCHA token
                 └─ push "BOOKED <day time>"  → stop
```

- **Reverse-engineered API.** I mapped the booking flow of the Waitwhile web app: public
  availability endpoints, the visit-creation payload, dynamic form fields read from the
  location config, and validation order (schema → captcha → slot).
- **reCAPTCHA.** Tokens come from a solving service. The chain is CapMonster v3 (~10 s),
  then CapMonster v2, then 2captcha v2. It retries only when the captcha is rejected.
- **Token prewarm.** During store hours it keeps a fresh v3 token ready, so a booking takes
  ~1–8 s from the moment a slot appears instead of ~20 s.
- **Free-tier engineering.** The Worker fits Cloudflare's 10 ms CPU limit by using a
  lightweight endpoint for most polls. It writes to KV only when state changes (the free tier
  allows 1000 writes/day). A KV lock with TTL prevents double bookings.
- **Observability.** A healthchecks.io heartbeat runs every minute. It sends an alert when
  the API blocks the Worker (403/429) or returns an empty schedule. Captcha balance and a
  captcha self-test are checked periodically. A `/probe` route tests the full booking path
  against a date that cannot be booked.

## Layout

| Path | What |
|---|---|
| `cloud/src/index.js` | The Cloudflare Worker: monitor, booker, alerts, health checks |
| `cloud/wrangler.toml` | Config: location, service, dates, person data |
| `monitor.py` | First local version (Python poller plus macOS/ntfy notifications) |
| `booker.py` | Local browser-automation booker, using a real Chrome over CDP |

## Setup (Cloudflare)

```bash
cd cloud
npx wrangler kv namespace create STATE        # put the id in wrangler.toml
npx wrangler secret put CAPMONSTER_KEY
npx wrangler secret put PROBE_TOKEN           # any random string
npx wrangler secret put HC_URL                # optional healthchecks.io ping URL
npx wrangler deploy
```

## Use it for any Waitwhile store

Everything store-specific is set in `[vars]` in `wrangler.toml`:

| Var | Example | Notes |
|---|---|---|
| `LOCATION` | `chromehearts` | The slug in `waitwhile.com/locations/<slug>` |
| `TIMEZONE` | `America/New_York` | The store's time zone; slots are in store-local time |
| `LABEL` | `Chrome Hearts` | Name shown in alerts |
| `SERVICE_ID` | `WHmj...` | From `GET api.waitwhile.com/v2/public/locations/<slug>` (`services`) |
| `SERVICE_DURATION` | `1800` | Service length in seconds |
| `DATES` | `2026-10-21,2026-10-22` | Days you want |
| `PARTY_SIZE`, `PERSON_*` | | Booking details |
| `AUTO_BOOK` | `true` | `false` sends alerts only |
| `PREWARM_HOURS` | `10-22` | Store-local hours to keep a captcha token ready |

The booking form is built automatically from the store's own form fields, so no
per-store code is needed. Install the ntfy app and subscribe to your `NTFY_TOPIC`.

## Disclaimer

This is a personal project for learning and portfolio purposes. Automated booking may break
the terms of service of the platform you use it on. Use it responsibly.
