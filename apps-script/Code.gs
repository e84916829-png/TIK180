/**
 * ============================================================================
 *  לבחור בחיים מחדש / TIK180: backend (Google Apps Script + Google Sheets)
 * ============================================================================
 *
 *  What this file does
 *  -------------------
 *  A small JSON API that the static site (GitHub Pages) talks to:
 *    GET  ?action=event                → public data of the active Zoom event (never the Zoom link)
 *    GET  ?action=list&key=...         → admin data (prefer the POST form below; GET puts the key in the URL)
 *    POST {"action":"register", ...}   → public registration
 *    POST {"action":"contact",  ...}   → public booking inquiry
 *    POST {"action":"list"|"setPaid"|"setZoomSent"|"setNote"|"markContactHandled"
 *          |"upsertEvent"|"deleteRegistration", "key":"...", ...}  → admin
 *
 *  The browser sends the POST body as a JSON *string* with no custom headers, so the
 *  request is "simple" (Content-Type: text/plain) and no CORS preflight is needed.
 *
 *  One-time setup (full Hebrew guide in SETUP.md)
 *  ----------------------------------------------
 *   1. Paste this file into Extensions → Apps Script of your Google Sheet.
 *   2. OPTIONAL: change INITIAL_ADMIN_KEY below to your own long password (16+ characters).
 *      If you leave it as 'CHANGE-ME', setup() generates a strong random key for you
 *      and prints it in the Execution log.
 *   3. Choose the function `setup` in the toolbar and press Run (approve the permissions).
 *   4. Copy the admin key from the Execution log and keep it somewhere safe.
 *   5. Put INITIAL_ADMIN_KEY back to 'CHANGE-ME' (the key now lives in Script Properties,
 *      not in the code).
 *   6. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *
 *  Rotating the admin key (e.g. if it leaked, or someone stopped working with you)
 *  ------------------------------------------------------------------------------
 *   Run `rotateAdminKey` from the editor; the new key is printed in the Execution log.
 *   The old key stops working immediately and nothing needs to be redeployed.
 *   Alternatively: Project Settings (gear icon) → Script Properties → edit ADMIN_KEY.
 *
 *  Email notifications (off by default)
 *  ------------------------------------
 *   Put your address in NOTIFY_EMAIL_TO below and run setup() again, or add a Script
 *   Property named NOTIFY_EMAIL. Delete the property to turn notifications off again.
 * ============================================================================
 */

/* ---------- The only values you may need to edit ---------- */
var INITIAL_ADMIN_KEY = 'CHANGE-ME';   // ← optional: your own admin password (16+ chars). Read once by setup().
var NOTIFY_EMAIL_TO   = '';            // ← optional: e.g. 'you@example.com' to get an email per registration.

/* ---------- Internals (no need to edit below this line) ---------- */
var PLACEHOLDER_KEY = 'CHANGE-ME';
var MIN_KEY_LENGTH = 16;
var MAX_BODY_CHARS = 20000;
var TZ = 'Asia/Jerusalem';
var SCHEMA_VERSION = 1;

var SHEETS = {
  Registrations: {
    headers: ['id', 'createdAt', 'eventId', 'fullName', 'phone', 'email', 'city', 'source', 'consent',
              'paid', 'paidAt', 'zoomSent', 'notes', 'userAgent', 'deleted'],
    bools: ['consent', 'paid', 'zoomSent', 'deleted'],
    widths: { fullName: 180, email: 220, notes: 240, userAgent: 200 }
  },
  Contacts: {
    headers: ['id', 'createdAt', 'fullName', 'phone', 'orgType', 'lectureType', 'message', 'handled'],
    bools: ['handled'],
    widths: { fullName: 180, message: 380 }
  },
  Events: {
    headers: ['id', 'title', 'dateISO', 'price', 'duration', 'zoomLink', 'notes', 'active', 'publicNote', 'updatedAt'],
    bools: ['active'],
    numbers: ['price'],
    widths: { title: 260, dateISO: 200, zoomLink: 280, notes: 240, publicNote: 240 }
  },
  Settings: {
    headers: ['key', 'value'],
    bools: [],
    widths: { key: 160, value: 260 }
  }
};

var LIMITS = {
  fullName: 80, phone: 20, email: 120, city: 60, source: 20, message: 2000, notes: 1000, userAgent: 300,
  orgType: 20, lectureType: 20, title: 120, duration: 40, zoomLink: 500, eventNotes: 1000, publicNote: 200, id: 64
};

var ENUMS = {
  source: ['', 'facebook', 'instagram', 'friend', 'organization', 'other'],
  orgType: ['', 'company', 'school', 'community', 'other'],
  lectureType: ['', 'frontal', 'zoom', 'unsure']
};

var RATE = { perPhonePerHour: 6, globalPerHour: 400 };

var MSG = {
  invalid: 'חלק מהפרטים לא תקינים. נא לבדוק ולנסות שוב.',
  nameRequired: 'נא להזין שם מלא (לפחות 2 תווים)',
  phoneInvalid: 'מספר הטלפון לא תקין. לדוגמה: 050-1234567',
  emailInvalid: 'כתובת האימייל לא תקינה. לדוגמה: name@example.com',
  tooLong: 'הטקסט ארוך מדי',
  busy: 'המערכת עמוסה כרגע. נא לנסות שוב בעוד רגע.',
  rateLimited: 'התקבלו יותר מדי פניות מהמספר הזה. נא לנסות שוב מאוחר יותר או להתקשר ל-058-3674925.',
  unauthorized: 'מפתח הניהול שגוי.',
  notConfigured: 'מפתח הניהול עדיין לא הוגדר. יש להריץ את setup() בעורך ה-Apps Script.',
  notFound: 'הרשומה לא נמצאה (ייתכן שנמחקה).',
  badRequest: 'הבקשה לא תקינה.',
  unknownAction: 'פעולה לא מוכרת.',
  server: 'אירעה תקלה בשרת. נא לנסות שוב בעוד רגע.'
};

/* ============================================================================
   HTTP entry points
   ============================================================================ */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var action = String(p.action || '');
    if (action === 'event') return json_({ ok: true, event: publicEvent_() });
    if (action === 'list') { requireAdmin_(p.key); return json_(adminList_(p)); }
    if (action === '') return json_({ ok: true, service: 'tik180', schema: SCHEMA_VERSION });
    fail_('unknown_action', MSG.unknownAction);
  } catch (err) {
    return json_(errorOut_(err));
  }
}

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || '';
    if (!raw || raw.length > MAX_BODY_CHARS) fail_('bad_request', MSG.badRequest);
    var body;
    try { body = JSON.parse(raw); } catch (parseErr) { fail_('bad_request', MSG.badRequest); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail_('bad_request', MSG.badRequest);

    var action = String(body.action || '');
    switch (action) {
      // public
      case 'event':    return json_({ ok: true, event: publicEvent_() });
      case 'register': return json_(register_(body));
      case 'contact':  return json_(contact_(body));
      // admin
      case 'list':               requireAdmin_(body.key); return json_(adminList_(body));
      case 'setPaid':            requireAdmin_(body.key); return json_(setRegFlag_(body, 'paid'));
      case 'setZoomSent':        requireAdmin_(body.key); return json_(setRegFlag_(body, 'zoomSent'));
      case 'setNote':            requireAdmin_(body.key); return json_(setNote_(body));
      case 'markContactHandled': requireAdmin_(body.key); return json_(markContactHandled_(body));
      case 'upsertEvent':        requireAdmin_(body.key); return json_(upsertEvent_(body));
      case 'deleteRegistration': requireAdmin_(body.key); return json_(deleteRegistration_(body));
      case 'ping':               requireAdmin_(body.key); return json_({ ok: true });
    }
    fail_('unknown_action', MSG.unknownAction);
  } catch (err) {
    return json_(errorOut_(err));
  }
}

/* ============================================================================
   Public actions
   ============================================================================ */

function register_(b) {
  if (isBot_(b)) return { ok: true, id: fakeId_() }; // honeypot: look successful, store nothing

  var fe = {};
  var fullName = cleanText_(b.fullName, LIMITS.fullName);
  if (fullName === null || fullName.length < 2) fe.fullName = MSG.nameRequired;
  var phone = normPhone_(b.phone);
  if (!phone) fe.phone = MSG.phoneInvalid;
  var email = cleanText_(b.email, LIMITS.email);
  if (email !== null) email = email.toLowerCase();
  if (!email || !isEmail_(email)) fe.email = MSG.emailInvalid;
  var city = cleanText_(b.city, LIMITS.city);
  if (city === null) fe.city = MSG.tooLong;
  if (Object.keys(fe).length) fail_('validation', MSG.invalid, { fieldErrors: fe });

  var source = oneOf_(b.source, ENUMS.source);
  var consent = b.consent === true || b.consent === 'true' || b.consent === 'yes';
  var ua = truncate_(b.userAgent, LIMITS.userAgent);

  rateLimit_(phone);

  var result = withLock_(function () {
    var ev = activeEventRow_();
    var eventId = ev ? String(ev.id) : '';
    var t = readTable_('Registrations');
    for (var i = 0; i < t.rows.length; i++) {
      var r = t.rows[i];
      if (!toBool_(r.deleted) && String(r.eventId) === eventId && normPhone_(r.phone) === phone) {
        return { ok: true, duplicate: true, id: String(r.id), _event: ev };
      }
    }
    var row = {
      id: newId_('r'), createdAt: new Date().toISOString(), eventId: eventId,
      fullName: fullName, phone: phone, email: email, city: city, source: source, consent: consent,
      paid: false, paidAt: '', zoomSent: false, notes: '', userAgent: ua, deleted: false
    };
    appendRow_(t, row);
    return { ok: true, id: row.id, _event: ev, _row: row };
  });

  if (result._row) notify_('register', result._row, result._event);
  return { ok: true, id: result.id, duplicate: !!result.duplicate };
}

function contact_(b) {
  if (isBot_(b)) return { ok: true, id: fakeId_() };

  var fe = {};
  var fullName = cleanText_(b.fullName, LIMITS.fullName);
  if (fullName === null) fe.fullName = MSG.tooLong;
  var phone = normPhone_(b.phone);
  if (!phone) fe.phone = MSG.phoneInvalid;
  var message = cleanText_(b.message, LIMITS.message, true);
  if (message === null) fe.message = MSG.tooLong;
  if (Object.keys(fe).length) fail_('validation', MSG.invalid, { fieldErrors: fe });

  rateLimit_(phone);

  var row = withLock_(function () {
    var t = readTable_('Contacts');
    var r = {
      id: newId_('c'), createdAt: new Date().toISOString(), fullName: fullName, phone: phone,
      orgType: oneOf_(b.orgType, ENUMS.orgType), lectureType: oneOf_(b.lectureType, ENUMS.lectureType),
      message: message, handled: false
    };
    appendRow_(t, r);
    return r;
  });
  notify_('contact', row, null);
  return { ok: true, id: row.id };
}

/** Only whitelisted fields leave the server. zoomLink and internal notes NEVER do. */
function publicEvent_() {
  var ev = activeEventRow_();
  if (!ev) return null;
  var price = Number(ev.price);
  return {
    id: String(ev.id),
    title: String(ev.title || ''),
    dateISO: toIsoString_(ev.dateISO) || null,
    price: isFinite(price) && price >= 0 ? price : null,
    duration: String(ev.duration || ''),
    zoomNote: String(ev.publicNote || '')
  };
}

/* ============================================================================
   Admin actions
   ============================================================================ */

function adminList_(b) {
  var includeDeleted = b && (b.includeDeleted === true || b.includeDeleted === 'true');
  var regs = readTable_('Registrations').rows.map(function (r) { return publicRow_('Registrations', r); })
    .filter(function (r) { return includeDeleted || !r.deleted; });
  var contacts = readTable_('Contacts').rows.map(function (r) { return publicRow_('Contacts', r); });
  var events = readTable_('Events').rows.map(function (r) { return publicRow_('Events', r); });

  var active = null;
  for (var i = 0; i < events.length; i++) if (events[i].active) { active = events[i]; break; }
  var mine = regs.filter(function (r) { return !r.deleted && active && r.eventId === active.id; });
  var paid = mine.filter(function (r) { return r.paid; }).length;
  var price = active ? Number(active.price) || 0 : 0;
  return {
    ok: true,
    registrations: regs,
    contacts: contacts,
    events: events,
    stats: {
      activeEventId: active ? active.id : null,
      total: mine.length,
      paid: paid,
      unpaid: mine.length - paid,
      zoomSent: mine.filter(function (r) { return r.zoomSent; }).length,
      revenue: paid * price,
      newContacts: contacts.filter(function (c) { return !c.handled; }).length
    },
    serverTime: new Date().toISOString()
  };
}

function setRegFlag_(b, field) {
  var id = requireId_(b.id);
  var value = toBool_(b.value !== undefined ? b.value : b[field]);
  return withLock_(function () {
    var t = readTable_('Registrations');
    var r = findById_(t, id);
    var patch = {}; patch[field] = value;
    if (field === 'paid') patch.paidAt = value ? new Date().toISOString() : '';
    updateRow_(t, r, patch);
    return { ok: true, registration: publicRow_('Registrations', merge_(r, patch)) };
  });
}

function setNote_(b) {
  var id = requireId_(b.id);
  var notes = cleanText_(b.notes, LIMITS.notes, true);
  if (notes === null) fail_('validation', MSG.tooLong, { fieldErrors: { notes: MSG.tooLong } });
  return withLock_(function () {
    var t = readTable_('Registrations');
    var r = findById_(t, id);
    updateRow_(t, r, { notes: notes });
    return { ok: true, registration: publicRow_('Registrations', merge_(r, { notes: notes })) };
  });
}

function markContactHandled_(b) {
  var id = requireId_(b.id);
  var value = b.handled === undefined && b.value === undefined ? true : toBool_(b.value !== undefined ? b.value : b.handled);
  return withLock_(function () {
    var t = readTable_('Contacts');
    var r = findById_(t, id);
    updateRow_(t, r, { handled: value });
    return { ok: true, contact: publicRow_('Contacts', merge_(r, { handled: value })) };
  });
}

function deleteRegistration_(b) {
  var id = requireId_(b.id);
  return withLock_(function () {
    var t = readTable_('Registrations');
    var r = findById_(t, id);
    updateRow_(t, r, { deleted: true }); // soft delete only: the row stays in the sheet
    return { ok: true, id: id, deleted: true };
  });
}

function upsertEvent_(b) {
  var e = b.event && typeof b.event === 'object' ? b.event : b;
  var fe = {};
  var title = cleanText_(e.title, LIMITS.title);
  if (!title) fe.title = 'נא להזין כותרת (עד ' + LIMITS.title + ' תווים)';
  var dateISO = '';
  if (e.dateISO !== null && e.dateISO !== undefined && String(e.dateISO).trim() !== '') {
    dateISO = String(e.dateISO).trim();
    if (!isIsoDate_(dateISO)) fe.dateISO = 'תאריך לא תקין';
  }
  var price = Number(e.price);
  if (e.price === '' || e.price === null || e.price === undefined || !isFinite(price) || price < 0 || price > 100000) fe.price = 'מחיר לא תקין';
  var duration = cleanText_(e.duration, LIMITS.duration);
  if (duration === null) fe.duration = MSG.tooLong;
  var zoomLink = cleanText_(e.zoomLink, LIMITS.zoomLink);
  if (zoomLink === null || (zoomLink && !/^https:\/\/[^\s<>"']+$/i.test(zoomLink))) fe.zoomLink = 'קישור לא תקין (חייב להתחיל ב-https://)';
  var notes = cleanText_(e.notes, LIMITS.eventNotes, true);
  if (notes === null) fe.notes = MSG.tooLong;
  var publicNote = cleanText_(e.publicNote !== undefined ? e.publicNote : e.zoomNote, LIMITS.publicNote);
  if (publicNote === null) fe.publicNote = MSG.tooLong;
  if (Object.keys(fe).length) fail_('validation', MSG.invalid, { fieldErrors: fe });

  var active = toBool_(e.active);
  var id = e.id ? String(e.id).slice(0, LIMITS.id) : '';

  return withLock_(function () {
    var t = readTable_('Events');
    var data = {
      title: title, dateISO: dateISO, price: Math.round(price * 100) / 100, duration: duration,
      zoomLink: zoomLink, notes: notes, active: active, publicNote: publicNote, updatedAt: new Date().toISOString()
    };
    var saved;
    var existing = id ? findById_(t, id, true) : null;
    if (existing) {
      updateRow_(t, existing, data);
      saved = merge_(existing, data);
    } else {
      data.id = newId_('e');
      appendRow_(t, data);
      saved = data;
    }
    if (active) { // only one active event at a time
      var fresh = readTable_('Events');
      fresh.rows.forEach(function (r) {
        if (String(r.id) !== String(saved.id) && toBool_(r.active)) updateRow_(fresh, r, { active: false });
      });
    }
    return { ok: true, event: publicRow_('Events', saved) };
  });
}

/* ============================================================================
   Setup & maintenance (run these from the Apps Script editor)
   ============================================================================ */

/** Creates the sheets and sets the admin key. Safe to run more than once. */
function setup() {
  Object.keys(SHEETS).forEach(function (name) { ensureSheet_(name); });
  var props = PropertiesService.getScriptProperties();

  var k = String(INITIAL_ADMIN_KEY || '').trim();
  if (k && k !== PLACEHOLDER_KEY) {
    if (k.length < MIN_KEY_LENGTH) throw new Error('INITIAL_ADMIN_KEY קצר מדי. נדרשים לפחות ' + MIN_KEY_LENGTH + ' תווים.');
    props.setProperty('ADMIN_KEY', k);
    Logger.log('✔ מפתח הניהול נשמר מתוך INITIAL_ADMIN_KEY. עכשיו אפשר להחזיר את הערך בקוד ל-CHANGE-ME.');
  } else if (!props.getProperty('ADMIN_KEY')) {
    var gen = generateKey_();
    props.setProperty('ADMIN_KEY', gen);
    Logger.log('✔ נוצר מפתח ניהול חדש. העתיקו ושמרו אותו במקום בטוח:\n\n    ' + gen + '\n');
  } else {
    Logger.log('✔ מפתח ניהול כבר קיים ולא שונה. (להחלפה: הריצו rotateAdminKey)');
  }

  if (NOTIFY_EMAIL_TO && isEmail_(String(NOTIFY_EMAIL_TO).trim().toLowerCase())) {
    props.setProperty('NOTIFY_EMAIL', String(NOTIFY_EMAIL_TO).trim());
    Logger.log('✔ התראות במייל יישלחו אל ' + NOTIFY_EMAIL_TO);
  }

  var ev = readTable_('Events');
  if (!ev.rows.length) {
    appendRow_(ev, {
      id: newId_('e'), title: 'האירוע הקרוב - הרצאת זום', dateISO: '', price: 79, duration: '60 דקות',
      zoomLink: '', notes: '', active: true, publicNote: 'קישור הזום יישלח לאחר התשלום', updatedAt: new Date().toISOString()
    });
    Logger.log('✔ נוצר אירוע ברירת מחדל (ללא תאריך). אפשר לערוך אותו במסך הניהול.');
  }
  setSetting_('schemaVersion', SCHEMA_VERSION);
  setSetting_('setupAt', new Date().toISOString());
  Logger.log('✔ הגיליונות מוכנים. השלב הבא: Deploy → New deployment → Web app.');
}

/** Replaces the admin key with a new random one and prints it. The old key stops working at once. */
function rotateAdminKey() {
  var gen = generateKey_();
  PropertiesService.getScriptProperties().setProperty('ADMIN_KEY', gen);
  Logger.log('✔ מפתח ניהול חדש (הישן כבר לא עובד):\n\n    ' + gen + '\n');
  return gen;
}

/** Prints the current admin key (only people who can edit this script can run this). */
function showAdminKey() {
  var k = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  Logger.log(k ? 'מפתח הניהול הנוכחי:\n\n    ' + k + '\n' : 'עדיין לא הוגדר מפתח. הריצו setup().');
}

/** Turns email notifications off. */
function disableEmailNotifications() {
  PropertiesService.getScriptProperties().deleteProperty('NOTIFY_EMAIL');
  Logger.log('✔ התראות המייל כובו.');
}

/* ============================================================================
   Security helpers
   ============================================================================ */

function requireAdmin_(key) {
  var stored = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (!stored || stored.length < MIN_KEY_LENGTH) fail_('not_configured', MSG.notConfigured);
  if (typeof key !== 'string' || !safeEqual_(key, stored)) {
    try { Utilities.sleep(400); } catch (ignore) {} // slows down guessing a little
    fail_('unauthorized', MSG.unauthorized);
  }
}

/** Constant-time string comparison. */
function safeEqual_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function isBot_(b) {
  return b.website !== undefined && b.website !== null && String(b.website) !== '';
}

/**
 * Makes a value safe to write into a cell.
 *  - Values starting with = + - @ (or tab / CR) would be run as a formula by Sheets or Excel →
 *    prefix with an apostrophe, which Sheets treats as "this is plain text".
 *  - Values starting with a digit (phones, ISO dates) or TRUE/FALSE would be auto-converted
 *    (leading zero lost, date reformatted) → same apostrophe.
 */
function toCell_(v) {
  if (typeof v !== 'string') return v;
  if (v === '') return v;
  if (/^[=+\-@\t\r]/.test(v) || /^\d/.test(v) || /^(true|false)$/i.test(v)) return "'" + v;
  return v;
}

/** Simple abuse brake for the public endpoints (uses CacheService; skipped if unavailable). */
function rateLimit_(phone) {
  if (typeof CacheService === 'undefined') return;
  var cache = CacheService.getScriptCache();
  var hour = Math.floor(Date.now() / 3600000);
  var kp = 'rl:p:' + phone + ':' + hour, kg = 'rl:g:' + hour;
  var np = Number(cache.get(kp) || 0) + 1, ng = Number(cache.get(kg) || 0) + 1;
  if (np > RATE.perPhonePerHour || ng > RATE.globalPerHour) fail_('rate_limited', MSG.rateLimited);
  cache.put(kp, String(np), 3700);
  cache.put(kg, String(ng), 3700);
}

/* ============================================================================
   Validation helpers
   ============================================================================ */

/** Trims, strips control characters, collapses whitespace (unless multiline). Returns null if too long. */
function cleanText_(v, max, multiline) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  var s = String(v).replace(/\r\n?/g, '\n');
  s = multiline ? s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').replace(/\n{3,}/g, '\n\n')
                : s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ');
  s = s.trim();
  return s.length > max ? null : s;
}

function truncate_(v, max) {
  var s = cleanText_(typeof v === 'string' ? v.slice(0, max * 2) : '', max * 2);
  return (s || '').slice(0, max);
}

/** Israeli phone → local digits '0XXXXXXXX(X)', or '' if invalid. */
function normPhone_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') v = '0' + String(v); // a phone typed by hand into the sheet lost its leading 0
  var s = String(v).replace(/^'/, '').replace(/[\s\-().]/g, '');
  if (s.length > LIMITS.phone) return '';
  var m = s.match(/^(?:\+?972)(\d{8,9})$/);
  if (m) s = '0' + m[1];
  return /^0\d{8,9}$/.test(s) ? s : '';
}

function isEmail_(s) {
  return typeof s === 'string' && s.length <= LIMITS.email && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(s);
}

function isIsoDate_(s) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+\-]\d{2}:\d{2})$/.test(s) && !isNaN(new Date(s).getTime());
}

function oneOf_(v, list) {
  v = typeof v === 'string' ? v.trim() : '';
  return list.indexOf(v) >= 0 ? v : (v ? 'other' : '');
}

function requireId_(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_\-]{1,64}$/.test(v)) fail_('bad_request', MSG.badRequest);
  return v;
}

function toBool_(v) {
  return v === true || v === 1 || (typeof v === 'string' && /^(true|yes|1)$/i.test(v.trim()));
}

function toIsoString_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  return v === null || v === undefined ? '' : String(v);
}

/* ============================================================================
   Sheet helpers
   ============================================================================ */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function ensureSheet_(name) {
  var def = SHEETS[name];
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    try {
      def.headers.forEach(function (h, i) { if (def.widths && def.widths[h]) sh.setColumnWidth(i + 1, def.widths[h]); });
      sh.setRightToLeft(true);
    } catch (ignore) {}
    return sh;
  }
  // add any missing columns (e.g. after an upgrade); never removes or reorders yours
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var have = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var missing = def.headers.filter(function (h) { return have.indexOf(h) < 0; });
  if (missing.length) {
    var start = have.filter(function (h) { return h !== ''; }).length ? lastCol + 1 : 1;
    sh.getRange(1, start, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  return sh;
}

/** Reads a sheet into { sheet, headers, col, rows:[{..., _row}] }. */
function readTable_(name) {
  var sh = ensureSheet_(name);
  var def = SHEETS[name];
  var values = sh.getDataRange().getValues();
  var headers = (values[0] || []).map(String);
  var col = {};
  headers.forEach(function (h, i) { if (h) col[h] = i; });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.join('') === '') continue;
    var o = { _row: r + 1 };
    headers.forEach(function (h, i) { if (h) o[h] = row[i]; });
    rows.push(o);
  }
  return { sheet: sh, headers: headers, col: col, rows: rows, def: def, name: name };
}

function appendRow_(t, obj) {
  var row = t.headers.map(function (h) { return obj[h] === undefined ? '' : toCell_(obj[h]); });
  t.sheet.appendRow(row);
}

function updateRow_(t, rowObj, patch) {
  Object.keys(patch).forEach(function (k) {
    var c = t.col[k];
    if (c === undefined) return;
    t.sheet.getRange(rowObj._row, c + 1).setValue(toCell_(patch[k]));
  });
}

function findById_(t, id, optional) {
  for (var i = 0; i < t.rows.length; i++) if (String(t.rows[i].id) === String(id)) return t.rows[i];
  if (optional) return null;
  fail_('not_found', MSG.notFound);
}

function activeEventRow_() {
  var rows = readTable_('Events').rows;
  for (var i = 0; i < rows.length; i++) if (toBool_(rows[i].active)) return rows[i];
  return null;
}

/** Normalises a sheet row into clean JSON (booleans, strings, phone with leading 0). */
function publicRow_(name, r) {
  var def = SHEETS[name], out = {};
  def.headers.forEach(function (h) {
    var v = r[h];
    if (def.bools.indexOf(h) >= 0) out[h] = toBool_(v);
    else if (def.numbers && def.numbers.indexOf(h) >= 0) out[h] = v === '' || v === null || v === undefined ? null : Number(v);
    else if (h === 'phone') out[h] = normPhone_(v) || String(v === undefined ? '' : v);
    else out[h] = toIsoString_(v).replace(/^'/, '');
  });
  return out;
}

function setSetting_(key, value) {
  var t = readTable_('Settings');
  for (var i = 0; i < t.rows.length; i++) {
    if (String(t.rows[i].key) === key) { updateRow_(t, t.rows[i], { value: String(value) }); return; }
  }
  appendRow_(t, { key: key, value: String(value) });
}

/* ============================================================================
   Misc
   ============================================================================ */

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) fail_('busy', MSG.busy);
  try { return fn(); } finally { lock.releaseLock(); }
}

function notify_(kind, row, ev) {
  try {
    var to = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');
    if (!to) return;
    var subject, lines;
    if (kind === 'register') {
      subject = 'הרשמה חדשה להרצאה: ' + row.fullName;
      lines = [
        'נרשם/ה חדש/ה להרצאת הזום' + (ev && ev.title ? ' "' + ev.title + '"' : '') + ':',
        '', 'שם: ' + row.fullName, 'טלפון: ' + row.phone, 'אימייל: ' + row.email,
        'עיר: ' + (row.city || '-'), '', 'הסטטוס: ממתין לתשלום. אפשר לסמן תשלום במסך הניהול.'
      ];
    } else {
      subject = 'פנייה חדשה להזמנת הרצאה' + (row.fullName ? ': ' + row.fullName : '');
      lines = ['התקבלה פנייה חדשה מהאתר:', '', 'שם: ' + (row.fullName || '-'), 'טלפון: ' + row.phone,
               'סוג ארגון: ' + (row.orgType || '-'), 'סוג הרצאה: ' + (row.lectureType || '-'), '', 'הודעה:', row.message || '-'];
    }
    MailApp.sendEmail({ to: to, subject: subject.slice(0, 200), body: lines.join('\n') });
  } catch (err) {
    console.error('notify failed: ' + err);
  }
}

function newId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}
function fakeId_() { return newId_('r'); }
function generateKey_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40);
}
function merge_(a, b) {
  var o = {}, k;
  for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k];
  for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k];
  return o;
}

function fail_(code, message, extra) {
  var e = new Error(message);
  e.appCode = code;
  e.extra = extra || null;
  throw e;
}

function errorOut_(err) {
  if (err && err.appCode) {
    var o = { ok: false, error: err.appCode, message: err.message };
    if (err.extra && err.extra.fieldErrors) o.fieldErrors = err.extra.fieldErrors;
    return o;
  }
  console.error(err && err.stack ? err.stack : String(err));
  return { ok: false, error: 'server', message: MSG.server };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
