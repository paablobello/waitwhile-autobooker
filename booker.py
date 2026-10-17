# Runs inside `browser-harness` (helpers pre-imported). monitor.py prepends:
#   PARAMS = '<json config + "slot">'
# Walks the public booking flow in your real Chrome. Picking the time creates a
# pending hold on the slot, so even if the form step fails you can finish by hand.
import json
import time
from datetime import datetime

P = json.loads(PARAMS)
SLOT = P["slot"]                      # "2026-10-28T18:30"
DAY = SLOT.split("T")[0]
TIME_LABEL = datetime.strptime(SLOT, "%Y-%m-%dT%H:%M").strftime("%I:%M %p").lstrip("0")
PERSON = P["person"]
SHOT = "/tmp/waitwhile-booker.png"


def until(expr, timeout=15, step=0.25):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = js(expr)
            if v:
                return v
        except Exception:
            pass
        time.sleep(step)
    return None


def click_text(text, exact=True, timeout=10):
    cond = f"x.innerText.trim()==={json.dumps(text)}" if exact else \
        f"x.innerText.trim().toLowerCase().startsWith({json.dumps(text.lower())})"
    return until(f"""(()=>{{const e=[...document.querySelectorAll('button,a,[role=button]')]
        .find(x=>{cond} && !x.disabled); if(!e) return false; e.click(); return true}})()""", timeout)


def url():
    return page_info()["url"]


def fail(msg):
    try:
        capture_screenshot(SHOT, max_dim=1200)
    except Exception:
        pass
    print(f"BOOK_FAIL: {msg} (url={url()}, screenshot={SHOT})")
    raise SystemExit(0)


loc = P["location"]
new_tab(f"https://waitwhile.com/locations/{loc}")
wait_for_load()
if not click_text("Schedule a booking", timeout=15):
    fail("no 'Schedule a booking' button")

# Walk intermediate steps until the time page.
for _ in range(6):
    until(f"!location.pathname.endsWith('/locations/{loc}')", 8)
    time.sleep(0.4)
    u = url()
    if "/time" in u:
        break
    if "/services" in u:
        click_text(P["service_name"], exact=False) or fail("service not found")
    elif "/party-size" in u:
        click_text(str(P.get("party_size", 1))) or fail("party size button not found")
    elif "/resources" in u:
        # Pick the first resource (e.g. team member) if the location asks.
        until("""(()=>{const b=[...document.querySelectorAll('main button, button')]
            .filter(x=>x.innerText.trim() && !/^(back|cancel|powered by)/i.test(x.innerText.trim()));
            if(!b.length) return false; b[0].click(); return true})()""", 8) or fail("no resource")
    else:
        time.sleep(0.6)
else:
    fail("never reached time page")

if not until(f"""(()=>{{const d=document.querySelector('[data-cy="dateslot-{DAY}"]');
        if(!d || d.disabled) return false; d.scrollIntoView({{block:'center',inline:'center'}}); d.click(); return true}})()""", 15):
    fail(f"date {DAY} not clickable")
time.sleep(0.5)
if not click_text(TIME_LABEL, timeout=10):
    fail(f"time {TIME_LABEL} not available (taken?)")

if not until("location.pathname.includes('/details')", 20):
    fail("details form did not open")
until("document.querySelector('input[name^=form_]')", 10)
time.sleep(0.5)

FILL = r"""
((person)=>{
  const report=[];
  const setVal=(e,v)=>{const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p,'value').set.call(e,v);
    e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));
    e.dispatchEvent(new Event('blur',{bubbles:true}));};
  const labelOf=e=>(((e.labels&&e.labels[0])||{}).innerText||e.placeholder||e.name||'').toLowerCase();
  const [first,...rest]=person.name.trim().split(/\s+/);
  for (const e of document.querySelectorAll('input[name^=form_], textarea[name^=form_]')) {
    if (e.type==='checkbox'||e.type==='radio'||e.type==='hidden') continue;
    const n=e.name.toLowerCase(), l=labelOf(e); let v=null;
    if (n==='form_name'||e.autocomplete==='name') v=person.name;
    else if (n.includes('firstname')||e.autocomplete==='given-name') v=first;
    else if (n.includes('lastname')||e.autocomplete==='family-name') v=rest.join(' ');
    else if (n.includes('email')||e.type==='email') v=person.email;
    else if (n.includes('phone')||e.type==='tel') v=person.phone;
    else if (l.includes('address')) v=person.address;
    else if (l.includes('guest')) v=person.guests||'N/A';
    else if (l.includes('note')||l.includes('details')) v=person.notes;
    if (v) { setVal(e,v); report.push(e.name+'='+e.value); } else report.push(e.name+' (left empty: '+l.slice(0,40)+')');
  }
  // Acknowledgement questions: answer "Yes".
  for (const e of document.querySelectorAll('input[type=checkbox], input[type=radio]')) {
    const l=labelOf(e)+' '+(e.value||'').toLowerCase();
    if (!e.checked && (e.type==='checkbox' || /\byes\b/.test(l))) { e.click(); report.push('checked '+(e.name||e.id)); }
  }
  for (const e of document.querySelectorAll('[role=checkbox][aria-checked=false], [role=switch][aria-checked=false]')) {
    e.click(); report.push('aria-checked '+(e.id||e.innerText.slice(0,30)));
  }
  for (const e of document.querySelectorAll('[role=radio][aria-checked=false], [role=option]')) {
    if (/^\s*yes\s*$/i.test(e.innerText||e.getAttribute('aria-label')||'')) { e.click(); report.push('yes-option '+(e.id||'')); }
  }
  for (const s of document.querySelectorAll('select[name^=form_]')) {
    const o=[...s.options].find(o=>/^yes$/i.test(o.text.trim()));
    if (o && s.value!==o.value){ s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); report.push('select-yes '+s.name); }
  }
  return report.join('\n');
})
"""
print("FORM:\n" + str(js(FILL + f"({json.dumps(PERSON)})")))
time.sleep(0.6)
capture_screenshot(SHOT, full=True, max_dim=1400)

if not P.get("submit", False):
    print(f"HELD_NOT_SUBMITTED: form filled, review it in Chrome and press the button yourself. screenshot={SHOT}")
    raise SystemExit(0)

if not until("""(()=>{const b=[...document.querySelectorAll('button[type=submit], button')]
        .find(x=>/schedule booking|book|confirm|reserve/i.test(x.innerText) && !x.disabled);
        if(!b) return false; b.click(); return true})()""", 10):
    fail("submit button not found/disabled")

ok = until("location.pathname.includes('/visits/') || location.pathname.includes('/visit-groups')", 30)
if ok:
    capture_screenshot(SHOT, max_dim=1200)
    print(f"BOOKED_OK {url()}")
else:
    err = js("[...document.querySelectorAll('[role=alert], .error, [class*=rror]')].map(e=>e.innerText).filter(Boolean).join(' | ').slice(0,500)")
    fail(f"submit did not confirm; page errors: {err}")
