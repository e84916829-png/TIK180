/* Unit tests for apps-script/Code.gs. Run:  node site/tests/code.test.js   (no dependencies) */
'use strict';
const assert = require('assert');
const { createEnv } = require('./mock-gas');

const KEY = 'test-admin-key-0123456789abcdef';
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e)); }
}
function fresh(opts) {
  const env = createEnv(Object.assign({ props: { ADMIN_KEY: KEY } }, opts || {}));
  env.run('setup');
  return env;
}
const good = (o) => Object.assign({ action: 'register', fullName: 'ישראל ישראלי', phone: '050-1234567', email: 'Test@Example.com', city: 'חיפה', source: 'facebook', consent: true, website: '' }, o || {});
const listRegs = env => env.post({ action: 'list', key: KEY }).registrations;

console.log('\nsetup');
test('setup() creates all four sheets with headers and one default active event', () => {
  const env = createEnv();
  env.run('setup');
  ['Registrations', 'Contacts', 'Events', 'Settings'].forEach(n => assert.ok(env.sheet(n), n + ' missing'));
  const h = env.sheet('Registrations').cells[0].map(c => c.value);
  ['id', 'createdAt', 'eventId', 'fullName', 'phone', 'email', 'city', 'source', 'consent', 'paid', 'paidAt', 'zoomSent', 'notes', 'userAgent', 'deleted']
    .forEach(c => assert.ok(h.includes(c), 'column ' + c));
  const ev = env.sheet('Events').rowsAsObjects();
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].active, true);
});
test('setup() generates a strong ADMIN_KEY when the placeholder is untouched, and prints it', () => {
  const env = createEnv();
  env.run('setup');
  assert.ok(env.props.ADMIN_KEY && env.props.ADMIN_KEY.length >= 32);
  assert.ok(env.logs.some(l => l.includes(env.props.ADMIN_KEY)));
});
test('setup() is idempotent (no duplicate events, key unchanged)', () => {
  const env = fresh();
  env.run('setup');
  assert.strictEqual(env.sheet('Events').rowsAsObjects().length, 1);
  assert.strictEqual(env.props.ADMIN_KEY, KEY);
});
test('rotateAdminKey() replaces the key; old key is rejected afterwards', () => {
  const env = fresh();
  env.run('rotateAdminKey');
  assert.notStrictEqual(env.props.ADMIN_KEY, KEY);
  assert.strictEqual(env.post({ action: 'list', key: KEY }).error, 'unauthorized');
  assert.strictEqual(env.post({ action: 'list', key: env.props.ADMIN_KEY }).ok, true);
});

console.log('\nregister');
test('valid registration is stored with normalized phone + lowercased email, under a lock', () => {
  const env = fresh();
  const r = env.post(good());
  assert.strictEqual(r.ok, true); assert.ok(r.id); assert.strictEqual(r.duplicate, false);
  const rows = env.sheet('Registrations').rowsAsObjects();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].phone, '0501234567');
  assert.strictEqual(rows[0].email, 'test@example.com');
  assert.strictEqual(rows[0].paid, false);
  assert.strictEqual(rows[0].consent, true);
  assert.ok(env.lockCalls >= 1); assert.strictEqual(env.lockHeld, 0);
  const ev = env.sheet('Events').rowsAsObjects()[0];
  assert.strictEqual(rows[0].eventId, ev.id);
});
test('+972 phone is normalized to 05X', () => {
  const env = fresh();
  env.post(good({ phone: '+972 50-123-4567' }));
  assert.strictEqual(env.sheet('Registrations').rowsAsObjects()[0].phone, '0501234567');
});
test('invalid name / phone / email → ok:false with Hebrew fieldErrors, nothing stored', () => {
  const env = fresh();
  const r = env.post(good({ fullName: 'א', phone: '12345', email: 'nope' }));
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'validation');
  assert.deepStrictEqual(Object.keys(r.fieldErrors).sort(), ['email', 'fullName', 'phone']);
  assert.ok(/[֐-׿]/.test(r.message));
  assert.strictEqual(env.sheet('Registrations').rowsAsObjects().length, 0);
});
test('over-long fields are rejected (length limits)', () => {
  const env = fresh();
  assert.strictEqual(env.post(good({ fullName: 'א'.repeat(81) })).fieldErrors.fullName !== undefined, true);
  assert.strictEqual(env.post(good({ city: 'x'.repeat(61) })).fieldErrors.city !== undefined, true);
  assert.strictEqual(env.post(good({ email: 'a'.repeat(120) + '@x.com' })).fieldErrors.email !== undefined, true);
  assert.strictEqual(env.sheet('Registrations').rowsAsObjects().length, 0);
});
test('huge / malformed bodies are rejected', () => {
  const env = fresh();
  assert.strictEqual(env.post('x'.repeat(30000)).error, 'bad_request');
  assert.strictEqual(env.post('{not json').error, 'bad_request');
  assert.strictEqual(env.post('[1,2]').error, 'bad_request');
  assert.strictEqual(env.post({ action: 'nope' }).error, 'unknown_action');
});
test('honeypot "website" filled → fake success, nothing stored, no email', () => {
  const env = fresh({ props: { ADMIN_KEY: KEY, NOTIFY_EMAIL: 'owner@example.com' } });
  const r = env.post(good({ website: 'http://spam.example' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(env.sheet('Registrations').rowsAsObjects().length, 0);
  assert.strictEqual(env.mails.length, 0);
  const c = env.post({ action: 'contact', phone: '0501234567', website: 'x' });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(env.sheet('Contacts').rowsAsObjects().length, 0);
});
test('same phone for the same event → {ok:true, duplicate:true}, same id, single row', () => {
  const env = fresh();
  const a = env.post(good());
  const b = env.post(good({ phone: '+972501234567', fullName: 'שם אחר' }));
  assert.strictEqual(b.ok, true); assert.strictEqual(b.duplicate, true); assert.strictEqual(b.id, a.id);
  assert.strictEqual(env.sheet('Registrations').rowsAsObjects().length, 1);
});
test('same phone after switching the active event is NOT a duplicate', () => {
  const env = fresh();
  env.post(good());
  env.post({ action: 'upsertEvent', key: KEY, event: { title: 'הרצאה חדשה', dateISO: '2026-12-01T20:00:00+02:00', price: 79, active: true } });
  const r = env.post(good());
  assert.strictEqual(r.duplicate, false);
  assert.strictEqual(env.sheet('Registrations').rowsAsObjects().length, 2);
});
test('soft-deleted registration does not block re-registering', () => {
  const env = fresh();
  const a = env.post(good());
  env.post({ action: 'deleteRegistration', key: KEY, id: a.id });
  const b = env.post(good());
  assert.strictEqual(b.duplicate, false);
});
test('formula injection is neutralised with a leading apostrophe for = + - @', () => {
  const env = fresh();
  env.post(good({ fullName: '=HYPERLINK("http://evil","x")', city: '+SUM(A1)', phone: '0521111111' }));
  env.post(good({ fullName: '@cmd', city: '-2+3', phone: '0522222222' }));
  const rows = env.sheet('Registrations').rowsAsObjects();
  assert.strictEqual(rows[0].__raw_fullName, '\'=HYPERLINK("http://evil","x")');
  assert.strictEqual(rows[0].__raw_city, "'+SUM(A1)");
  assert.strictEqual(rows[1].__raw_fullName, "'@cmd");
  assert.strictEqual(rows[1].__raw_city, "'-2+3");
  // every string written to any sheet that starts with a formula char is prefixed
  Object.values(env.ss.sheets).forEach(sh => sh.rawWrites.forEach(v => {
    if (typeof v === 'string') assert.ok(!/^[=+\-@]/.test(v), sh.name + ' wrote unsafe value: ' + v);
  }));
  // and the admin sees the original text
  const regs = listRegs(env);
  assert.strictEqual(regs[0].fullName, '=HYPERLINK("http://evil","x")');
});
test('phones keep their leading zero in the sheet (stored as text)', () => {
  const env = fresh();
  env.post(good());
  assert.strictEqual(env.sheet('Registrations').rowsAsObjects()[0].__raw_phone, "'0501234567");
});
test('unknown source values are coerced, control chars stripped', () => {
  const env = fresh();
  env.post(good({ source: '<script>', fullName: 'דנה\u0000 כהן\n' }));
  const r = env.sheet('Registrations').rowsAsObjects()[0];
  assert.strictEqual(r.source, 'other');
  assert.strictEqual(r.fullName, 'דנה כהן');
});
test('NOTIFY_EMAIL off by default; on when set', () => {
  const env = fresh();
  env.post(good());
  assert.strictEqual(env.mails.length, 0);
  const env2 = fresh({ props: { ADMIN_KEY: KEY, NOTIFY_EMAIL: 'owner@example.com' } });
  env2.post(good());
  assert.strictEqual(env2.mails.length, 1);
  assert.strictEqual(env2.mails[0].to, 'owner@example.com');
  assert.ok(/הרשמה חדשה/.test(env2.mails[0].subject));
});
test('per-phone rate limit kicks in', () => {
  const env = fresh();
  let last;
  for (let i = 0; i < 8; i++) last = env.post(good());
  assert.strictEqual(last.error, 'rate_limited');
});
test('lock timeout → busy error in Hebrew', () => {
  const env = createEnv({ props: { ADMIN_KEY: KEY }, lockFails: true });
  const r = env.post(good());
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'busy');
});

console.log('\ncontact');
test('valid contact stored; invalid phone rejected; long message rejected', () => {
  const env = fresh();
  assert.strictEqual(env.post({ action: 'contact', fullName: 'רונית', phone: '03-1234567', orgType: 'school', lectureType: 'frontal', message: 'שלום\nרב' }).ok, true);
  assert.strictEqual(env.post({ action: 'contact', phone: '999' }).fieldErrors.phone !== undefined, true);
  assert.strictEqual(env.post({ action: 'contact', phone: '0501234567', message: 'x'.repeat(2001) }).fieldErrors.message !== undefined, true);
  const rows = env.sheet('Contacts').rowsAsObjects();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].phone, '031234567');
  assert.strictEqual(rows[0].message, 'שלום\nרב');
  assert.strictEqual(rows[0].handled, false);
});

console.log('\npublic event');
test('GET action=event never exposes zoomLink or internal notes', () => {
  const env = fresh();
  env.post({ action: 'upsertEvent', key: KEY, event: { title: 'ערב זום', dateISO: '2026-11-12T20:00:00+02:00', price: 79, duration: '60 דקות', zoomLink: 'https://zoom.us/j/SECRET123', notes: 'INTERNAL-NOTE', publicNote: 'הקישור יישלח', active: true } });
  const raw = env.rawGet({ action: 'event' });
  assert.ok(!raw.includes('SECRET123'), 'zoom link leaked');
  assert.ok(!raw.includes('zoom.us'), 'zoom domain leaked');
  assert.ok(!raw.includes('INTERNAL-NOTE'), 'internal notes leaked');
  const ev = JSON.parse(raw).event;
  assert.deepStrictEqual(Object.keys(ev).sort(), ['dateISO', 'duration', 'id', 'price', 'title', 'zoomNote']);
  assert.strictEqual(ev.dateISO, '2026-11-12T20:00:00+02:00');
  assert.strictEqual(ev.price, 79);
  assert.strictEqual(ev.zoomNote, 'הקישור יישלח');
  const viaPost = JSON.stringify(env.post({ action: 'event' }));
  assert.ok(!viaPost.includes('SECRET123'));
});
test('event with no date returns dateISO null; no active event returns null', () => {
  const env = fresh();
  assert.strictEqual(env.get({ action: 'event' }).event.dateISO, null);
  const env2 = createEnv({ props: { ADMIN_KEY: KEY } });
  assert.strictEqual(env2.get({ action: 'event' }).event, null);
});
test('register errors never leak zoomLink either', () => {
  const env = fresh();
  env.post({ action: 'upsertEvent', key: KEY, event: { title: 'x', price: 79, zoomLink: 'https://zoom.us/j/SECRET123', active: true } });
  assert.ok(!JSON.stringify(env.post(good())).includes('SECRET'));
  assert.ok(!JSON.stringify(env.post(good())).includes('SECRET'));
});

console.log('\nadmin auth');
test('admin actions reject missing / wrong / non-string keys', () => {
  const env = fresh();
  const a = env.post(good());
  const actions = [
    { action: 'list' }, { action: 'setPaid', id: a.id, value: true }, { action: 'setZoomSent', id: a.id, value: true },
    { action: 'setNote', id: a.id, notes: 'x' }, { action: 'markContactHandled', id: 'c_1' },
    { action: 'upsertEvent', event: { title: 't', price: 1 } }, { action: 'deleteRegistration', id: a.id }
  ];
  actions.forEach(body => {
    [undefined, '', 'wrong', KEY + 'x', KEY.slice(0, -1), ['x'], { k: 1 }].forEach(key => {
      const r = env.post(Object.assign({}, body, key === undefined ? {} : { key }));
      assert.strictEqual(r.ok, false, body.action + ' accepted key ' + JSON.stringify(key));
      assert.strictEqual(r.error, 'unauthorized');
    });
  });
  assert.strictEqual(env.get({ action: 'list', key: 'wrong' }).error, 'unauthorized');
  const row = env.sheet('Registrations').rowsAsObjects()[0];
  assert.strictEqual(row.paid, false); assert.strictEqual(row.deleted, false);
});
test('admin actions refuse to work when ADMIN_KEY was never set', () => {
  const env = createEnv();
  assert.strictEqual(env.post({ action: 'list', key: '' }).error, 'not_configured');
  assert.strictEqual(env.post({ action: 'list', key: 'null' }).error, 'not_configured');
});
test('list returns registrations, contacts, events (with zoomLink for admin) and stats', () => {
  const env = fresh();
  env.post({ action: 'upsertEvent', key: KEY, event: { id: env.sheet('Events').rowsAsObjects()[0].id, title: 'ערב', price: 79, zoomLink: 'https://zoom.us/j/1', active: true } });
  env.post(good({ phone: '0501111111' })); const b = env.post(good({ phone: '0502222222' })); env.post(good({ phone: '0503333333' }));
  env.post({ action: 'contact', phone: '0504444444' });
  env.post({ action: 'setPaid', key: KEY, id: b.id, value: true });
  const r = env.post({ action: 'list', key: KEY });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.registrations.length, 3);
  assert.strictEqual(r.contacts.length, 1);
  assert.strictEqual(r.events[0].zoomLink, 'https://zoom.us/j/1');
  assert.deepStrictEqual(
    { total: r.stats.total, paid: r.stats.paid, unpaid: r.stats.unpaid, revenue: r.stats.revenue, newContacts: r.stats.newContacts },
    { total: 3, paid: 1, unpaid: 2, revenue: 79, newContacts: 1 });
  assert.strictEqual(typeof r.registrations[0].paid, 'boolean');
  assert.strictEqual(r.registrations[0].phone, '0501111111');
});

console.log('\nadmin writes');
test('setPaid true/false sets and clears paidAt', () => {
  const env = fresh();
  const a = env.post(good());
  const r1 = env.post({ action: 'setPaid', key: KEY, id: a.id, value: true });
  assert.strictEqual(r1.ok, true); assert.strictEqual(r1.registration.paid, true); assert.ok(r1.registration.paidAt);
  let row = env.sheet('Registrations').rowsAsObjects()[0];
  assert.strictEqual(row.paid, true); assert.ok(row.paidAt);
  const r2 = env.post({ action: 'setPaid', key: KEY, id: a.id, value: false });
  assert.strictEqual(r2.registration.paid, false);
  row = env.sheet('Registrations').rowsAsObjects()[0];
  assert.strictEqual(row.paid, false); assert.strictEqual(row.paidAt, '');
});
test('setPaid on unknown / malformed id → not_found / bad_request', () => {
  const env = fresh();
  assert.strictEqual(env.post({ action: 'setPaid', key: KEY, id: 'r_doesnotexist', value: true }).error, 'not_found');
  assert.strictEqual(env.post({ action: 'setPaid', key: KEY, id: '=1+1', value: true }).error, 'bad_request');
  assert.strictEqual(env.post({ action: 'setPaid', key: KEY, value: true }).error, 'bad_request');
});
test('setZoomSent, setNote (with injection) and markContactHandled', () => {
  const env = fresh();
  const a = env.post(good());
  assert.strictEqual(env.post({ action: 'setZoomSent', key: KEY, id: a.id, value: true }).registration.zoomSent, true);
  assert.strictEqual(env.post({ action: 'setNote', key: KEY, id: a.id, notes: '=1+1 שילם במזומן' }).registration.notes, '=1+1 שילם במזומן');
  const row = env.sheet('Registrations').rowsAsObjects()[0];
  assert.strictEqual(row.__raw_notes, "'=1+1 שילם במזומן");
  assert.strictEqual(row.zoomSent, true);
  const c = env.post({ action: 'contact', phone: '0501234567' });
  assert.strictEqual(env.post({ action: 'markContactHandled', key: KEY, id: c.id }).contact.handled, true);
  assert.strictEqual(env.post({ action: 'markContactHandled', key: KEY, id: c.id, handled: false }).contact.handled, false);
});
test('deleteRegistration is a soft delete: row stays, flagged deleted, hidden from list', () => {
  const env = fresh();
  const a = env.post(good());
  assert.strictEqual(env.post({ action: 'deleteRegistration', key: KEY, id: a.id }).ok, true);
  const rows = env.sheet('Registrations').rowsAsObjects();
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].deleted, true);
  assert.strictEqual(listRegs(env).length, 0);
  assert.strictEqual(env.post({ action: 'list', key: KEY, includeDeleted: true }).registrations.length, 1);
});
test('upsertEvent creates, updates, and deactivates the other events', () => {
  const env = fresh();
  const first = env.sheet('Events').rowsAsObjects()[0];
  const c = env.post({ action: 'upsertEvent', key: KEY, event: { title: 'ערב שני', dateISO: '2026-12-03T20:30:00+02:00', price: '99', duration: '75 דקות', zoomLink: 'https://zoom.us/j/2', active: true } });
  assert.strictEqual(c.ok, true); assert.ok(c.event.id !== first.id); assert.strictEqual(c.event.price, 99);
  let evs = env.sheet('Events').rowsAsObjects();
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(evs.filter(e => e.active === true).length, 1);
  assert.strictEqual(evs.find(e => e.active === true).id, c.event.id);
  assert.strictEqual(evs[1].__raw_dateISO, "'2026-12-03T20:30:00+02:00");
  assert.strictEqual(env.get({ action: 'event' }).event.title, 'ערב שני');
  // update the first and re-activate it
  const u = env.post({ action: 'upsertEvent', key: KEY, event: { id: first.id, title: 'ערב ראשון מעודכן', price: 79, active: true } });
  assert.strictEqual(u.event.id, first.id);
  evs = env.sheet('Events').rowsAsObjects();
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(evs.find(e => e.active === true).id, first.id);
  assert.strictEqual(env.get({ action: 'event' }).event.title, 'ערב ראשון מעודכן');
});
test('upsertEvent validation: title, price, date, non-https zoom link', () => {
  const env = fresh();
  const r = env.post({ action: 'upsertEvent', key: KEY, event: { title: '', price: -5, dateISO: '12/11/2026', zoomLink: 'javascript:alert(1)' } });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(Object.keys(r.fieldErrors).sort(), ['dateISO', 'price', 'title', 'zoomLink']);
});
test('every response is JSON via ContentService; unexpected exceptions do not leak stack traces', () => {
  const env = fresh();
  env.sandbox.SpreadsheetApp.getActiveSpreadsheet = () => { throw new Error('INTERNAL boom /secret/path'); };
  const r = env.post(good());
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'server');
  assert.ok(!JSON.stringify(r).includes('boom'));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
