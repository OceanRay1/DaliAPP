const express = require('express');
const initSqlJs = require('sql.js');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const RETENTION_DAYS = +(process.env.RETENTION_DAYS || 30);
const THRESHOLD = 0.72;
const DB_PATH = process.env.DB_PATH || 'data.db';

let db = null;

async function initDb() {
  const SQL = await initSqlJs();
  let data;
  try { data = fs.readFileSync(DB_PATH); } catch { data = null; }
  db = new SQL.Database(data);
  
  db.run(`CREATE TABLE IF NOT EXISTS people(
    id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, age INTEGER, age_group TEXT,
    description TEXT, shelter TEXT, visibility TEXT DEFAULT 'ask', contact_note TEXT,
    created_at INTEGER, updated_at INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS reports(
    id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, age INTEGER, description TEXT,
    seeker_name TEXT, seeker_contact TEXT, message TEXT, created_at INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS matches(
    id INTEGER PRIMARY KEY, report_id INTEGER, person_id INTEGER, score REAL,
    status TEXT DEFAULT 'pending', UNIQUE(report_id, person_id))`);
  
  saveDb();
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Helpers 
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; 
const newCode = () => Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
const now = () => Date.now();
const clean = (s, n = 300) => (s == null ? '' : String(s).trim().slice(0, n));
const toAge = (a) => { const n = parseInt(a, 10); return Number.isFinite(n) && n >= 0 && n < 120 ? n : null; };
const norm = (s) => clean(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Help be tolerant of spelling variants, order swaps, missing middle names, and o/slight changes
function nameScore(a, b) {
  const A = norm(a), B = norm(b);
  if (!A.length || !B.length) return 0;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  let total = 0;
  for (const t of short) total += Math.max(...long.map((u) => 1 - lev(t, u) / Math.max(t.length, u.length)));
  return total / short.length;
}
function ageOk(a, b, group) {
  if (a == null || b == null) return true;
  return Math.abs(a - b) <= (group === 'child' ? 3 : 10);
}

function matchPair(report, person) {
  if (person.visibility === 'hidden') return; // hidden people are never matched
  if (!ageOk(report.age, person.age, person.age_group)) return;
  const score = nameScore(report.name, person.name);
  if (score >= THRESHOLD)
    dbRun('INSERT OR IGNORE INTO matches(report_id, person_id, score) VALUES(?,?,?)', [report.id, person.id, score]);
}

const staffOnly = (req, res, next) =>
  req.get('x-staff-pin') === STAFF_PIN ? next() : res.status(401).json({ error: 'Staff PIN required' });
const isStaff = (req) => req.get('x-staff-pin') === STAFF_PIN;

function purge() {
  if (!db) return;
  const cutoff = now() - RETENTION_DAYS * 86400000;
  dbRun('DELETE FROM matches WHERE person_id IN (SELECT id FROM people WHERE updated_at < ?) OR report_id IN (SELECT id FROM reports WHERE created_at < ?)', [cutoff, cutoff]);
  dbRun('DELETE FROM people WHERE updated_at < ?', [cutoff]);
  dbRun('DELETE FROM reports WHERE created_at < ?', [cutoff]);
}

function createPerson(b) {
  const age = toAge(b.age);
  let group = ['child', 'adult', 'senior'].includes(b.ageGroup) ? b.ageGroup : age != null ? (age < 18 ? 'child' : age >= 65 ? 'senior' : 'adult') : 'adult';
  if (age != null && age < 18) group = 'child';
  let vis = ['open', 'ask', 'hidden'].includes(b.visibility) ? b.visibility : 'ask';
  if (group === 'child' && vis === 'open') vis = 'ask'; // children NEVER publicly listed
  const code = newCode();
  dbRun(
    `INSERT INTO people(code,name,age,age_group,description,shelter,visibility,contact_note,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [code, clean(b.name, 100) || 'Name not given', age, group, clean(b.description, 500), clean(b.shelter, 120),
        vis, clean(b.contactNote, 200), now(), now()]
  );
  const person = dbGet('SELECT * FROM people WHERE code=?', [code]);
  for (const r of dbAll('SELECT * FROM reports')) matchPair(r, person);
  return person;
}

// App 
const app = express();
app.set('trust proxy', 1); 
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', rateLimit({ windowMs: 60000, limit: 60, standardHeaders: true, legacyHeaders: false }));
const strict = rateLimit({ windowMs: 60000, limit: 15 }); // Anti-scraping on search 
// Anti-flooding on writes but Staff (PIN) are exempt since a whole shelter may share one IP
const writeLimit = (max) => rateLimit({
  windowMs: 10 * 60 * 1000, limit: max, skip: (req) => isStaff(req),
  message: { error: 'Too many submissions from this device. Please wait a few minutes or ask a staff member for help.' },
});
const RECENT = () => now() - 10 * 60 * 1000;

// Check in ("I'm safe") which usable by the person or a volunteer on a shared device
app.post('/api/people', writeLimit(30), (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ code: 'XXXXXX', name: '', visibility: 'ask', ageGroup: 'adult' }); // honeypot: bots fill hidden field
  // Duplicate guard that see if identical check-in in the last 10 minutes returns the same record (double taps)
  const dup = dbGet('SELECT * FROM people WHERE name=? AND shelter=? AND age IS ? AND description=? AND created_at>?',
    [clean(b.name, 100) || 'Name not given', clean(b.shelter, 120), toAge(b.age), clean(b.description, 500), RECENT()]);
  if (dup) return res.json({ code: dup.code, name: dup.name, visibility: dup.visibility, ageGroup: dup.age_group });
  const p = createPerson(b);
  res.json({ code: p.code, name: p.name, visibility: p.visibility, ageGroup: p.age_group });
});

// Public search ONLY people who chose "open" (not children or 'ask'/'hidden' option)
app.post('/api/search', strict, (req, res) => {
  const { name, age } = req.body || {};
  if (!clean(name)) return res.status(400).json({ error: 'Please enter a name' });
  const a = toAge(age);
  const rows = dbAll("SELECT * FROM people WHERE visibility='open' AND age_group!='child'");
  const out = rows
    .filter((p) => ageOk(a, p.age, p.age_group))
    .map((p) => ({ p, s: nameScore(name, p.name) }))
    .filter((x) => x.s >= THRESHOLD)
    .sort((x, y) => y.s - x.s).slice(0, 10)
    .map(({ p }) => ({ name: p.name, ageGroup: p.age_group, description: p.description, shelter: p.shelter, updated: p.updated_at }));
  res.json({ results: out });
});

// "Leave a note" where seeker registers who they're looking for which matches now and on future check-ins
app.post('/api/reports', strict, writeLimit(10), (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ code: 'XXXXXX' });
  if (!clean(b.name)) return res.status(400).json({ error: 'Who are you looking for?' });
  const dup = dbGet('SELECT code FROM reports WHERE name=? AND seeker_name=? AND seeker_contact=? AND message=? AND created_at>?',
    [clean(b.name, 100), clean(b.seekerName, 100), clean(b.seekerContact, 200), clean(b.message, 500), RECENT()]);
  if (dup) return res.json({ code: dup.code });
  const code = newCode();
  dbRun(
    `INSERT INTO reports(code,name,age,description,seeker_name,seeker_contact,message,created_at) VALUES(?,?,?,?,?,?,?,?)`,
    [code, clean(b.name, 100), toAge(b.age), clean(b.description, 500), clean(b.seekerName, 100),
        clean(b.seekerContact, 200), clean(b.message, 500), now()]
  );
  const report = dbGet('SELECT * FROM reports WHERE code=?', [code]);
  for (const p of dbAll("SELECT * FROM people WHERE visibility!='hidden'")) matchPair(report, p);
  res.json({ code }); // Same response whether or not a match exists
});

// Seeker status
app.get('/api/reports/:code', strict, (req, res) => {
  const r = dbGet('SELECT * FROM reports WHERE code=?', [clean(req.params.code).toUpperCase()]);
  if (!r) return res.status(404).json({ error: 'Code not found' });
  const found = dbAll(
    `SELECT p.shelter, p.contact_note FROM matches m JOIN people p ON p.id=m.person_id WHERE m.report_id=? AND m.status='accepted'`,
    [r.id]
  );
  res.json({ kind: 'report', lookingFor: r.name, status: found.length ? 'found' : 'waiting', connections: found });
});

// Person view where person can see pending requests from people looking for them
app.get('/api/people/:code', strict, (req, res) => {
  const p = dbGet('SELECT * FROM people WHERE code=?', [clean(req.params.code).toUpperCase()]);
  if (!p) return res.status(404).json({ error: 'Code not found' });
  const requests = dbAll(
    `SELECT m.id, r.seeker_name, r.seeker_contact, r.message FROM matches m JOIN reports r ON r.id=m.report_id
     WHERE m.person_id=? AND m.status='pending'`,
    [p.id]
  );
  res.json({ kind: 'person', name: p.name, shelter: p.shelter, visibility: p.visibility, ageGroup: p.age_group, contactNote: p.contact_note, requests });
});

// Accept / decline. Children's requests need staff (PIN) so no one hands a child to a stranger.
app.post('/api/people/:code/respond', (req, res) => {
  const p = dbGet('SELECT * FROM people WHERE code=?', [clean(req.params.code).toUpperCase()]);
  if (!p) return res.status(404).json({ error: 'Code not found' });
  if (p.age_group === 'child' && !isStaff(req)) return res.status(403).json({ error: 'A staff member must approve contact for children.' });
  const status = req.body.accept ? 'accepted' : 'declined';
  dbRun('UPDATE matches SET status=? WHERE id=? AND person_id=? AND status=\'pending\'', [status, req.body.matchId, p.id]);
  res.json({ ok: true });
});

app.post('/api/people/:code/update', (req, res) => {
  const p = dbGet('SELECT * FROM people WHERE code=?', [clean(req.params.code).toUpperCase()]);
  if (!p) return res.status(404).json({ error: 'Code not found' });
  const b = req.body || {};
  const vis = ['open', 'ask', 'hidden'].includes(b.visibility) ? b.visibility : p.visibility;
  dbRun('UPDATE people SET shelter=?, contact_note=?, visibility=?, updated_at=? WHERE id=?',
    [b.shelter != null ? clean(b.shelter, 120) : p.shelter, b.contactNote != null ? clean(b.contactNote, 200) : p.contact_note,
         p.age_group === 'child' && vis === 'open' ? 'ask' : vis, now(), p.id]);
  res.json({ ok: true });
});

// Right to disappear: delete everything about me
app.delete('/api/people/:code', (req, res) => {
  const p = dbGet('SELECT id FROM people WHERE code=?', [clean(req.params.code).toUpperCase()]);
  if (p) { dbRun('DELETE FROM matches WHERE person_id=?', [p.id]); dbRun('DELETE FROM people WHERE id=?', [p.id]); }
  res.json({ ok: true });
});

// Staff
app.get('/api/staff/overview', staffOnly, (req, res) => {
  const q = clean(req.query.q).toLowerCase();
  let people = dbAll('SELECT * FROM people ORDER BY updated_at DESC LIMIT 500');
  if (q) people = people.filter((p) => (p.name + ' ' + p.shelter + ' ' + p.code).toLowerCase().includes(q));
  const pending = dbAll(
    `SELECT m.id, m.score, p.code, p.name AS person_name, p.age AS person_age, p.description AS person_desc, p.shelter, p.age_group, r.name AS looking_for, r.age AS looking_age, r.description AS looking_desc, r.seeker_name, r.seeker_contact, r.message
     FROM matches m JOIN people p ON p.id=m.person_id JOIN reports r ON r.id=m.report_id WHERE m.status='pending' ORDER BY m.score DESC, m.id DESC`);
  const pc = dbGet('SELECT COUNT(*) as c FROM people');
  const rc = dbGet('SELECT COUNT(*) as c FROM reports');
  res.json({ people, pending, counts: { people: pc?.c || 0, reports: rc?.c || 0 } });
});

// A bulk import for paper records
app.post('/api/staff/import', staffOnly, (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 2000) : [];
  const codes = rows.map((r) => createPerson(r).code);
  res.json({ imported: codes.length });
});

function seedDemo() {
  if (process.env.SEED_DEMO !== '1' || dbGet('SELECT COUNT(*) AS c FROM people').c > 0) return;
  createPerson({ code: 'JAMES2', name: 'James Carter', age: 71, ageGroup: 'senior', shelter: 'Riverside Community Center', visibility: 'open', description: 'Grey beard, walks with a cane, from Harbor St.' });
  createPerson({ code: 'MARIA2', name: 'Maria Gonzalez', age: 34, shelter: 'Lincoln High School', visibility: 'ask', description: 'Two kids, red jacket' });
  createPerson({ code: 'DANI22', name: 'Dani', age: 16, ageGroup: 'child', shelter: 'Eastside Shelter', visibility: 'ask', description: 'Came on the school bus' });
  createPerson({ name: '', shelter: 'Lincoln High School', visibility: 'hidden' });
  const code = 'ANA222';
  dbRun('INSERT INTO reports(code,name,age,description,seeker_name,seeker_contact,message,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [code, 'Maria Gonzales', 35, '', 'Ana (sister)', 'Staying at Hampton Inn, ask front desk', 'I am safe. Where are you?', now()]);
  matchPair(dbGet('SELECT * FROM reports WHERE code=?', [code]), dbGet("SELECT * FROM people WHERE name='Maria Gonzalez'"));
  console.log('Demo data loaded');
}
initDb().then(() => {
  seedDemo();
  purge();
  setInterval(purge, 6 * 3600 * 1000);
  app.listen(PORT, () => console.log('Reunite running on port ' + PORT));
}).catch((err) => { console.error('Failed to init database:', err); process.exit(1); });