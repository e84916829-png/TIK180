/*
 * TIK180: shared API client for the public page and the admin panel.
 *
 *   TIK_API.isDemo                    → true when TIK_CONFIG.apiUrl is empty
 *   TIK_API.getEvent()                → Promise<{id,title,dateISO,price,duration,zoomNote} | null>
 *   TIK_API.register(data)            → Promise<{ok,id,duplicate}>
 *   TIK_API.contact(data)             → Promise<{ok,id}>
 *   TIK_API.setAdminKey(key) / clearAdminKey()
 *   TIK_API.admin.list() / ping() / setPaid(id,bool) / setZoomSent(id,bool) / setNote(id,text)
 *                 / markContactHandled(id,bool) / upsertEvent(event) / deleteRegistration(id)
 *
 * Every rejection is an Error with:
 *   .code         'network' | 'timeout' | 'bad_response' | server code ('validation','unauthorized',...)
 *   .userMessage  Hebrew text that can be shown as-is
 *   .fieldErrors  optional { fieldName: 'Hebrew message' }
 *
 * Transport: POST with the body as a plain JSON string and NO custom headers, so the
 * browser sends Content-Type: text/plain and skips the CORS preflight that Apps Script
 * can't answer. The admin key travels in the POST body, never in the URL.
 *
 * DEMO mode (apiUrl empty): an in-browser fake backend with the same behaviour as
 * Code.gs. Its data lives only in this browser (localStorage) and is obviously fake.
 */
(function () {
  'use strict';

  var cfg = window.TIK_CONFIG || {};
  var API_URL = String(cfg.apiUrl || '').trim();
  var DEMO = !API_URL;
  var TIMEOUT_MS = cfg.timeoutMs || 20000; // Apps Script "cold starts" can take several seconds
  var RETRY_DELAY_MS = 800;
  var PHONE_HINT = ' אפשר גם להתקשר ל-058-3674925.';

  var MSG = {
    network: 'אין חיבור לשרת. כדאי לבדוק את החיבור לאינטרנט ולנסות שוב.',
    timeout: 'השרת לא הגיב בזמן. נא לנסות שוב בעוד רגע.',
    badResponse: 'התקבלה תשובה לא צפויה מהשרת. ייתכן שה-Web App לא פורסם עם הרשאת "Anyone" (ראו SETUP.md).',
    unknown: 'משהו השתבש. נא לנסות שוב.'
  };

  if (DEMO) {
    try {
      console.info('%c[TIK180] מצב דמו (DEMO): apiUrl ריק ב-config.js. שום פרט לא נשלח לשרת.', 'color:#D4B06E;font-weight:bold');
    } catch (e) { /* no console */ }
  }

  /* ------------------------------------------------------------------ errors */
  function apiError(code, userMessage, fieldErrors) {
    var e = new Error(userMessage || MSG.unknown);
    e.code = code;
    e.userMessage = userMessage || MSG.unknown;
    if (fieldErrors) e.fieldErrors = fieldErrors;
    return e;
  }
  function fromServer(json) {
    if (json && json.ok) return json;
    if (!json || typeof json !== 'object') throw apiError('bad_response', MSG.badResponse);
    throw apiError(json.error || 'server', json.message || MSG.unknown, json.fieldErrors);
  }

  /* --------------------------------------------------------------- transport */
  function fetchWithTimeout(url, init) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer;
    if (ctrl) init.signal = ctrl.signal;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { if (ctrl) ctrl.abort(); reject(apiError('timeout', MSG.timeout)); }, TIMEOUT_MS);
    });
    var req = fetch(url, init).then(function (res) {
      return res.text().then(function (text) {
        var json;
        try { json = JSON.parse(text); } catch (e) { throw apiError('bad_response', MSG.badResponse); }
        return json;
      });
    }, function (err) {
      if (err && err.code) throw err;
      if (err && err.name === 'AbortError') throw apiError('timeout', MSG.timeout);
      throw apiError('network', MSG.network);
    });
    return Promise.race([req, timeout]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }

  /** Retries once, only when the request never reached the server (network error). */
  function withRetry(fn) {
    return fn().catch(function (err) {
      if (!err || err.code !== 'network') throw err;
      return new Promise(function (r) { setTimeout(r, RETRY_DELAY_MS); }).then(fn);
    });
  }

  function httpGet(params) {
    var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    var url = API_URL + (API_URL.indexOf('?') >= 0 ? '&' : '?') + qs + '&_=' + Date.now();
    return withRetry(function () { return fetchWithTimeout(url, { method: 'GET', redirect: 'follow', credentials: 'omit' }); }).then(fromServer);
  }

  function httpPost(payload) {
    var body = JSON.stringify(payload);
    // No headers on purpose: a string body is sent as text/plain → no CORS preflight.
    return withRetry(function () { return fetchWithTimeout(API_URL, { method: 'POST', body: body, redirect: 'follow', credentials: 'omit' }); }).then(fromServer);
  }

  /* ------------------------------------------------------------ public calls */
  function pickPublic(data, fields) {
    var o = {};
    fields.forEach(function (f) { if (data && data[f] !== undefined) o[f] = data[f]; });
    return o;
  }
  function addPhoneHint(err) {
    if (err && err.code !== 'validation' && err.code !== 'rate_limited' && err.userMessage && err.userMessage.indexOf('058') < 0) {
      err.userMessage += PHONE_HINT;
    }
    throw err;
  }

  var transport = {
    getEvent: function () { return httpGet({ action: 'event' }).then(function (r) { return r.event || null; }); },
    call: function (action, payload) { var p = payload || {}; p.action = action; return httpPost(p); }
  };

  function getEvent() {
    return transport.getEvent();
  }

  function register(data) {
    var p = pickPublic(data, ['fullName', 'phone', 'email', 'city', 'source', 'consent', 'website']);
    p.website = p.website || '';
    p.userAgent = (navigator.userAgent || '').slice(0, 300);
    if (data && data.event && data.event.id) p.eventId = data.event.id;
    return transport.call('register', p).catch(addPhoneHint);
  }

  function contact(data) {
    var p = pickPublic(data, ['fullName', 'phone', 'orgType', 'lectureType', 'message', 'website']);
    p.website = p.website || '';
    return transport.call('contact', p).catch(addPhoneHint);
  }

  /* ------------------------------------------------------------- admin calls */
  var adminKey = '';
  function admin(action, payload) {
    if (!adminKey) return Promise.reject(apiError('unauthorized', 'נדרשת כניסה מחדש.'));
    var p = payload || {};
    p.key = adminKey;
    return transport.call(action, p);
  }
  var adminApi = {
    ping: function () { return admin('ping'); },
    list: function (opts) { return admin('list', { includeDeleted: !!(opts && opts.includeDeleted) }); },
    setPaid: function (id, value) { return admin('setPaid', { id: id, value: !!value }); },
    setZoomSent: function (id, value) { return admin('setZoomSent', { id: id, value: !!value }); },
    setNote: function (id, notes) { return admin('setNote', { id: id, notes: String(notes || '') }); },
    markContactHandled: function (id, value) { return admin('markContactHandled', { id: id, value: value !== false }); },
    upsertEvent: function (ev) { return admin('upsertEvent', { event: ev }); },
    deleteRegistration: function (id) { return admin('deleteRegistration', { id: id }); }
  };

  /* ======================================================================
     DEMO backend: mirrors Code.gs semantics, data stays in this browser
     ====================================================================== */
  var demo = null;
  if (DEMO) demo = (function () {
    var STORE_KEY = 'tik180-demo-v1';
    var DEMO_KEY = 'demo';
    var state = null;
    var failNext = false;

    function rng(seed) { return function () { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
    function uid(p) { return p + '_demo' + Math.random().toString(36).slice(2, 10); }
    function iso(d) { return new Date(d).toISOString(); }

    function generate() {
      var R = rng(180);
      var first = ['ישראל', 'מיכל', 'יוסי', 'רונית', 'אבי', 'שירה', 'דוד', 'נועה', 'משה', 'טל', 'אורית', 'עומר', 'ליאת', 'אליהו', 'הדס', 'גיל', 'סיגל', 'יעל', 'רפאל', 'דנה', 'עמית', 'נטע', 'חיים', 'מורן'];
      var last = ['ישראלי', 'כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'אברהם', 'פרידמן', 'שושן', 'דהן', 'אזולאי', 'גבאי'];
      var cities = ['תל אביב', 'חיפה', 'ירושלים', 'באר שבע', 'נתניה', 'ראשון לציון', 'אשדוד', '', 'פתח תקווה', ''];
      var sources = ['facebook', 'instagram', 'friend', 'organization', 'other', '', 'facebook', 'friend'];
      var now = Date.now();
      var evActive = { id: 'e_demo_next', title: 'האירוע הקרוב - הרצאת זום', dateISO: '', price: 79, duration: '60 דקות',
        zoomLink: 'https://zoom.us/j/0000000000?pwd=DEMO', notes: 'הערה פנימית לדוגמה (דמו)', active: true,
        publicNote: 'קישור הזום יישלח לאחר התשלום', updatedAt: iso(now - 864e5 * 2) };
      var evPast = { id: 'e_demo_past', title: 'הרצאת זום - ספטמבר (דמו)', dateISO: '2026-09-17T20:00:00+03:00', price: 79, duration: '60 דקות',
        zoomLink: 'https://zoom.us/j/1111111111?pwd=DEMO', notes: '', active: false, publicNote: 'קישור הזום יישלח לאחר התשלום', updatedAt: iso(now - 864e5 * 40) };
      var regs = [];
      for (var i = 0; i < 26; i++) {
        var past = i >= 19;
        var name = i === 0 ? 'ישראל ישראלי' : first[i % first.length] + ' ' + last[Math.floor(R() * last.length)];
        var paid = past ? true : R() < 0.58;
        var created = now - Math.floor(R() * 864e5 * (past ? 50 : 12)) - (past ? 864e5 * 30 : 0);
        regs.push({
          id: 'r_demo' + (1000 + i), createdAt: iso(created), eventId: past ? evPast.id : evActive.id,
          fullName: name + ' (דמו)', phone: '05' + (i % 9) + '0000' + String(100 + i),
          email: 'demo' + (i + 1) + '@example.com', city: cities[Math.floor(R() * cities.length)],
          source: sources[Math.floor(R() * sources.length)], consent: R() < 0.8,
          paid: paid, paidAt: paid ? iso(created + 36e5 * (1 + Math.floor(R() * 20))) : '',
          zoomSent: past ? true : (paid && R() < 0.4), notes: i === 3 ? 'שילם/ה בהעברה בנקאית (דמו)' : (i === 7 ? 'ביקש/ה חשבונית (דמו)' : ''),
          userAgent: 'demo', deleted: false
        });
      }
      var contacts = [
        { fullName: 'רכזת חינוך (דמו)', orgType: 'school', lectureType: 'frontal', message: 'מעוניינים בהרצאה לשכבת י"א, כ-120 תלמידים, בחודש דצמבר. (דמו)', handled: false, d: 0.4 },
        { fullName: 'מנהל משאבי אנוש (דמו)', orgType: 'company', lectureType: 'zoom', message: 'הרצאה לעובדים בזום, אפשר הצעת מחיר? (דמו)', handled: false, d: 1.6 },
        { fullName: '', orgType: 'community', lectureType: 'unsure', message: '', handled: false, d: 3.2 },
        { fullName: 'מתנ"ס לדוגמה (דמו)', orgType: 'community', lectureType: 'frontal', message: 'ערב קהילתי, כ-80 משתתפים. (דמו)', handled: true, d: 9 },
        { fullName: 'עמותה לדוגמה (דמו)', orgType: 'other', lectureType: 'zoom', message: 'נשמח לפרטים. (דמו)', handled: true, d: 21 }
      ].map(function (c, i) {
        return { id: 'c_demo' + (100 + i), createdAt: iso(now - c.d * 864e5), fullName: c.fullName, phone: '05' + (i + 2) + '0000' + (200 + i),
          orgType: c.orgType, lectureType: c.lectureType, message: c.message, handled: c.handled };
      });
      return { v: 1, registrations: regs, contacts: contacts, events: [evActive, evPast] };
    }

    function load() {
      if (state) return state;
      try { var raw = localStorage.getItem(STORE_KEY); if (raw) state = JSON.parse(raw); } catch (e) { state = null; }
      if (!state || state.v !== 1) state = generate();
      return state;
    }
    function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* private mode: in-memory only */ } }
    function reset() { state = generate(); save(); }
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function delay(v) {
      return new Promise(function (resolve, reject) {
        var f = failNext; failNext = false;
        setTimeout(function () { if (f) reject(apiError('network', MSG.network)); else resolve(clone(v)); }, 250 + Math.random() * 300);
      });
    }
    function activeEvent() { var e = load().events; for (var i = 0; i < e.length; i++) if (e[i].active) return e[i]; return null; }
    function find(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; throw apiError('not_found', 'הרשומה לא נמצאה (ייתכן שנמחקה).'); }
    function normPhone(v) { var s = String(v || '').replace(/[\s\-().]/g, ''); var m = s.match(/^\+?972(\d{8,9})$/); if (m) s = '0' + m[1]; return /^0\d{8,9}$/.test(s) ? s : ''; }

    function stats(s) {
      var ev = activeEvent();
      var mine = s.registrations.filter(function (r) { return !r.deleted && ev && r.eventId === ev.id; });
      var paid = mine.filter(function (r) { return r.paid; }).length;
      return { activeEventId: ev ? ev.id : null, total: mine.length, paid: paid, unpaid: mine.length - paid,
        zoomSent: mine.filter(function (r) { return r.zoomSent; }).length, revenue: paid * (ev ? Number(ev.price) || 0 : 0),
        newContacts: s.contacts.filter(function (c) { return !c.handled; }).length };
    }

    var handlers = {
      register: function (p) {
        if (p.website) return { ok: true, id: uid('r') };
        var s = load(), ev = activeEvent(), phone = normPhone(p.phone);
        var fe = {};
        if (!p.fullName || String(p.fullName).trim().length < 2) fe.fullName = 'נא להזין שם מלא (לפחות 2 תווים)';
        if (!phone) fe.phone = 'מספר הטלפון לא תקין. לדוגמה: 050-1234567';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(p.email || ''))) fe.email = 'כתובת האימייל לא תקינה. לדוגמה: name@example.com';
        if (Object.keys(fe).length) throw apiError('validation', 'חלק מהפרטים לא תקינים. נא לבדוק ולנסות שוב.', fe);
        for (var i = 0; i < s.registrations.length; i++) {
          var r = s.registrations[i];
          if (!r.deleted && ev && r.eventId === ev.id && r.phone === phone) return { ok: true, id: r.id, duplicate: true };
        }
        var row = { id: uid('r'), createdAt: iso(Date.now()), eventId: ev ? ev.id : '', fullName: String(p.fullName).trim().slice(0, 80),
          phone: phone, email: String(p.email).trim().toLowerCase(), city: String(p.city || '').slice(0, 60), source: p.source || '',
          consent: !!p.consent, paid: false, paidAt: '', zoomSent: false, notes: '', userAgent: 'demo', deleted: false };
        s.registrations.push(row); save();
        return { ok: true, id: row.id, duplicate: false };
      },
      contact: function (p) {
        if (p.website) return { ok: true, id: uid('c') };
        var phone = normPhone(p.phone);
        if (!phone) throw apiError('validation', 'חלק מהפרטים לא תקינים. נא לבדוק ולנסות שוב.', { phone: 'מספר הטלפון לא תקין. לדוגמה: 050-1234567' });
        var row = { id: uid('c'), createdAt: iso(Date.now()), fullName: String(p.fullName || '').slice(0, 80), phone: phone,
          orgType: p.orgType || '', lectureType: p.lectureType || '', message: String(p.message || '').slice(0, 2000), handled: false };
        load().contacts.push(row); save();
        return { ok: true, id: row.id };
      },
      ping: function () { return { ok: true }; },
      list: function (p) {
        var s = load();
        return { ok: true, registrations: s.registrations.filter(function (r) { return p.includeDeleted || !r.deleted; }),
          contacts: s.contacts, events: s.events, stats: stats(s), serverTime: iso(Date.now()) };
      },
      setPaid: function (p) { var r = find(load().registrations, p.id); r.paid = !!p.value; r.paidAt = r.paid ? iso(Date.now()) : ''; save(); return { ok: true, registration: r }; },
      setZoomSent: function (p) { var r = find(load().registrations, p.id); r.zoomSent = !!p.value; save(); return { ok: true, registration: r }; },
      setNote: function (p) { var r = find(load().registrations, p.id); r.notes = String(p.notes || '').slice(0, 1000); save(); return { ok: true, registration: r }; },
      markContactHandled: function (p) { var c = find(load().contacts, p.id); c.handled = p.value !== false; save(); return { ok: true, contact: c }; },
      deleteRegistration: function (p) { var r = find(load().registrations, p.id); r.deleted = true; save(); return { ok: true, id: r.id, deleted: true }; },
      upsertEvent: function (p) {
        var e = p.event || {}, s = load(), fe = {};
        if (!e.title || !String(e.title).trim()) fe.title = 'נא להזין כותרת';
        var price = Number(e.price);
        if (e.price === '' || e.price === null || !isFinite(price) || price < 0) fe.price = 'מחיר לא תקין';
        if (e.zoomLink && !/^https:\/\/\S+$/i.test(e.zoomLink)) fe.zoomLink = 'קישור לא תקין (חייב להתחיל ב-https://)';
        if (e.dateISO && isNaN(new Date(e.dateISO).getTime())) fe.dateISO = 'תאריך לא תקין';
        if (Object.keys(fe).length) throw apiError('validation', 'חלק מהפרטים לא תקינים. נא לבדוק ולנסות שוב.', fe);
        var data = { title: String(e.title).trim(), dateISO: e.dateISO || '', price: price, duration: e.duration || '', zoomLink: e.zoomLink || '',
          notes: e.notes || '', active: !!e.active, publicNote: e.publicNote || '', updatedAt: iso(Date.now()) };
        var ev = null;
        for (var i = 0; i < s.events.length; i++) if (e.id && s.events[i].id === e.id) ev = s.events[i];
        if (ev) { for (var k in data) ev[k] = data[k]; } else { data.id = uid('e'); s.events.push(data); ev = data; }
        if (ev.active) s.events.forEach(function (x) { if (x !== ev) x.active = false; });
        save();
        return { ok: true, event: ev };
      }
    };

    return {
      key: DEMO_KEY,
      reset: reset,
      failNext: function () { failNext = true; },
      getEvent: function () {
        var ev = activeEvent();
        return delay(ev ? { id: ev.id, title: ev.title, dateISO: ev.dateISO || null, price: ev.price, duration: ev.duration, zoomNote: ev.publicNote } : null);
      },
      call: function (action, p) {
        if (!handlers[action]) return Promise.reject(apiError('unknown_action', 'פעולה לא מוכרת.'));
        var res;
        try { res = handlers[action](p || {}); } catch (err) { return delay(null).then(function () { throw err; }); }
        return delay(res);
      }
    };
  })();

  if (DEMO) transport = { getEvent: demo.getEvent, call: demo.call };

  window.TIK_API = {
    isDemo: DEMO,
    apiUrl: API_URL,
    getEvent: getEvent,
    register: register,
    contact: contact,
    setAdminKey: function (k) { adminKey = String(k || ''); },
    clearAdminKey: function () { adminKey = ''; },
    admin: adminApi,
    demo: DEMO ? { reset: demo.reset, failNext: demo.failNext } : null
  };
})();
