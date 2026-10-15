"""
Headless-Chromium smoke tests for site/index.html and site/admin.html in DEMO mode.
Run:  python3 site/tests/browser_test.py        (needs the `playwright` Python package + Chromium)
External requests (Google Fonts, image CDN) are stubbed so the run is offline and deterministic.
"""
import functools, http.server, json, os, socketserver, subprocess, sys, threading, re, urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SHOTS = os.environ.get('SHOTS_DIR')  # optional: where to save screenshots
WIDTHS = [375, 1440]
results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('  ✓ ' if cond else '  ✗ ') + name + ('' if cond else '  -> ' + str(detail)))


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    handler = functools.partial(Quiet, directory=ROOT)
    httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, 'http://127.0.0.1:%d' % httpd.server_address[1]


TINY_PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                         '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082')


def new_page(browser, base, width):
    ctx = browser.new_context(viewport={'width': width, 'height': 900}, locale='he-IL', timezone_id='Asia/Jerusalem',
                              accept_downloads=True)
    errors = []

    def route(r):
        url = r.request.url
        if url.startswith(base):
            return r.continue_()
        if 'fonts.googleapis' in url:
            return r.fulfill(status=200, content_type='text/css', body='')
        if re.search(r'\.(jpg|jpeg|png|webp)(\?|$)', url):
            return r.fulfill(status=200, content_type='image/png', body=TINY_PNG)
        return r.fulfill(status=204, body='')

    ctx.route('**/*', route)
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    return ctx, page, errors


def no_hscroll(page):
    return page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')


def test_public(browser, base, width):
    print('\nindex.html @ %dpx' % width)
    ctx, page, errors = new_page(browser, base, width)
    logs = []
    page.on('console', lambda m: logs.append(m.text))
    page.goto(base + '/index.html', wait_until='load')
    page.wait_for_function('window.TIK_API && window.TIK_EVENT && window.TIK_EVENT.id', timeout=5000)
    check('DEMO mode announced in console', any('מצב דמו' in l for l in logs), logs[:3])
    check('event card keeps "יפורסם בקרוב" when dateISO is null',
          'יפורסם בקרוב' in page.inner_text('[data-event="date"]'), page.inner_text('[data-event="date"]'))
    check('honeypot field injected into both forms, hidden from AT',
          page.evaluate('''['register-form','contact-form'].every(id => { const i = document.querySelector('#'+id+' [name=website]');
                const r = i && i.parentNode.parentNode.getBoundingClientRect(); return i && i.closest('[aria-hidden=true]') && i.tabIndex === -1 && r.width <= 1 && r.height <= 1; })'''))
    check('no horizontal scroll', no_hscroll(page), page.evaluate('[document.documentElement.scrollWidth, innerWidth]'))

    # registration: client validation first
    page.click('#register-submit')
    check('client validation blocks empty submit', page.get_attribute('#r-name', 'aria-invalid') == 'true')
    page.fill('#r-name', 'בודק בדיקה')
    page.fill('#r-phone', '052-765-4321')
    page.fill('#r-email', 'tester%d@example.com' % width)
    page.fill('#r-city', 'חיפה')
    page.select_option('#r-source', 'friend')
    page.check('#r-consent')
    page.click('#register-submit')
    page.wait_for_selector('#reg-step-pay:not([hidden])', timeout=5000)
    check('registration success shows the Paybox step', page.is_visible('#paybox-link'))
    check('Paybox link carries the price', 'amount=79' in (page.get_attribute('#paybox-link', 'href') or ''))
    stored = page.evaluate('JSON.parse(localStorage.getItem("tik180-demo-v1")).registrations.filter(r => r.fullName === "בודק בדיקה")')
    check('demo backend stored normalized phone', stored and stored[0]['phone'] == '0527654321', stored)

    # duplicate path → still success, heading changes
    page.reload(wait_until='load')
    page.wait_for_function('window.TIK_EVENT && window.TIK_EVENT.id')
    page.fill('#r-name', 'בודק בדיקה')
    page.fill('#r-phone', '0527654321')
    page.fill('#r-email', 'tester%d@example.com' % width)
    page.click('#register-submit')
    page.wait_for_selector('#reg-step-pay:not([hidden])', timeout=5000)
    check('duplicate registration → success with "כבר נרשמת"', 'כבר נרשמת' in page.inner_text('#reg-success-title'))

    # network error → form stays, Hebrew message
    page.reload(wait_until='load')
    page.wait_for_function('window.TIK_EVENT && window.TIK_EVENT.id')
    page.fill('#r-name', 'שגיאה בדיקה'); page.fill('#r-phone', '0531111111'); page.fill('#r-email', 'e@example.com')
    page.evaluate('TIK_API.demo.failNext()')
    page.click('#register-submit')
    page.wait_for_selector('#register-status.is-error', timeout=5000)
    check('network error keeps form + shows Hebrew error', not page.is_visible('#reg-step-pay') and 'חיבור' in page.inner_text('#register-status'),
          page.inner_text('#register-status'))

    # contact form
    page.fill('#c-name', 'רכזת בדיקה')
    page.fill('#c-phone', '0541234567')
    page.select_option('#c-org', 'school')
    page.click('label.choice:has-text("מפגש פרונטלי")')
    page.fill('#c-msg', 'בדיקה')
    page.click('#contact-submit')
    page.wait_for_selector('#contact-success:not([hidden])', timeout=5000)
    check('contact form success', page.is_visible('#contact-success-title'))

    # event set by admin with a date shows up on the page
    page.evaluate('''() => { const s = JSON.parse(localStorage.getItem("tik180-demo-v1"));
        s.events.forEach(e => { if (e.active) { e.dateISO = "2026-11-12T20:00:00+02:00"; e.price = 89; e.title = "ערב בדיקה"; } });
        localStorage.setItem("tik180-demo-v1", JSON.stringify(s)); }''')
    page.reload(wait_until='load')
    page.wait_for_function('document.querySelector("[data-event=date] time")', timeout=5000)
    check('admin-set date/time/price/title rendered on public page',
          '12 בנובמבר 2026' in page.inner_text('[data-event="date"]') and '20:00' in page.inner_text('[data-event="time"]')
          and page.inner_text('.ticket [data-event="price"]') == '89' and page.inner_text('#event-name') == 'ערב בדיקה',
          [page.inner_text('[data-event="date"]'), page.inner_text('[data-event="time"]')])
    check('countdown shown when the event has a future date',
          page.is_visible('#countdown') and re.match(r'^\d{2}$', page.inner_text('[data-cd="d"]')) is not None)
    check('no zoom link anywhere in public DOM', 'zoom.us' not in page.content())
    check('no horizontal scroll (after interactions)', no_hscroll(page))
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, 'index-%d.png' % width), full_page=False)
    check('no console errors', not errors, errors)
    ctx.close()


def test_public_v2(browser, base, width):
    """v2 interactive layer: countdown hidden without a date, ARIA carousels, keyboard tablist, pin/no-pin."""
    print('\nindex.html v2 interactions @ %dpx' % width)
    ctx, page, errors = new_page(browser, base, width)
    page.goto(base + '/index.html', wait_until='load')
    page.wait_for_function('window.TIK_EVENT && window.TIK_EVENT.id', timeout=5000)
    check('countdown hidden while dateISO is null', not page.is_visible('#countdown'))
    # formats tablist (RTL: ArrowLeft = next)
    page.focus('#tab-frontal')
    page.keyboard.press('ArrowLeft')
    check('tablist: arrow key moves selection + focus',
          page.get_attribute('#tab-zoom', 'aria-selected') == 'true' and page.evaluate('document.activeElement.id') == 'tab-zoom'
          and page.is_visible('#panel-zoom') and not page.is_visible('#panel-frontal'))
    page.keyboard.press('Home')
    check('tablist: Home returns to first tab', page.get_attribute('#tab-frontal', 'aria-selected') == 'true')
    # testimonials carousel
    slides = page.evaluate('''[...document.querySelectorAll('.tcar .tslide')].map(s => [s.getAttribute('role'), s.getAttribute('aria-roledescription'), s.getAttribute('aria-label')])''')
    check('testimonials: carousel + slide ARIA ("1 מתוך 3")',
          page.get_attribute('.tcar', 'aria-roledescription') == 'carousel' and slides[0] == ['group', 'slide', '1 מתוך 3'] and len(slides) == 3, slides)
    page.locator('.tcar [data-tcar-dots] .dot').nth(2).click()
    page.wait_for_timeout(900)
    check('testimonials: dot jumps to slide 3', page.get_attribute('.tcar [data-tcar-dots] .dot >> nth=2', 'aria-current') == 'true')
    page.click('[data-tcar="toggle"]')
    check('testimonials: pause button stops autoplay', 'הפעלת' in page.inner_text('[data-tcar="toggle"]') and page.get_attribute('#tcar-slides', 'aria-live') == 'polite')
    # coverflow
    page.click('[data-cf="next"]')
    check('clips coverflow: next button advances + announces', page.inner_text('.cf__status').startswith('3 מתוך 3'), page.inner_text('.cf__status'))
    pinned = page.evaluate('document.documentElement.classList.contains("story-pinned")')
    if width >= 1024:
        check('desktop: story is pinned horizontally', pinned)
        page.evaluate('window.scrollTo(0, document.getElementById("story").offsetTop + document.getElementById("story").offsetHeight - innerHeight - 10)')
        page.wait_for_timeout(300)
        check('desktop: pinned story reaches the last chapter', page.get_attribute('.story__rail [data-goto="7"]', 'aria-current') == 'step')
    else:
        check('mobile: story is a swipe carousel with dots', not pinned and page.locator('.story__dots .dot').count() == 8)
    check('no horizontal scroll (v2)', no_hscroll(page), page.evaluate('[document.documentElement.scrollWidth, innerWidth]'))
    check('no console errors (v2)', not errors, errors)
    ctx.close()

    # reduced motion: everything static
    ctx = browser.new_context(viewport={'width': width, 'height': 900}, reduced_motion='reduce', locale='he-IL')
    ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith(base) else r.fulfill(status=204, body=''))
    page = ctx.new_page()
    page.goto(base + '/index.html', wait_until='load')
    check('reduced motion: no pin, no preloader, no cursor, no autoplay',
          page.evaluate('''!document.documentElement.classList.contains('story-pinned') && !document.documentElement.classList.contains('has-preloader')
             && !document.querySelector('.cursor') && !document.querySelector('.tcar').classList.contains('is-playing')'''))
    check('reduced motion: kinetic question rendered as plain text', page.locator('.kw').count() == 0)
    ctx.close()

    # JS disabled: nothing hidden
    ctx = browser.new_context(viewport={'width': width, 'height': 900}, java_script_enabled=False, locale='he-IL')
    ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith(base) else r.fulfill(status=204, body=''))
    page = ctx.new_page()
    page.goto(base + '/index.html', wait_until='load')
    hidden = page.evaluate('''[...document.querySelectorAll('main h1, main h2, main h3, main p, main li, main blockquote, footer blockquote')]
        .filter(e => !e.closest('[hidden],[aria-hidden=true],.sr-only') && e.offsetParent !== null)
        .filter(e => { let n = e; while (n && n !== document.body) { if (parseFloat(getComputedStyle(n).opacity) < 0.99) return true; n = n.parentElement; } return false; })
        .map(e => e.textContent.trim().slice(0, 30))''')
    check('no-JS: no content hidden at opacity 0', not hidden, hidden[:5])
    check('no-JS: both lecture formats visible', page.is_visible('#panel-frontal') and page.is_visible('#panel-zoom'))
    check('no-JS: no horizontal scroll', no_hscroll(page))
    ctx.close()


def test_admin(browser, base, width):
    print('\nadmin.html @ %dpx' % width)
    ctx, page, errors = new_page(browser, base, width)
    page.goto(base + '/admin.html', wait_until='load')
    check('noindex meta present', page.get_attribute('meta[name=robots]', 'content').startswith('noindex'))
    check('DEMO banner visible on admin', page.is_visible('#demo-banner'))
    check('login screen shown first', page.is_visible('#login-view') and not page.is_visible('#app-view'))
    check('no horizontal scroll (login)', no_hscroll(page))
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, 'admin-login-%d.png' % width))
    page.click('#login-submit')
    check('empty key rejected', page.get_attribute('#login-key', 'aria-invalid') == 'true')
    page.fill('#login-key', 'demo')
    page.click('#login-submit')
    page.wait_for_selector('#app-view:not([hidden])', timeout=5000)
    page.wait_for_selector('#regs-body tr', timeout=5000)
    check('key kept in sessionStorage only', page.evaluate('sessionStorage.getItem("tik180-admin-key") === "demo" && !Object.keys(localStorage).some(k => localStorage.getItem(k) === "demo")'))
    check('fake data clearly labelled "(דמו)"', '(דמו)' in page.inner_text('#regs-body'))

    def kpi(i):
        return int(re.sub(r'[^\d]', '', page.inner_text(i)) or 0)
    total, paid, unpaid = kpi('#k-total'), kpi('#k-paid'), kpi('#k-unpaid')
    check('KPIs consistent (total = paid + unpaid)', total == paid + unpaid and total > 0, (total, paid, unpaid))
    check('revenue = paid × price', kpi('#k-revenue') == paid * 79, (page.inner_text('#k-revenue'), paid))
    check('no horizontal scroll (dashboard)', no_hscroll(page), page.evaluate('[document.documentElement.scrollWidth, innerWidth]'))
    if width < 1024:
        check('mobile: table collapsed into cards (thead hidden)', not page.is_visible('#regs-table thead'))
    else:
        check('desktop: table header visible', page.is_visible('#regs-table thead'))
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, 'admin-dash-%d.png' % width), full_page=False)

    # filters + search
    page.click('#filters [data-filter="unpaid"]')
    rows = page.locator('#regs-body tr').count()
    check('filter "לא שולמו" shows unpaid count', rows == unpaid, (rows, unpaid))
    page.click('#filters [data-filter="all"]')
    page.fill('#q', 'ישראל ישראלי')
    page.wait_for_timeout(250)
    check('search by name', page.locator('#regs-body tr').count() == 1)
    page.fill('#q', '972')
    page.wait_for_timeout(250)
    page.fill('#q', '')
    page.wait_for_timeout(250)

    # sort toggle
    sort_ctl = '#sort-date' if width >= 1024 else '#sort-mobile'
    check('sort control visible at this width', page.is_visible(sort_ctl))
    first_before = page.locator('#regs-body tr').first.get_attribute('data-id')
    page.click(sort_ctl)
    first_after = page.locator('#regs-body tr').first.get_attribute('data-id')
    check('sort by date toggles order', first_before != first_after and page.get_attribute('#th-date', 'aria-sort') == 'ascending')
    page.click(sort_ctl)

    # toggle paid (optimistic + persisted)
    page.click('#filters [data-filter="unpaid"]')
    sw = page.locator('#regs-body tr').first.locator('[data-field="paid"]')
    rid = page.locator('#regs-body tr').first.get_attribute('data-id')
    sw.click()
    check('optimistic: switch flips immediately', page.get_attribute('[data-key="paid:%s"]' % rid, 'aria-checked') == 'true')
    check('optimistic: KPI paid +1 immediately', kpi('#k-paid') == paid + 1)
    page.wait_for_function('!document.querySelector(\'[data-key="paid:%s"]\').hasAttribute("aria-busy")' % rid, timeout=5000)
    persisted = page.evaluate('JSON.parse(localStorage.getItem("tik180-demo-v1")).registrations.find(r => r.id === "%s").paid' % rid)
    check('setPaid persisted in demo backend', persisted is True)

    # rollback on error
    page.evaluate('TIK_API.demo.failNext()')
    page.click('[data-key="paid:%s"]' % rid)
    page.wait_for_selector('.toast.is-error', timeout=5000)
    check('rollback on error restores switch', page.get_attribute('[data-key="paid:%s"]' % rid, 'aria-checked') == 'true')
    check('rollback on error restores KPI', kpi('#k-paid') == paid + 1)

    # zoom sent toggle
    page.click('[data-key="zoomSent:%s"]' % rid)
    page.wait_for_function('document.querySelector(\'[data-key="zoomSent:%s"]\').getAttribute("aria-checked") === "true" && !document.querySelector(\'[data-key="zoomSent:%s"]\').hasAttribute("aria-busy")' % (rid, rid), timeout=5000)
    check('zoom-sent toggle works', True)

    # note
    page.click('#filters [data-filter="all"]')
    note = page.locator('[data-key="note:%s"]' % rid)
    note.fill('שילם בביט')
    note.press('Enter')
    page.wait_for_function('JSON.parse(localStorage.getItem("tik180-demo-v1")).registrations.find(r => r.id === "%s").notes === "שילם בביט"' % rid, timeout=5000)
    check('note saved', True)

    # WhatsApp + tel + mailto links
    first = page.locator('#regs-body tr').first
    wa = first.locator('a[href^="https://wa.me/972"]').get_attribute('href')
    check('WhatsApp link wa.me/9725…', bool(re.match(r'^https://wa\.me/9725\d{8}$', wa or '')), wa)
    check('tel + mailto links present', first.locator('a[href^="tel:+972"]').count() == 1 and first.locator('a[href^="mailto:"]').count() == 1)

    # copy paid emails
    page.click('#copy-emails')
    copied = page.evaluate('window.__lastCopied')
    check('copy all paid emails → comma list', copied and '@' in copied and ', ' in copied, copied)
    n_paid_emails = page.evaluate('''(() => { const A = window.__TIK_ADMIN; return new Set(A.state.regs.filter(r => !r.deleted && r.eventId === A.view.eventId && r.paid && r.email).map(r=>r.email)).size; })()''')
    check('copied count = paid with email', copied.count('@') == n_paid_emails, (copied.count('@'), n_paid_emails))

    # CSV
    with page.expect_download() as dl:
        page.click('#export-csv')
    path = dl.value.path()
    raw = open(path, 'rb').read()
    check('CSV starts with UTF-8 BOM', raw[:3] == b'\xef\xbb\xbf')
    text = raw.decode('utf-8-sig')
    check('CSV has Hebrew header + rows', text.startswith('שם מלא,') and text.count('\r\n') >= total - 1, text[:80])
    check('CSV filename', dl.value.suggested_filename.startswith('registrations-') and dl.value.suggested_filename.endswith('.csv'))
    inj = page.evaluate('window.__TIK_ADMIN.buildCsv([{fullName:"=1+1",phone:"0501234567",email:"a@b.co",notes:"@x",createdAt:"2026-01-01T00:00:00Z"}])')
    check('CSV neutralises formula cells', "'=1+1" in inj and "'@x" in inj)

    # soft delete with confirm
    before = page.locator('#regs-body tr').count()
    del_id = page.locator('#regs-body tr').nth(1).get_attribute('data-id')
    page.locator('#regs-body tr').nth(1).locator('[data-act="delete"]').click()
    check('confirm dialog opens', page.is_visible('#confirm-dialog'))
    page.click('#confirm-no')
    check('cancel keeps row', page.locator('#regs-body tr').count() == before)
    page.locator('[data-key="del:%s"]' % del_id).click()
    page.click('#confirm-yes')
    page.wait_for_function('document.querySelectorAll("#regs-body tr").length === %d' % (before - 1), timeout=5000)
    soft = page.evaluate('JSON.parse(localStorage.getItem("tik180-demo-v1")).registrations.find(r => r.id === "%s")' % del_id)
    check('soft delete: row kept with deleted=true', soft and soft['deleted'] is True)

    # contacts tab
    page.click('#tab-contacts')
    check('contacts tab visible', page.is_visible('#panel-contacts') and page.locator('#contacts-list li').count() > 0)
    newc = kpi('#k-contacts')
    page.locator('#contacts-list [data-cact="handled"]').first.click()
    page.wait_for_function('!document.querySelector("#contacts-list [aria-busy]")', timeout=5000)
    check('mark contact handled → KPI decrements', kpi('#k-contacts') == newc - 1)
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, 'admin-contacts-%d.png' % width))
    check('no horizontal scroll (contacts)', no_hscroll(page))

    # event settings
    page.click('#tab-event')
    check('zoom link marked admin-only', 'למנהל בלבד' in page.inner_text('#panel-event'))
    page.fill('#ev-title', 'הרצאת זום - נובמבר')
    page.fill('#ev-date', '2026-11-12')
    page.fill('#ev-time', '20:00')
    page.fill('#ev-price', '79')
    page.fill('#ev-zoom', 'http://not-https')
    page.click('#ev-save')
    check('non-https zoom link rejected client-side', page.get_attribute('#ev-zoom', 'aria-invalid') == 'true')
    page.fill('#ev-zoom', 'https://zoom.us/j/123456789?pwd=DEMO')
    check('live preview shows Israel date', '12 בנובמבר 2026' in page.inner_text('#pv-date') and '20:00' in page.inner_text('#pv-time'))
    page.click('#ev-save')
    page.wait_for_selector('.toast:not(.is-error):has-text("האירוע נשמר")', timeout=5000)
    ev = page.evaluate('JSON.parse(localStorage.getItem("tik180-demo-v1")).events.find(e => e.active)')
    check('upsertEvent stored ISO with Israel offset (+02:00 in Nov)', ev['dateISO'] == '2026-11-12T20:00:00+02:00', ev['dateISO'])
    check('summer date gets +03:00', page.evaluate('window.__TIK_ADMIN.israelToISO("2026-07-01","20:30")') == '2026-07-01T20:30:00+03:00')
    check('ISO → Israel round-trip', page.evaluate('window.__TIK_ADMIN.isoToIsrael("2026-11-12T18:00:00Z")') == {'date': '2026-11-12', 'time': '20:00'})
    # new event becomes active, deactivates the old
    page.click('#ev-new')
    page.fill('#ev-title', 'הרצאה נוספת')
    page.fill('#ev-price', '99')
    page.click('#ev-save')
    page.wait_for_function('JSON.parse(localStorage.getItem("tik180-demo-v1")).events.length === 3', timeout=5000)
    page.wait_for_timeout(700)
    act = page.evaluate('JSON.parse(localStorage.getItem("tik180-demo-v1")).events.filter(e => e.active).map(e => e.title)')
    check('only one active event after creating a new active one', act == ['הרצאה נוספת'], act)
    try:
        page.wait_for_function('document.querySelector("#k-total").textContent.trim() === "0"', timeout=5000)
    except Exception:
        pass
    check('KPIs follow the new active event (0 registered)', kpi('#k-total') == 0, page.inner_text('#k-total'))
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, 'admin-event-%d.png' % width), full_page=True)
    check('no horizontal scroll (event settings)', no_hscroll(page))

    # session persists on reload, logout clears it
    page.reload(wait_until='load')
    page.wait_for_selector('#app-view:not([hidden])', timeout=5000)
    check('reload keeps session (sessionStorage)', page.is_visible('#app-view'))
    page.click('#logout-btn')
    check('logout clears key + returns to login', page.is_visible('#login-view') and page.evaluate('sessionStorage.getItem("tik180-admin-key")') is None)
    check('no console errors', not errors, errors)
    ctx.close()


def test_live(browser, base):
    """api.js in LIVE mode against Code.gs served over HTTP (mocked Google services)."""
    print('\nlive mode: index.html + admin.html -> Code.gs over HTTP')
    key = 'live-test-key-0123456789abcdef'
    proc = subprocess.Popen(['node', os.path.join(ROOT, 'tests', 'live-server.js'), key], stdout=subprocess.PIPE, text=True)
    try:
        port = int(proc.stdout.readline().split()[1])
        api = 'http://127.0.0.1:%d/exec' % port
        ctx, page, errors = new_page(browser, base, 1440)
        ctx.route(base + '/config.js', lambda r: r.fulfill(status=200, content_type='application/javascript',
                                                          body='window.TIK_CONFIG = { apiUrl: "%s" };' % api))
        ctx.route('http://127.0.0.1:%d/**' % port, lambda r: r.continue_())
        page.goto(base + '/index.html', wait_until='load')
        check('live: not in demo mode', page.evaluate('TIK_API.isDemo') is False)
        page.wait_for_function('window.TIK_EVENT && window.TIK_EVENT.id', timeout=5000)
        page.fill('#r-name', '=HYPERLINK("x")'); page.fill('#r-phone', '050-765-4321'); page.fill('#r-email', 'live@example.com')
        page.click('#register-submit')
        page.wait_for_selector('#reg-step-pay:not([hidden])', timeout=8000)
        check('live: registration reaches Code.gs and succeeds', True)
        page.fill('#c-phone', '0541234567') if page.is_visible('#c-phone') else None
        page.click('#contact-submit')
        page.wait_for_selector('#contact-success:not([hidden])', timeout=8000)
        reqs = json.load(urllib.request.urlopen('http://127.0.0.1:%d/__log' % port))
        posts = [r for r in reqs if r['method'] == 'POST']
        check('live: no CORS preflight (no OPTIONS requests)', not any(r['method'] == 'OPTIONS' for r in reqs), reqs)
        check('live: POSTs are text/plain', posts and all(r['contentType'].startswith('text/plain') for r in posts), posts)

        # admin: wrong key, then right key
        page.goto(base + '/admin.html', wait_until='load')
        check('live: no demo banner', not page.is_visible('#demo-banner'))
        page.fill('#login-key', 'wrong-key'); page.click('#login-submit')
        page.wait_for_selector('#login-status.is-error', timeout=8000)
        check('live: wrong admin key rejected with Hebrew message', 'שגוי' in page.inner_text('#login-status'), page.inner_text('#login-status'))
        page.fill('#login-key', key); page.click('#login-submit')
        page.wait_for_selector('#regs-body tr', timeout=8000)
        check('live: formula text shown verbatim to admin', '=HYPERLINK("x")' in page.inner_text('#regs-body'))
        rid = page.locator('#regs-body tr').first.get_attribute('data-id')
        page.click('[data-key="paid:%s"]' % rid)
        page.wait_for_function('!document.querySelector(\'[data-key="paid:%s"]\').hasAttribute("aria-busy")' % rid, timeout=8000)
        check('live: setPaid round-trip', page.get_attribute('[data-key="paid:%s"]' % rid, 'aria-checked') == 'true')
        page.click('#tab-event')
        page.fill('#ev-date', '2026-11-12'); page.fill('#ev-time', '20:00'); page.fill('#ev-zoom', 'https://zoom.us/j/LIVESECRET')
        page.click('#ev-save')
        page.wait_for_selector('.toast:not(.is-error):has-text("האירוע נשמר")', timeout=8000)
        pub = urllib.request.urlopen(api + '?action=event').read().decode()
        check('live: public event has the date, never the zoom link', '2026-11-12T20:00:00+02:00' in pub and 'LIVESECRET' not in pub, pub)
        all_reqs = json.load(urllib.request.urlopen('http://127.0.0.1:%d/__log' % port))
        check('live: admin key never in any URL', not any(key in r['path'] for r in all_reqs) and not any(r['method'] == 'OPTIONS' for r in all_reqs))
        check('live: no console errors', not errors, errors)
        ctx.close()
    finally:
        proc.kill()


def main():
    httpd, base = serve()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for w in WIDTHS:
            test_public(browser, base, w)
            test_public_v2(browser, base, w)
            test_admin(browser, base, w)
        test_live(browser, base)
        browser.close()
    httpd.shutdown()
    failed = [r for r in results if not r[1]]
    print('\n%d passed, %d failed' % (len(results) - len(failed), len(failed)))
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
