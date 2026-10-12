const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const JSZip = require('jszip');
const { db, hashPassword, verifyPassword } = require('./db');
const os = require('os');
const { defaultTemplateConfig, extractFields, normKey, fill, fixedSignatories, buildPdf } = require('./pdf');
const { CATEGORIES, presetList } = require('./presets');
const ai = require('./ai');
const { buildReport } = require('./report');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build')));

// ---------- helpers ----------
const sessions = new Map(); // token -> { userId, expires }
const SESSION_MS = 1000 * 60 * 60 * 12;

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
}

function publicUser(u) {
  return u && { id: u.id, username: u.username, name: u.name, title: u.title, role: u.role, signature: u.signature, created_at: u.created_at };
}

const can = {
  create: (u) => u.role === 'admin' || u.role === 'creator',
  approve: (u) => u.role === 'admin' || u.role === 'approver',
  admin: (u) => u.role === 'admin',
};

function auth(req, res, next) {
  const s = sessions.get(cookies(req).sid);
  if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'Please sign in' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.userId);
  if (!user) return res.status(401).json({ error: 'Please sign in' });
  s.expires = Date.now() + SESSION_MS;
  req.user = user;
  next();
}

const need = (perm) => (req, res, next) =>
  can[perm](req.user) ? next() : res.status(403).json({ error: 'You do not have permission to do that' });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function log(batchId, userId, action, comment = null) {
  db.prepare('INSERT INTO activity (batch_id, user_id, action, comment) VALUES (?,?,?,?)').run(batchId, userId, action, comment);
}

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCertId() {
  const bytes = crypto.randomBytes(8);
  const code = [...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
  return `CRT-${String(new Date().getFullYear()).slice(2)}-${code}`;
}

function formatDate(d) {
  const date = d ? new Date(d.replace(' ', 'T') + (d.includes('Z') ? '' : 'Z')) : new Date();
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// The date of issue chosen when the certificate was created (issued_on, yyyy-mm-dd),
// falling back to the approval date, or today for an unapproved preview.
function issueDateOf(batch, data) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(data?.issued_on || '')) {
    return new Date(data.issued_on + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  return formatDate(batch.status === 'approved' ? batch.reviewed_at : null);
}

// The machine's address on the local network, so a QR code scanned by a phone on the same Wi-Fi still opens.
function lanAddress() {
  const all = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal);
  const isPrivate = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return (all.find((a) => isPrivate(a.address)) || all[0])?.address;
}

// The address of the published verification site (e.g. https://ars-027.github.io/certify-verify), set on the Records page.
const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
const siteUrl = () => PUBLIC_URL || getSetting('site_url');

function baseUrl(req) {
  if (siteUrl()) return siteUrl();
  const host = req.get('host');
  const local = host.match(/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/);
  const lan = local && lanAddress();
  return `${req.protocol}://${lan ? lan + (local[2] || '') : host}`;
}

function getBatch(id) {
  return db.prepare(`
    SELECT b.*, t.name AS template_name, cu.name AS creator_name, au.name AS approver_name,
      (SELECT COUNT(*) FROM certificates c WHERE c.batch_id = b.id) AS count
    FROM batches b
    JOIN templates t ON t.id = b.template_id
    LEFT JOIN users cu ON cu.id = b.created_by
    LEFT JOIN users au ON au.id = b.approver_id
    WHERE b.id = ?`).get(id);
}

// Builds the render job for a certificate. Approved batches use the frozen template/approver
// captured at approval time, so later template edits never alter issued certificates.
function renderJob(req, batch, cert) {
  const approved = batch.status === 'approved';
  const config = approved && batch.template_snapshot
    ? JSON.parse(batch.template_snapshot)
    : JSON.parse(db.prepare('SELECT config FROM templates WHERE id = ?').get(batch.template_id).config);
  const data = JSON.parse(cert.data);
  return {
    config,
    data,
    ctx: {
      certId: cert.id,
      issueDate: issueDateOf(batch, data),
      // The QR code opens the intern's work report, the detailed document behind the certificate.
      verifyUrl: `${baseUrl(req)}/verify/${cert.id}.pdf`,
      approver: approved && batch.approver_snapshot ? JSON.parse(batch.approver_snapshot) : null,
      watermark: !approved ? 'PREVIEW' : cert.revoked ? 'REVOKED' : null,
    },
  };
}

function safeFileName(s) {
  return String(s || 'certificate').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'certificate';
}

function sendPdf(res, bytes, filename, inline) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`);
  res.end(Buffer.from(bytes));
}

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, expires: Date.now() + SESSION_MS });
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`);
  res.json(publicUser(user));
});

app.post('/api/logout', (req, res) => {
  sessions.delete(cookies(req).sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));

app.put('/api/me', auth, (req, res) => {
  const { name, title, signature, currentPassword, newPassword } = req.body || {};
  if (newPassword) {
    if (!verifyPassword(String(currentPassword || ''), req.user.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    if (String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
  }
  db.prepare('UPDATE users SET name = ?, title = ?, signature = ? WHERE id = ?').run(
    String(name ?? req.user.name).trim() || req.user.name,
    String(title ?? req.user.title).trim(),
    signature === undefined ? req.user.signature : signature,
    req.user.id,
  );
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
});

// ---------- users ----------
app.get('/api/users', auth, need('admin'), (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY name').all().map(publicUser));
});

app.post('/api/users', auth, need('admin'), (req, res) => {
  const { username, name, title, role, password } = req.body || {};
  const uname = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,}$/.test(uname)) return res.status(400).json({ error: 'Username must be 3+ letters, numbers, dots or dashes' });
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!['admin', 'creator', 'approver'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname)) return res.status(400).json({ error: 'That username is taken' });
  const r = db.prepare('INSERT INTO users (username, name, title, role, password_hash) VALUES (?,?,?,?,?)')
    .run(uname, name.trim(), String(title || '').trim(), role, hashPassword(password));
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)));
});

app.put('/api/users/:id', auth, need('admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { name, title, role, password } = req.body || {};
  if (role && !['admin', 'creator', 'approver'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (user.id === req.user.id && role && role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin role' });
  db.prepare('UPDATE users SET name = ?, title = ?, role = ? WHERE id = ?')
    .run(name || user.name, title ?? user.title, role || user.role, user.id);
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
  }
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)));
});

app.delete('/api/users/:id', auth, need('admin'), (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  const used = db.prepare('SELECT 1 FROM batches WHERE created_by = ? OR approver_id = ? LIMIT 1').get(req.params.id, req.params.id);
  if (used) return res.status(400).json({ error: 'This user has batch history and cannot be deleted. Change their password instead.' });
  db.prepare('DELETE FROM activity WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- templates ----------
app.get('/api/templates', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM batches b WHERE b.template_id = t.id) AS batch_count
    FROM templates t ORDER BY t.updated_at DESC`).all();
  res.json(rows.map((t) => {
    const config = JSON.parse(t.config);
    return { ...t, config, fields: extractFields(config) };
  }));
});

app.get('/api/templates/default', auth, (req, res) => res.json(defaultTemplateConfig()));

// ---------- saved images (stamps, signatures, logos uploaded from a device) ----------
const ASSET_KINDS = ['stamp', 'signature', 'logo'];
const MAX_ASSET_BYTES = 3 * 1024 * 1024;

app.get('/api/assets', auth, (req, res) => {
  const kind = ASSET_KINDS.includes(req.query.kind) ? req.query.kind : null;
  const rows = kind
    ? db.prepare('SELECT a.*, u.name AS owner FROM assets a LEFT JOIN users u ON u.id = a.created_by WHERE kind = ? ORDER BY a.id DESC').all(kind)
    : db.prepare('SELECT a.*, u.name AS owner FROM assets a LEFT JOIN users u ON u.id = a.created_by ORDER BY a.id DESC').all();
  res.json(rows);
});

app.post('/api/assets', auth, need('create'), (req, res) => {
  const { kind, name, image } = req.body || {};
  if (!ASSET_KINDS.includes(kind)) return res.status(400).json({ error: 'Unknown image type' });
  if (!/^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/.test(String(image || ''))) return res.status(400).json({ error: 'Please upload a PNG or JPG image' });
  if (image.length > MAX_ASSET_BYTES * 1.37) return res.status(400).json({ error: 'That image is too large (max 3 MB)' });
  const label = String(name || '').trim().slice(0, 80) || `${kind[0].toUpperCase()}${kind.slice(1)} ${new Date().toLocaleDateString('en-GB')}`;
  const r = db.prepare('INSERT INTO assets (kind, name, image, created_by) VALUES (?,?,?,?)').run(kind, label, image, req.user.id);
  res.json({ id: Number(r.lastInsertRowid), kind, name: label, image });
});

app.delete('/api/assets/:id', auth, need('create'), (req, res) => {
  const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.created_by !== req.user.id && !can.admin(req.user)) return res.status(403).json({ error: 'Only the person who uploaded it (or an admin) can delete it' });
  db.prepare('DELETE FROM assets WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

app.get('/api/presets', auth, (req, res) => res.json({ categories: CATEGORIES, presets: presetList() }));

// ---------- AI writing assistant ----------
app.get('/api/ai/status', auth, (req, res) => res.json({ enabled: ai.enabled(), model: ai.MODEL }));

const aiRoute = (fn) => [auth, need('create'), wrap(async (req, res) => {
  try {
    res.json(await fn(req.body || {}));
  } catch (e) {
    if (e instanceof ai.AiError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
})];
const wordingOf = (w = {}) => ({ title: String(w.title || ''), subtitle: String(w.subtitle || ''), body: String(w.body || '') });

app.post('/api/ai/suggest', ...aiRoute((b) => ai.suggest({ ...b, wording: b.wording ? wordingOf(b.wording) : null })));
app.post('/api/ai/check', ...aiRoute((b) => ai.check(wordingOf(b.wording))));
app.post('/api/ai/rewrite', ...aiRoute((b) => {
  if (!b.instruction) throw new ai.AiError('Say how the wording should change', 400);
  return ai.rewrite(wordingOf(b.wording), b.instruction);
}));

app.post('/api/templates', auth, need('create'), (req, res) => {
  const { name, config } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Template name is required' });
  const r = db.prepare('INSERT INTO templates (name, config, created_by) VALUES (?,?,?)')
    .run(String(name).trim(), JSON.stringify({ ...defaultTemplateConfig(), ...config }), req.user.id);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.put('/api/templates/:id', auth, need('create'), (req, res) => {
  const { name, config } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Template name is required' });
  const r = db.prepare("UPDATE templates SET name = ?, config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(String(name).trim(), JSON.stringify(config), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Template not found' });
  res.json({ ok: true });
});

app.post('/api/templates/:id/duplicate', auth, need('create'), (req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  const r = db.prepare('INSERT INTO templates (name, config, created_by) VALUES (?,?,?)').run(`${t.name} (copy)`, t.config, req.user.id);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.delete('/api/templates/:id', auth, need('create'), (req, res) => {
  if (db.prepare('SELECT 1 FROM batches WHERE template_id = ? LIMIT 1').get(req.params.id)) {
    return res.status(400).json({ error: 'This template is used by a batch and cannot be deleted' });
  }
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

const thisYear = String(new Date().getFullYear());
const SAMPLE_VALUES = {
  name: 'Jane Doe', course: 'Advanced Leadership', year: thisYear, position: 'First', event: 'Annual Innovation Summit',
  sport: '100m Sprint', month: new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), subject: 'Mathematics',
  role: 'Software Development Intern', start_date: '1 June ' + thisYear, end_date: '31 August ' + thisYear,
  training: 'Workplace Safety', score: '92%', contribution: 'the Annual Tech Fest', hours: '120', cause: 'the Clean City Drive',
  reason: 'in recognition of an outstanding contribution.', grade: 'A+', pronoun: 'their',
};

app.post('/api/preview', auth, wrap(async (req, res) => {
  const { config, data } = req.body || {};
  const sample = {};
  for (const f of extractFields(config)) sample[f] = SAMPLE_VALUES[f] || (/date/.test(f) ? formatDate(null) : `[${f}]`);
  const showApprover = req.user.signature ? { name: req.user.name, title: req.user.title, signature: req.user.signature } : null;
  const bytes = await buildPdf([{
    config,
    data: { ...sample, ...(data || {}) },
    ctx: { certId: 'CRT-00-SAMPLE00', issueDate: formatDate(null), verifyUrl: `${baseUrl(req)}/verify/sample.pdf`, approver: showApprover },
  }]);
  sendPdf(res, bytes, 'preview.pdf', true);
}));

app.post('/api/report-preview', auth, wrap(async (req, res) => {
  const { config, data } = req.body || {};
  const bytes = await buildReport({
    config,
    data: data || {},
    ctx: { certId: 'CRT-00-SAMPLE00', issueDate: issueDateOf({ status: 'draft' }, data), pageUrl: `${baseUrl(req)}/verify/sample`, watermark: 'INTERN VERIFICATION' },
  });
  sendPdf(res, bytes, 'work-report-preview.pdf', true);
}));

// ---------- batches ----------
app.get('/api/batches', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT b.id, b.name, b.status, b.created_at, b.submitted_at, b.reviewed_at, b.review_comment, b.created_by,
      t.name AS template_name, cu.name AS creator_name, au.name AS approver_name,
      (SELECT COUNT(*) FROM certificates c WHERE c.batch_id = b.id) AS count
    FROM batches b
    JOIN templates t ON t.id = b.template_id
    LEFT JOIN users cu ON cu.id = b.created_by
    LEFT JOIN users au ON au.id = b.approver_id
    ORDER BY COALESCE(b.reviewed_at, b.submitted_at, b.created_at) DESC`).all());
});

app.get('/api/batches/:id', auth, (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  const config = batch.status === 'approved' && batch.template_snapshot
    ? JSON.parse(batch.template_snapshot)
    : JSON.parse(db.prepare('SELECT config FROM templates WHERE id = ?').get(batch.template_id).config);
  const certificates = db.prepare('SELECT id, data, revoked FROM certificates WHERE batch_id = ? ORDER BY rowid').all(batch.id)
    .map((c) => ({ id: c.id, revoked: !!c.revoked, data: JSON.parse(c.data) }));
  const activity = db.prepare(`
    SELECT a.action, a.comment, a.at, u.name AS user_name FROM activity a
    LEFT JOIN users u ON u.id = a.user_id WHERE a.batch_id = ? ORDER BY a.id DESC`).all(batch.id);
  const { template_snapshot, approver_snapshot, ...rest } = batch;
  res.json({ ...rest, fields: extractFields(config), certificates, activity });
});

app.post('/api/batches', auth, need('create'), (req, res) => {
  const { name, template_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Batch name is required' });
  if (!db.prepare('SELECT 1 FROM templates WHERE id = ?').get(template_id)) return res.status(400).json({ error: 'Choose a template' });
  const r = db.prepare('INSERT INTO batches (name, template_id, created_by) VALUES (?,?,?)').run(String(name).trim(), template_id, req.user.id);
  log(r.lastInsertRowid, req.user.id, 'created');
  res.json({ id: Number(r.lastInsertRowid) });
});

function editableBatch(req, res) {
  const batch = getBatch(req.params.id);
  if (!batch) { res.status(404).json({ error: 'Batch not found' }); return null; }
  if (!['draft', 'rejected'].includes(batch.status)) { res.status(400).json({ error: 'Only draft or rejected batches can be changed' }); return null; }
  if (batch.created_by !== req.user.id && !can.admin(req.user)) { res.status(403).json({ error: 'Only the batch creator can change it' }); return null; }
  return batch;
}

app.put('/api/batches/:id', auth, need('create'), (req, res) => {
  const batch = editableBatch(req, res);
  if (!batch) return;
  const { name, template_id, recipients } = req.body || {};
  if (template_id && !db.prepare('SELECT 1 FROM templates WHERE id = ?').get(template_id)) return res.status(400).json({ error: 'Template not found' });
  if (Array.isArray(recipients) && recipients.length > 5000) return res.status(400).json({ error: 'A batch can hold up to 5000 certificates' });

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE batches SET name = ?, template_id = ? WHERE id = ?')
      .run(String(name || batch.name).trim(), template_id || batch.template_id, batch.id);
    if (Array.isArray(recipients)) {
      const keep = new Set();
      const upsert = db.prepare('INSERT INTO certificates (id, batch_id, data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE batch_id = excluded.batch_id');
      for (const r of recipients) {
        const data = {};
        for (const [k, v] of Object.entries(r.data || {})) {
          const key = normKey(k);
          if (key) data[key] = String(v ?? '').trim();
        }
        if (!data.name) continue;
        const existing = r.id && db.prepare('SELECT 1 FROM certificates WHERE id = ? AND batch_id = ?').get(r.id, batch.id);
        const id = existing ? r.id : newCertId();
        upsert.run(id, batch.id, JSON.stringify(data));
        keep.add(id);
      }
      for (const c of db.prepare('SELECT id FROM certificates WHERE batch_id = ?').all(batch.id)) {
        if (!keep.has(c.id)) db.prepare('DELETE FROM certificates WHERE id = ?').run(c.id);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

app.delete('/api/batches/:id', auth, need('create'), (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.status === 'approved' && !can.admin(req.user)) return res.status(400).json({ error: 'Approved batches can only be deleted by an admin' });
  if (batch.created_by !== req.user.id && !can.admin(req.user)) return res.status(403).json({ error: 'Only the batch creator can delete it' });
  db.prepare('DELETE FROM batches WHERE id = ?').run(batch.id);
  res.json({ ok: true });
});

app.post('/api/batches/:id/submit', auth, need('create'), (req, res) => {
  const batch = editableBatch(req, res);
  if (!batch) return;
  if (!batch.count) return res.status(400).json({ error: 'Add at least one recipient before submitting' });
  db.prepare("UPDATE batches SET status = 'pending', submitted_at = CURRENT_TIMESTAMP, review_comment = NULL WHERE id = ?").run(batch.id);
  log(batch.id, req.user.id, 'submitted', req.body?.comment || null);
  res.json({ ok: true });
});

app.post('/api/batches/:id/withdraw', auth, need('create'), (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch || batch.status !== 'pending') return res.status(400).json({ error: 'Only pending batches can be withdrawn' });
  if (batch.created_by !== req.user.id && !can.admin(req.user)) return res.status(403).json({ error: 'Only the batch creator can withdraw it' });
  db.prepare("UPDATE batches SET status = 'draft' WHERE id = ?").run(batch.id);
  log(batch.id, req.user.id, 'withdrawn');
  res.json({ ok: true });
});

app.post('/api/batches/:id/approve', auth, need('approve'), (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch || batch.status !== 'pending') return res.status(400).json({ error: 'Only pending batches can be approved' });
  const t = db.prepare('SELECT config FROM templates WHERE id = ?').get(batch.template_id);
  const config = JSON.parse(t.config);
  if (config.approverSignature && !req.user.signature) {
    return res.status(400).json({ error: 'Add your signature in "My Profile" first — it is stamped on every certificate you approve.' });
  }
  const approver = JSON.stringify({ name: req.user.name, title: req.user.title, signature: req.user.signature });
  db.prepare(`UPDATE batches SET status = 'approved', approver_id = ?, reviewed_at = CURRENT_TIMESTAMP,
    review_comment = ?, template_snapshot = ?, approver_snapshot = ? WHERE id = ?`)
    .run(req.user.id, req.body?.comment || null, t.config, approver, batch.id);
  log(batch.id, req.user.id, 'approved', req.body?.comment || null);
  res.json({ ok: true });
});

app.post('/api/batches/:id/reject', auth, need('approve'), (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch || batch.status !== 'pending') return res.status(400).json({ error: 'Only pending batches can be sent back' });
  const comment = String(req.body?.comment || '').trim();
  if (!comment) return res.status(400).json({ error: 'Please say what needs to change' });
  db.prepare("UPDATE batches SET status = 'rejected', approver_id = ?, reviewed_at = CURRENT_TIMESTAMP, review_comment = ? WHERE id = ?")
    .run(req.user.id, comment, batch.id);
  log(batch.id, req.user.id, 'sent back', comment);
  res.json({ ok: true });
});

app.get('/api/batches/:id/download', auth, wrap(async (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  const certs = db.prepare('SELECT * FROM certificates WHERE batch_id = ? ORDER BY rowid').all(batch.id);
  if (!certs.length) return res.status(400).json({ error: 'This batch has no certificates' });
  const suffix = batch.status === 'approved' ? '' : '_PREVIEW';

  if (req.query.format === 'zip') {
    const zip = new JSZip();
    for (const c of certs) {
      const job = renderJob(req, batch, c);
      zip.file(`${safeFileName(job.data.name)}_${c.id}${suffix}.pdf`, await buildPdf([job]));
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName(batch.name)}${suffix}.zip"`);
    return res.end(buf);
  }
  const bytes = await buildPdf(certs.map((c) => renderJob(req, batch, c)));
  sendPdf(res, bytes, `${safeFileName(batch.name)}${suffix}.pdf`, req.query.inline === '1');
}));

app.get('/api/certificates/:id/pdf', auth, wrap(async (req, res) => {
  const cert = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id);
  if (!cert) return res.status(404).json({ error: 'Certificate not found' });
  const batch = getBatch(cert.batch_id);
  const job = renderJob(req, batch, cert);
  const bytes = await buildPdf([job]);
  sendPdf(res, bytes, `${safeFileName(job.data.name)}_${cert.id}.pdf`, req.query.inline === '1');
}));

app.post('/api/certificates/:id/revoke', auth, need('approve'), (req, res) => {
  const cert = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id);
  if (!cert) return res.status(404).json({ error: 'Certificate not found' });
  const revoked = req.body?.revoked ? 1 : 0;
  db.prepare('UPDATE certificates SET revoked = ? WHERE id = ?').run(revoked, cert.id);
  log(cert.batch_id, req.user.id, revoked ? 'revoked' : 'restored', `${JSON.parse(cert.data).name} (${cert.id})`);
  res.json({ ok: true });
});

app.get('/api/stats', auth, (req, res) => {
  const q = (sql, ...a) => db.prepare(sql).get(...a).n;
  res.json({
    issued: q("SELECT COUNT(*) AS n FROM certificates c JOIN batches b ON b.id = c.batch_id WHERE b.status = 'approved' AND c.revoked = 0"),
    pending: q("SELECT COUNT(*) AS n FROM batches WHERE status = 'pending'"),
    drafts: q("SELECT COUNT(*) AS n FROM batches WHERE status IN ('draft','rejected') AND created_by = ?", req.user.id),
    templates: q('SELECT COUNT(*) AS n FROM templates'),
  });
});

// ---------- public verification ----------
// Everything shown on the verification page comes from the design frozen at approval,
// so the confirmation always matches the certificate that was printed.
function certDetails(cert, batch, config) {
  const data = JSON.parse(cert.data);
  const issued = issueDateOf(batch, data);
  const full = { ...data, id: cert.id, issue_date: issued };
  const approver = JSON.parse(batch.approver_snapshot || 'null');
  const signer = fixedSignatories(config)[0];
  const sign = signer
    ? { image: signer.image, name: fill(signer.name, full), title: fill(signer.title, full) }
    : approver && config.approverSignature ? { image: approver.signature, name: approver.name, title: approver.title } : null;
  return {
    id: cert.id,
    valid: !cert.revoked,
    revoked: !!cert.revoked,
    name: data.name,
    title: fill(config.displayTitle || config.title, full),
    organization: fill(config.orgName, full),
    reason: fill(config.reason ?? config.body, full),
    work: String(data.work || '').split(/\n/).map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean),
    issued,
    approvedBy: approver ? `${approver.name}${approver.title ? ', ' + approver.title : ''}` : null,
    logo: config.logo || null,
    stamp: (config.stamps || []).find((st) => st.type === 'image' && st.image)?.image || null,
    sign,
  };
}

function lookup(id) {
  const cert = db.prepare('SELECT * FROM certificates WHERE id = ?').get(String(id).toUpperCase());
  if (!cert) return null;
  const batch = getBatch(cert.batch_id);
  if (batch.status !== 'approved') return null;
  return certDetails(cert, batch, JSON.parse(batch.template_snapshot));
}

app.get('/api/verify/:id', (req, res) => {
  const r = lookup(req.params.id);
  if (!r) return res.status(404).json({ valid: false, error: 'No issued certificate has this ID' });
  const { logo, stamp, sign, ...rest } = r;
  res.json({ ...rest, signedBy: sign ? [sign.name, sign.title].filter(Boolean).join(', ') : null });
});

// Every certificate, for the in-app records page (the company's own register of what was issued).
app.get('/api/certificates', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, b.status, b.name AS batch_name, b.reviewed_at, b.approver_snapshot, b.template_snapshot, t.config AS template_config
    FROM certificates c JOIN batches b ON b.id = c.batch_id JOIN templates t ON t.id = b.template_id
    ORDER BY c.created_at DESC, c.rowid DESC`).all();
  res.json(rows.map((row) => {
    const config = JSON.parse(row.status === 'approved' && row.template_snapshot ? row.template_snapshot : row.template_config);
    const { logo, stamp, sign, issued, ...d } = certDetails(row, row, config);
    return { ...d, issued: row.status === 'approved' ? issued : null, status: row.status, batch_id: row.batch_id, batch_name: row.batch_name };
  }));
});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Only embed images we stored ourselves (data: URLs), never arbitrary markup.
const imgSrc = (s) => /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(s || '') ? s : null;

function confirmationCard(r) {
  const logo = imgSrc(r.logo), stamp = imgSrc(r.stamp), sig = imgSrc(r.sign?.image);
  return `<article class="letter ${r.revoked ? 'revoked' : ''}">
    <header>${logo ? `<img class="logo" src="${logo}" alt="${esc(r.organization)} logo">` : ''}
      ${r.organization ? `<div class="org">${esc(r.organization)}</div>` : ''}</header>
    <div class="status ${r.revoked ? 'bad' : 'good'}">${r.revoked
      ? '✕ This certificate has been revoked and is no longer valid'
      : '✓ Genuine certificate, confirmed by the issuing organisation'}</div>
    <p class="lead">This is to confirm that <b>${esc(r.name)}</b> was awarded the <b>${esc(r.title)}</b>${r.organization ? ` by ${esc(r.organization)}` : ''}${r.reason ? ` ${esc(r.reason.replace(/\.$/, ''))}` : ''}.</p>
    <a class="report-btn" href="${encodeURIComponent(r.id)}.pdf">Open the full work report (PDF)</a>
    ${r.work.length ? `<h2>Work and performance record</h2><ul class="work">${r.work.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <dl>
      <dt>Recipient</dt><dd>${esc(r.name)}</dd>
      <dt>Date of issue</dt><dd>${esc(r.issued)}</dd>
      <dt>Certificate ID</dt><dd><code>${esc(r.id)}</code></dd>
    </dl>
    ${r.sign || stamp ? `<footer>
      <div class="signoff">
        <div class="marks">${sig ? `<img class="sig" src="${sig}" alt="Signature">` : ''}${stamp ? `<img class="stamp" src="${stamp}" alt="Company stamp">` : ''}</div>
        ${r.sign ? `<div class="line"></div><b>${esc(r.sign.name)}</b>${r.sign.title ? `<span>${esc(r.sign.title)}</span>` : ''}` : ''}
      </div></footer>` : ''}
  </article>`;
}

// Why a scanned code has no confirmation page yet, so a preview or unapproved certificate isn't mistaken for a fake.
function notIssuedMessage(id) {
  if (String(id).toLowerCase() === 'sample') {
    return ['This is a preview', 'This QR code is from a certificate preview. Save the certificate and get it approved; the QR code on the approved certificate opens its confirmation page.'];
  }
  const cert = db.prepare('SELECT batch_id FROM certificates WHERE id = ?').get(String(id).toUpperCase());
  const batch = cert && getBatch(cert.batch_id);
  if (batch) {
    return ['Not approved yet', `Certificate <b>${esc(String(id).toUpperCase())}</b> exists but has not been approved, so it cannot be confirmed yet. Once it is approved, this page will show its details.`];
  }
  return ['Not found', `No issued certificate matches <b>${esc(id)}</b>. Check the ID and try again.`];
}

// The work report PDF for an issued certificate. This is what the certificate's QR code opens.
// base is the address the report's footer links back to (empty leaves the link off).
function reportPdf(cert, batch, base) {
  const data = JSON.parse(cert.data);
  return buildReport({
    config: JSON.parse(batch.template_snapshot),
    data,
    ctx: {
      certId: cert.id,
      issueDate: issueDateOf(batch, data),
      pageUrl: base ? `${base}/verify/${cert.id}` : null,
      watermark: cert.revoked ? 'REVOKED' : 'INTERN VERIFICATION',
    },
  });
}

async function sendReport(req, res, id) {
  const cert = db.prepare('SELECT * FROM certificates WHERE id = ?').get(String(id).toUpperCase());
  const batch = cert && getBatch(cert.batch_id);
  console.log(`Work report opened for ${id} from ${req.ip}${batch?.status === 'approved' ? '' : ' (not issued)'}`);
  if (batch?.status !== 'approved') return sendVerifyPage(res, id, null);
  const bytes = await reportPdf(cert, batch, baseUrl(req));
  sendPdf(res, bytes, `${safeFileName(JSON.parse(cert.data).name)}_Work_Report_${cert.id}.pdf`, true);
}

// /verify/<id>.pdf is the report (the same address as on the exported site); /verify/<id>/report is kept for older QR codes.
app.get('/verify/:id/report', wrap((req, res) => sendReport(req, res, req.params.id)));

app.get(['/verify', '/verify/:id'], wrap(async (req, res) => {
  // The search box submits ?id=; redirect so the page's relative report link resolves.
  if (!req.params.id && req.query.id) return res.redirect(`/verify/${encodeURIComponent(String(req.query.id).trim())}`);
  const id = req.params.id;
  if (/\.pdf$/i.test(id || '')) return sendReport(req, res, id.slice(0, -4));
  if (id) console.log(`Verification page opened for ${id} from ${req.ip}`);
  sendVerifyPage(res, id, id ? lookup(id) : null);
}));

const VERIFY_CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'verify.css'), 'utf8');

// One verification page. The exported site has no server, so it inlines the styles and
// its search box jumps straight to the certificate's page (root is the path back to the site root).
function verifyPageHtml({ title, body, value = '', root = null }) {
  const form = root === null
    ? `<form action="/verify" method="get"><input name="id" placeholder="Check another certificate ID, e.g. CRT-26-ABCD2345" value="${esc(value)}" required><button>Verify</button></form>`
    : `<form onsubmit="event.preventDefault();location.href='${root}verify/'+encodeURIComponent(this.cert.value.trim().toUpperCase())"><input name="cert" placeholder="Check another certificate ID, e.g. CRT-26-ABCD2345" value="${esc(value)}" required><button>Verify</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${root === null ? '<link rel="stylesheet" href="/verify.css">' : `<style>${VERIFY_CSS}</style>`}</head><body>
<main>${body}
${form}
</main></body></html>`;
}

const pageTitle = (r) => r ? `${r.name} – Certificate confirmation` : 'Verify certificate';
const messageCard = (heading, message, kind = 'bad') => `<div class="letter"><div class="status ${kind}">${heading}</div><p>${message}</p></div>`;

function sendVerifyPage(res, id, r) {
  const body = !id ? '' : r ? confirmationCard(r) : messageCard(...notIssuedMessage(id));
  res.send(verifyPageHtml({ title: pageTitle(r), body, value: r ? '' : id || '' }));
}

// ---------- verification site (static export for Netlify Drop / GitHub Pages) ----------
app.get('/api/settings', auth, (req, res) => res.json({ site_url: getSetting('site_url'), fixed: !!PUBLIC_URL }));

app.put('/api/settings', auth, need('approve'), (req, res) => {
  let url = String(req.body?.site_url || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (url && !/^https?:\/\/[^\s/?#]+\.[^\s/?#]+(\/[^\s?#]*)?$/i.test(url)) return res.status(400).json({ error: 'That does not look like a web address, e.g. https://your-username.github.io/certify-verify' });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('site_url', url);
  res.json({ site_url: url });
});

// A folder with a page and a work report for every issued certificate, ready to drag onto Netlify Drop.
// Layout: verify/<ID> (the page, as <ID>.html) and verify/<ID>.pdf (the report the QR code opens).
// Revoked certificates stay on the site, marked as revoked, so a scan never looks like a missing record.
app.get('/api/site-export', auth, need('approve'), wrap(async (req, res) => {
  const base = siteUrl();
  const rows = db.prepare(`SELECT c.* FROM certificates c JOIN batches b ON b.id = c.batch_id
    WHERE b.status = 'approved' ORDER BY c.rowid`).all();
  const zip = new JSZip();
  const site = zip.folder('verification-site');
  for (const cert of rows) {
    const batch = getBatch(cert.batch_id);
    const r = certDetails(cert, batch, JSON.parse(batch.template_snapshot));
    site.file(`verify/${cert.id}.html`, verifyPageHtml({ title: pageTitle(r), body: confirmationCard(r), root: '../' }));
    site.file(`verify/${cert.id}.pdf`, await reportPdf(cert, batch, base));
  }
  site.file('index.html', verifyPageHtml({
    title: 'Verify certificate',
    body: messageCard('Verify a certificate', 'Enter the certificate ID printed on the certificate, or scan its QR code.', 'good'),
    root: '',
  }));
  // 404.html is served at any depth, so its search box needs the site's full address (a GitHub Pages site lives under /<repo>/).
  site.file('404.html', verifyPageHtml({ title: 'Not found', body: messageCard('Not found', 'No issued certificate matches this address. Check the certificate ID and try again.'), root: base ? base + '/' : '/' }));
  // Stops GitHub Pages running the folder through Jekyll.
  site.file('.nojekyll', '');
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="verification-site.zip"');
  res.end(buf);
}));

app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong: ' + err.message });
});

app.listen(PORT, () => console.log(`Certify is running at http://localhost:${PORT}`));
