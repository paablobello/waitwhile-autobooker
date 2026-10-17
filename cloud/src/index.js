// Cloudflare Worker: checks Waitwhile availability on a cron, pushes new open
// slots to ntfy, and books the first one over plain HTTP. reCAPTCHA tokens come
// from 2captcha (v3 first; v2 fallback, same as the web app's own retry).

const API = "https://api.waitwhile.com";
const SITEKEY_V3 = "6LfGdiEaAAAAAG5g6cu2j-r4SlU_dYRXQix2-jio";
const SITEKEY_V2 = "6LcajT0UAAAAALw2RycoZHE2YEtgDBIuoBvXrrtY";
const HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: "https://waitwhile.com",
  Referer: "https://waitwhile.com/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Store-local "YYYY-MM-DDTHH:MM" (Waitwhile slots are in the location's time zone).
function storeNow(offsetMs = 0, tz = globalThis.TIMEZONE || "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(Date.now() + offsetMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function pretty(slot) {
  const [d, t] = slot.split("T");
  const day = new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });
  let [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${day} ${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

// Light poll: same endpoint the booking page uses; returns [] when nothing is free.
async function firstSlots(env) {
  const dates = env.DATES.split(",").map((s) => s.trim()).filter(Boolean).sort();
  const now = storeNow();
  const startDay = `${dates[0]}T00:00`;
  const last = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() + 1);
  const q = new URLSearchParams({
    fromDate: now > startDay ? now : startDay,
    toDate: `${last.toISOString().slice(0, 10)}T00:00`,
    maxNumSlots: "5",
    serviceDuration: String(env.SERVICE_DURATION || 1800),
    partySize: env.PARTY_SIZE || "1",
    serviceIds: env.SERVICE_ID,
  });
  const r = await fetch(`${API}/v2/public/visits/${env.LOCATION}/first-available-slots?${q}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`waitwhile ${r.status}`);
  const data = await r.json().catch(() => null);
  if (!Array.isArray(data)) throw new Error("respuesta no valida de Waitwhile (posible bloqueo/challenge)");
  return data
    .filter((s) => s.numAvailableSpots > 0 && dates.includes(s.date.split("T")[0]))
    .map((s) => s.date);
}

async function openSlots(env) {
  const dates = env.DATES.split(",").map((s) => s.trim()).filter(Boolean);
  const last = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() + 1);
  const from = storeNow();
  const q = new URLSearchParams({
    fromDate: from,
    toDate: `${last.toISOString().slice(0, 10)}T00:00`,
    serviceDuration: String(env.SERVICE_DURATION || 1800),
    serviceIds: env.SERVICE_ID,
  });
  const r = await fetch(`${API}/v2/public/visits/${env.LOCATION}/availability?${q}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`waitwhile ${r.status}`);
  const data = await r.json().catch(() => null);
  if (!Array.isArray(data)) throw new Error("respuesta no valida de Waitwhile (posible bloqueo/challenge)");
  // The store has ~16 half-hour slots a day, booked or not. An empty list while
  // our dates are still ahead means a silent block, not "no appointments".
  const remainingDays = dates.filter((d) => d >= from.slice(0, 10)).length;
  if (remainingDays > 1 && data.length === 0) throw new Error("Waitwhile devuelve 0 horarios (posible bloqueo silencioso)");
  return data
    .filter((s) => s.numAvailableSpots > 0 && dates.includes(s.date.split("T")[0]))
    .map((s) => s.date);
}

const label = (env) => env.LABEL || env.LOCATION;

async function push(env, title, body, priority = "urgent") {
  // JSON publish: titles may contain non-ASCII text, which raw headers can't carry.
  const prio = { urgent: 5, high: 4, default: 3 }[priority] ?? 3;
  await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message: body, priority: prio,
      tags: ["rotating_light"], click: `https://waitwhile.com/locations/${env.LOCATION}` }),
  });
}

// ---- captcha solvers -------------------------------------------------------------

const PROVIDERS = {
  capmonster: { url: "https://api.capmonster.cloud", key: "CAPMONSTER_KEY", v2: "RecaptchaV2Task", v3: "RecaptchaV3TaskProxyless" },
  twocaptcha: { url: "https://api.2captcha.com", key: "TWOCAPTCHA_KEY", v2: "RecaptchaV2TaskProxyless", v3: "RecaptchaV3TaskProxyless" },
};

// firstWait: background prewarm solves wait longer before polling to save CPU.
async function solveWith(env, provider, version, action, firstWait = 2500) {
  const pv = PROVIDERS[provider];
  const clientKey = env[pv.key];
  if (!clientKey) throw new Error(`${provider}: no key`);
  const websiteURL = `https://waitwhile.com/locations/${env.LOCATION}/details`;
  const task = version === "v3"
    ? { type: pv.v3, websiteURL, websiteKey: SITEKEY_V3, pageAction: action, minScore: 0.9 }
    : { type: pv.v2, websiteURL, websiteKey: SITEKEY_V2 };
  const created = await (await fetch(`${pv.url}/createTask`, {
    method: "POST", body: JSON.stringify({ clientKey, task }),
  })).json();
  if (created.errorId) throw new Error(`${provider} create: ${created.errorCode}`);
  for (let i = 0; i < 60; i++) {
    await sleep(i === 0 ? firstWait : i < 4 ? 2500 : 4000);
    const res = await (await fetch(`${pv.url}/getTaskResult`, {
      method: "POST", body: JSON.stringify({ clientKey, taskId: created.taskId }),
    })).json();
    if (res.errorId) throw new Error(`${provider} result: ${res.errorCode}`);
    if (res.status === "ready") return res.solution.gRecaptchaResponse;
  }
  throw new Error(`${provider} timeout`);
}

// Try providers in env.CAPTCHA_ORDER (e.g. "capmonster,twocaptcha") until one returns a token.
async function solve(env, version, action, only) {
  const order = only ? [only] : (env.CAPTCHA_ORDER || "capmonster,twocaptcha").split(",");
  let lastErr;
  for (const p of order) {
    try {
      return await solveWith(env, p.trim(), version, action);
    } catch (e) {
      lastErr = e;
      console.log("captcha", e.message);
    }
  }
  throw lastErr;
}

// ---- booking ----------------------------------------------------------------

async function buildPayload(env, slot) {
  const loc = await (await fetch(`${API}/v2/public/locations/${env.LOCATION}`, { headers: HEADERS })).json();
  const [first, ...rest] = env.PERSON_NAME.trim().split(/\s+/);
  const dataFields = (loc.dataFieldsData || [])
    .filter((f) => f.isActive && f.isActiveBooking && f.isPublic !== false)
    .filter((f) => !f.supportedServiceIds?.length || f.supportedServiceIds.includes(env.SERVICE_ID))
    .map((f) => {
      const name = (f.name || "").toLowerCase();
      if (f.inputType === "CHOICE") {
        const yes = (f.inputOptions || []).find((o) => /^yes$/i.test(o)) ?? f.inputOptions?.[0];
        return { id: f.id, values: yes ? [yes] : [] };
      }
      if (name.includes("guest")) return { id: f.id, values: [env.PERSON_GUESTS || "N/A"] };
      return { id: f.id, values: [] };
    });
  const payload = {
    locale: "en-US",
    source: "PUBLIC",
    serviceIds: [env.SERVICE_ID],
    date: slot,
    duration: Number(env.SERVICE_DURATION || 1800),
    state: "BOOKED",
    partySize: Number(env.PARTY_SIZE || 1),
    firstName: first,
    lastName: rest.join(" "),
    email: env.PERSON_EMAIL,
    phone: env.PERSON_PHONE,
    dataFields,
  };
  // The web app tags bookings made <24h ahead as CONFIRMED.
  if (slot < storeNow(864e5)) payload.addTag = "CONFIRMED";
  return { payload, locationId: loc.id };
}

async function postVisit(locationId, payload, token) {
  const r = await fetch(`${API}/v2/public/visits/${locationId}`, {
    method: "POST", headers: HEADERS, body: JSON.stringify({ ...payload, recaptcha: token }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function book(env, slot, run = {}) {
  run.payload ??= await buildPayload(env, "PLACEHOLDER");
  const { locationId } = run.payload;
  const payload = { ...run.payload.payload, date: slot };
  if (slot < storeNow(864e5)) payload.addTag = "CONFIRMED";
  else delete payload.addTag;

  // A token solved ahead of time (see prewarm) saves the ~10 s captcha wait.
  const ready = run.token && Date.now() - run.token.at < 100000 ? await run.token.promise.catch(() => null) : null;
  if (ready) {
    run.token = null; // single use
    const res = await postVisit(locationId, payload, `v3:${ready}`);
    if (!(res.status === 403 && String(res.body.errorCode || "").startsWith("recaptcha"))) return res;
    console.log("prewarmed token rejected");
  }

  // Probes: CapMonster v3 passes (~10 s); 2captcha v3 gets 403; v2 passes on both (~35-50 s).
  const attempts = [["v3", "capmonster"], ["v2", "capmonster"], ["v2", "twocaptcha"]];
  let res = { status: 0, body: { message: "no captcha attempt succeeded" } };
  for (const [v, provider] of attempts) {
    let token;
    try {
      token = await solveWith(env, provider, v, "PUB_CREATE_VISIT");
    } catch (e) {
      console.log("captcha", e.message);
      continue;
    }
    res = await postVisit(locationId, payload, `${v}:${token}`);
    if (!(res.status === 403 && String(res.body.errorCode || "").startsWith("recaptcha"))) break;
    console.log(`${provider} ${v} rejected`);
  }
  return res;
}

const MAX_ATTEMPTS_PER_SLOT = 3;

async function tryBook(env, slots, run) {
  if (!(env.CAPMONSTER_KEY || env.TWOCAPTCHA_KEY) || env.AUTO_BOOK !== "true") return;
  if (run.booked || (await env.STATE.get("booked"))) return (run.booked = true);
  const candidates = slots.filter((s) => (run.attempts[s] || 0) < MAX_ATTEMPTS_PER_SLOT);
  if (!candidates.length || (await env.STATE.get("lock"))) return;
  await env.STATE.put("lock", "1", { expirationTtl: 120 });
  try {
    for (const slot of candidates.slice(0, 2)) {
      run.attempts[slot] = (run.attempts[slot] || 0) + 1;
      const t0 = Date.now();
      const res = await book(env, slot, run);
      console.log("book", slot, `try ${run.attempts[slot]}`, `${Date.now() - t0}ms`, res.status, JSON.stringify(res.body).slice(0, 300));
      if (res.status < 300) {
        run.booked = true;
        await env.STATE.put("booked", JSON.stringify({ slot, id: res.body.publicId || res.body.id, at: new Date().toISOString() }));
        await push(env, `${label(env)}: BOOKED ${pretty(slot)}`,
          `${pretty(slot)} (store time), party of ${env.PARTY_SIZE || 1}: ${env.PERSON_NAME}` +
          (env.PERSON_GUESTS && env.PERSON_GUESTS !== "N/A" ? ` and ${env.PERSON_GUESTS}` : "") +
          `. Confirmation sent to ${env.PERSON_EMAIL}.`);
        return;
      }
      // Only report the final failure for a slot, not every retry.
      if (run.attempts[slot] >= MAX_ATTEMPTS_PER_SLOT || res.body.errorCode === "no_available_spots") {
        run.attempts[slot] = MAX_ATTEMPTS_PER_SLOT;
        await push(env, `${label(env)}: slot lost`,
          `${pretty(slot)}: ${res.body.message || res.status}. Someone else got it first; still watching.`, "high");
      }
    }
  } catch (e) {
    await push(env, `${label(env)}: booking failed`, `${e.message} - book manually now`, "high");
  } finally {
    await env.STATE.delete("lock");
  }
}

async function checkOnce(env, run, full) {
  // Full schedule now and then (catches silent blocks); light poll otherwise.
  const slots = full ? await openSlots(env) : await firstSlots(env);
  const fresh = slots.filter((s) => !run.prev.includes(s));
  const jobs = [];
  if (fresh.length) {
    jobs.push(push(env, `${label(env)}: slot open!`, fresh.map(pretty).join(", ") + " - tap to book"));
  }
  if (slots.length) jobs.push(tryBook(env, slots, run));
  await Promise.all(jobs);
  // Only write on change: KV free tier allows 1000 writes/day.
  if (JSON.stringify(slots) !== JSON.stringify(run.prev)) {
    await env.STATE.put("open", JSON.stringify(slots));
    run.prev = slots;
  }
  return { slots, fresh };
}

// Pre-solve a captcha token during PREWARM_HOURS (store time, e.g. "10-22").
// Costs ~1 CapMonster solve per 90 s while active.
function prewarmWanted(env) {
  if (!env.PREWARM_HOURS || !env.CAPMONSTER_KEY) return false;
  const [from, to] = env.PREWARM_HOURS.split("-").map(Number);
  const h = Number(storeNow().slice(11, 13));
  return h >= from && h < to;
}

// ---- health -----------------------------------------------------------------

// Dead-man's switch: healthchecks.io alerts if these pings stop arriving.
async function heartbeat(env, ok, msg = "") {
  if (!env.HC_URL) return;
  await fetch(ok ? env.HC_URL : `${env.HC_URL}/fail`, { method: "POST", body: msg }).catch(() => {});
}

// Push once when the monitor starts failing and once when it recovers.
// KV is written only on those transitions (free tier: 1000 writes/day).
async function reportHealth(env, errors, checks) {
  const failing = await env.STATE.get("failing");
  if (checks > 0 && errors.length === checks && !failing) {
    const blocked = errors.some((e) => /waitwhile (403|429)/.test(e));
    await env.STATE.put("failing", errors[errors.length - 1]);
    await push(env, blocked ? "Monitor BLOCKED by Waitwhile" : "Monitor failing",
      `Last error: ${errors[errors.length - 1]}. Not watching; check it or book manually.`, "high");
  } else if (errors.length === 0 && failing) {
    await env.STATE.delete("failing");
    await push(env, "Monitor recovered", "Watching normally again.", "default");
  }
}

// Warn (at most once a day) when the captcha balance runs low.
async function checkBalance(env) {
  if (!env.CAPMONSTER_KEY || (await env.STATE.get("low_balance_warned"))) return;
  const r = await (await fetch("https://api.capmonster.cloud/getBalance", {
    method: "POST", body: JSON.stringify({ clientKey: env.CAPMONSTER_KEY }),
  })).json();
  if (r.errorId === 0 && r.balance < 1) {
    await env.STATE.put("low_balance_warned", "1", { expirationTtl: 86400 });
    await push(env, "CapMonster balance low", `$${r.balance.toFixed(2)} left. Top up or bookings will fail.`, "high");
  }
}

// Daily dry run of the booking captcha against a date the store can't book.
// Nothing can be created; it tells us if captchas stopped being accepted
// before a real slot shows up.
async function captchaSelfTest(env) {
  const { payload, locationId } = await buildPayload(env, "2027-03-03T03:00");
  const tried = [];
  for (const [v, provider] of [["v3", "capmonster"], ["v2", "capmonster"], ["v2", "twocaptcha"]]) {
    try {
      const token = await solveWith(env, provider, v, "PUB_CREATE_VISIT");
      const res = await postVisit(locationId, payload, `${v}:${token}`);
      if (!(res.status === 403 && String(res.body.errorCode || "").startsWith("recaptcha"))) return;
      tried.push(`${provider} ${v}: rechazado`);
    } catch (e) {
      tried.push(`${provider} ${v}: ${e.message}`);
    }
  }
  await push(env, "Captcha BLOCKED",
    `Waitwhile rejects every captcha, a real booking would fail. ${tried.join("; ")}`, "high");
}

export default {
  // Cron fires every minute; poll every ~7 s for ~55 s.
  async scheduled(event, env) {
    globalThis.TIMEZONE = env.TIMEZONE;
    const start = Date.now();
    const run = { prev: JSON.parse((await env.STATE.get("open")) || "[]"), attempts: {}, booked: false };
    run.attempts = JSON.parse((await env.STATE.get("attempts")) || "{}");
    const errors = [];
    let checks = 0;
    while (Date.now() - start < 53000) {
      if (prewarmWanted(env) && !run.booked && (!run.token || Date.now() - run.token.at > 90000)) {
        const at = Date.now();
        run.token = { at, promise: solveWith(env, "capmonster", "v3", "PUB_CREATE_VISIT") };
        run.token.promise.catch((e) => console.log("prewarm", e.message));
      }
      checks++;
      try {
        // Full schedule (heavier to parse) every 5 min is enough to catch silent blocks.
        await checkOnce(env, run, checks === 1 && new Date(event.scheduledTime).getUTCMinutes() % 5 === 0);
      } catch (e) {
        console.log("check failed", e.message);
        errors.push(e.message);
      }
      await sleep(6500 + Math.random() * 2000); // ~7 checks/run keeps CPU near the free 10 ms limit
    }
    // Keep per-slot attempt counts across runs so a dead slot isn't retried forever.
    const live = Object.fromEntries(Object.entries(run.attempts).filter(([s]) => run.prev.includes(s)));
    if (JSON.stringify(live) !== ((await env.STATE.get("attempts")) || "{}")) {
      await env.STATE.put("attempts", JSON.stringify(live));
    }
    await reportHealth(env, errors, checks);
    await heartbeat(env, errors.length < checks, errors.join("\n"));
    const at = new Date(event.scheduledTime);
    if (at.getUTCMinutes() === 0) await checkBalance(env).catch(() => {});
    if (at.getUTCMinutes() === 30 && at.getUTCHours() % 6 === 0) await captchaSelfTest(env).catch(() => {});
  },

  async fetch(req, env) {
    globalThis.TIMEZONE = env.TIMEZONE;
    // /probe?t=<PROBE_TOKEN>&v=v3|v2 : real captcha, out-of-window date. Nothing
    // can be booked: 403 = captcha rejected, any slot/date error = captcha accepted.
    const url = new URL(req.url);
    if (url.pathname === "/probe" && env.PROBE_TOKEN && url.searchParams.get("t") === env.PROBE_TOKEN) {
      const v = url.searchParams.get("v") || "v3";
      const provider = url.searchParams.get("p") || undefined;
      const { payload, locationId } = await buildPayload(env, "2027-03-03T03:00");
      const t0 = Date.now();
      const token = await solve(env, v, "PUB_CREATE_VISIT", provider);
      const res = await postVisit(locationId, payload, `${v}:${token}`);
      return Response.json({ provider, version: v, solveSeconds: (Date.now() - t0) / 1000, ...res });
    }
    if (url.pathname === "/pushtest" && env.PROBE_TOKEN && url.searchParams.get("t") === env.PROBE_TOKEN) {
      const r = await fetch("https://ntfy.sh/", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: env.NTFY_TOPIC, title: "Prueba desde Cloudflare", message: "test", priority: 2 }),
      });
      return Response.json({ status: r.status, body: await r.text() });
    }
    const slots = await openSlots(env);
    const booked = await env.STATE.get("booked");
    const failing = await env.STATE.get("failing");
    return Response.json({ now: storeNow(), healthy: !failing, lastError: failing, open: slots,
      booked: booked ? JSON.parse(booked) : null });
  },
};
