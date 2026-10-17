#!/usr/bin/env python3
"""Watch a Waitwhile location for open booking slots, alert, and optionally book.

Availability comes from Waitwhile's public API (no auth). Booking runs in your
real Chrome through browser-harness, because creating a visit needs reCAPTCHA.
"""
import argparse
import json
import random
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
API = "https://api.waitwhile.com/v2/public/visits"
TZ = ZoneInfo("America/New_York")
BOOKED_FLAG = HERE / "booked.json"


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def fetch_slots(cfg):
    now = datetime.now(TZ)
    q = {
        "fromDate": now.strftime("%Y-%m-%dT%H:%M"),
        "toDate": (now + timedelta(days=14)).strftime("%Y-%m-%dT00:00"),
        "serviceDuration": 1800,
        "serviceIds": cfg["service_id"],
    }
    url = f"{API}/{cfg['location']}/availability?{urllib.parse.urlencode(q)}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.load(r)
    return [s["date"] for s in data if s.get("numAvailableSpots", 0) > 0]


def wanted(slot, cfg):
    w = cfg.get("wanted", {})
    day, hhmm = slot.split("T")
    if w.get("dates") and day not in w["dates"]:
        return False
    if w.get("weekdays"):
        wd = datetime.strptime(day, "%Y-%m-%d").strftime("%a").lower()
        if wd not in [d.lower()[:3] for d in w["weekdays"]]:
            return False
    if w.get("earliest") and hhmm < w["earliest"]:
        return False
    if w.get("latest") and hhmm > w["latest"]:
        return False
    return True


def pretty(slot):
    return datetime.strptime(slot, "%Y-%m-%dT%H:%M").strftime("%a %d %b %I:%M %p")


def notify(cfg, title, body):
    script = f'display notification {json.dumps(body)} with title {json.dumps(title)} sound name "Glass"'
    subprocess.run(["osascript", "-e", script], check=False)
    subprocess.Popen(["afplay", "/System/Library/Sounds/Glass.aiff"])
    if cfg.get("ntfy_topic"):
        try:
            req = urllib.request.Request(
                f"https://ntfy.sh/{cfg['ntfy_topic']}",
                data=body.encode(),
                headers={"Title": title, "Priority": "urgent", "Tags": "rotating_light",
                         "Click": f"https://waitwhile.com/locations/{cfg['location']}"},
            )
            urllib.request.urlopen(req, timeout=10)
        except Exception as e:
            log(f"ntfy failed: {e}")


def book(cfg, slot):
    """Run booker.py inside browser-harness; returns (ok, output)."""
    params = {**cfg, "slot": slot}
    code = f"PARAMS = {json.dumps(params)!r}\n" + (HERE / "booker.py").read_text()
    p = subprocess.run(["browser-harness"], input=code, text=True, capture_output=True, timeout=180)
    out = (p.stdout + p.stderr).strip()
    return ("BOOKED_OK" in out, out)


def sleep_time(cfg):
    """Poll fast around :00/:30 (when a new slot enters the 12-day window), else slow."""
    if cfg.get("burst_on_half_hours", True):
        now = datetime.now(TZ)
        sec = (now.minute % 30) * 60 + now.second
        if sec >= 1797 or sec <= 45:
            return random.uniform(2, 4)
    base = cfg.get("poll_seconds", 20)
    return random.uniform(base * 0.75, base * 1.5)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--once", action="store_true", help="check once and exit")
    ap.add_argument("--test-book", metavar="SLOT", help="run booker for SLOT (e.g. 2026-10-28T18:30) and exit")
    args = ap.parse_args()
    cfg = json.loads(Path(args.config).read_text())

    if args.test_book:
        ok, out = book(cfg, args.test_book)
        print(out)
        sys.exit(0 if ok else 1)

    seen = set()
    errors = 0
    log(f"Watching {cfg['location']} / {cfg['service_name']} (auto_book={cfg.get('auto_book')}, submit={cfg.get('submit')})")
    while True:
        try:
            open_slots = [s for s in fetch_slots(cfg) if wanted(s, cfg)]
            errors = 0
        except Exception as e:
            errors += 1
            log(f"fetch error: {e}")
            # 403/429 means we're being throttled: back off hard.
            throttled = getattr(e, "code", None) in (403, 429)
            time.sleep(min(900, (120 if throttled else 15) * errors))
            continue

        new = [s for s in open_slots if s not in seen]
        seen = set(open_slots)  # forget slots that disappeared so a re-open alerts again
        if new:
            log("OPEN: " + ", ".join(pretty(s) for s in new))
            notify(cfg, f"{cfg['location']}: slot open!", ", ".join(pretty(s) for s in new))
            if cfg.get("auto_book") and not BOOKED_FLAG.exists():
                slot = new[0]
                log(f"Booking {pretty(slot)} ...")
                ok, out = book(cfg, slot)
                log(out[-2000:])
                if ok:
                    BOOKED_FLAG.write_text(json.dumps({"slot": slot, "at": datetime.now().isoformat()}))
                    notify(cfg, f"{cfg['location']}: BOOKED", pretty(slot))
                elif "HELD_NOT_SUBMITTED" in out:
                    notify(cfg, f"{cfg['location']}: slot held",
                           f"{pretty(slot)} - form filled, confirm in Chrome now")
                else:
                    notify(cfg, f"{cfg['location']}: booking failed",
                           f"{pretty(slot)} - check the Chrome tab")
        elif args.once:
            log("no open slots")

        if args.once:
            break
        time.sleep(sleep_time(cfg))


if __name__ == "__main__":
    main()
