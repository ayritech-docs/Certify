/* Certify — single-page frontend (no build step) */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normKey = (k) => String(k).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
// Recipient columns that make up the work report rather than the certificate itself.
const REPORT_KEYS = ['project', 'summary', 'work', 'skills', 'remarks'];
const label = (k) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const state = { me: null, pendingCount: 0 };
const can = {
  create: () => ['admin', 'creator'].includes(state.me?.role),
  approve: () => ['admin', 'approver'].includes(state.me?.role),
  admin: () => state.me?.role === 'admin',
};

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && url !== '/api/login') {
    state.me = null;
    renderLogin();
    throw new Error('Please sign in');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.blob();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function download(url, fallbackName) {
  const t = toast('Preparing download…', '', { sticky: true });
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.json()).error || 'Download failed');
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
    const blob = await res.blob();
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    t.remove();
  }
}

// ---------- UI helpers ----------
function toast(msg, type = '', { sticky = false } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  if (!sticky) setTimeout(() => el.remove(), type === 'error' ? 6000 : 3800);
  return el;
}

// Draws the first page of a PDF onto a canvas, sized to its container.
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
async function renderPdfToCanvas(blob, canvas) {
  const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer(), isEvalSupported: false }).promise;
  const page = await pdf.getPage(1);
  const scale = (canvas.clientWidth * (window.devicePixelRatio || 1) * 1.5) / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale });
  const off = Object.assign(document.createElement('canvas'), { width: viewport.width, height: viewport.height });
  await page.render({ canvasContext: off.getContext('2d'), viewport }).promise;
  canvas.width = off.width;
  canvas.height = off.height;
  canvas.getContext('2d').drawImage(off, 0, 0);
  pdf.destroy();
}

function modal({ title, body, actions = '', wide = false, onMount }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">
    <header><h2>${esc(title)}</h2><button class="btn ghost sm x" data-close>${icons.x}</button></header>
    <div class="body">${body}</div>${actions ? `<footer>${actions}</footer>` : ''}</div>`;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close());
  $$('[data-close]', overlay).forEach((b) => b.addEventListener('click', close));
  document.body.append(overlay);
  onMount?.(overlay, close);
  $('input, textarea, select', overlay)?.focus();
  return close;
}

function confirmBox(title, message, okText = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const close = modal({
      title,
      body: `<p>${message}</p>`,
      actions: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="ok">${esc(okText)}</button>`,
      onMount: (el, c) => {
        $('#ok', el).onclick = () => { done = true; c(); resolve(true); };
        new MutationObserver((_, obs) => { if (!el.isConnected) { obs.disconnect(); if (!done) resolve(false); } })
          .observe(document.body, { childList: true });
      },
    });
    return close;
  });
}

async function busy(btn, fn) {
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${btn.textContent.trim()}`;
  try { return await fn(); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; btn.innerHTML = html; }
}

const fmtDate = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const fmtDateTime = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const badge = (status) => `<span class="badge ${status}">${status === 'pending' ? 'awaiting approval' : status === 'rejected' ? 'changes requested' : status}</span>`;

// Converts an uploaded image to a PNG data URL. Options:
//  removeWhite — knock out a white/paper background (threshold: 150–245, higher keeps more of the image)
//  trim        — crop away empty margins so the stamp or signature fills its space
function readImage(file, { maxSize = 800, removeWhite = false, threshold = 200, trim = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/') && !/\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name || '')) {
      return reject(new Error('Please choose an image file (PNG, JPG, WebP, GIF or SVG)'));
    }
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const w0 = img.naturalWidth || img.width || 600;
      const h0 = img.naturalHeight || img.height || 600;
      const s = Math.min(1, maxSize / Math.max(w0, h0)) || 1;
      let c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w0 * s));
      c.height = Math.max(1, Math.round(h0 * s));
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const px = d.data;
      if (removeWhite) {
        const soft = 50;
        for (let i = 0; i < px.length; i += 4) {
          const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
          if (lum > threshold) px[i + 3] = 0;
          else if (lum > threshold - soft) px[i + 3] = Math.round(px[i + 3] * (threshold - lum) / soft);
        }
        ctx.putImageData(d, 0, 0);
      }
      if (trim) {
        let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4;
            const blank = px[i + 3] < 16 || (px[i] > 238 && px[i + 1] > 238 && px[i + 2] > 238);
            if (!blank) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          }
        }
        if (x1 >= x0 && y1 >= y0) {
          const pad = 4;
          x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
          x1 = Math.min(c.width - 1, x1 + pad); y1 = Math.min(c.height - 1, y1 + pad);
          const out = Object.assign(document.createElement('canvas'), { width: x1 - x0 + 1, height: y1 - y0 + 1 });
          out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
          c = out;
        }
      }
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Could not read that image. Try a PNG or JPG (iPhone HEIC photos: share or export as JPG first).'));
    img.src = URL.createObjectURL(file);
  });
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept });
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// ---------- CSV / spreadsheet paste ----------
function parseTable(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const first = text.split('\n')[0];
  const delim = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell.trim());
  rows.push(row);
  return rows.filter((r) => r.some((c) => c));
}

// Collapses spaces and fixes ALL-CAPS / all-lowercase names ("aarav SHARMA" → "Aarav Sharma").
// Mixed-case names such as "McDonald" or "DeSouza" are left as typed.
function tidyName(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  return s.split(' ').map((word) => {
    const letters = word.replace(/[^A-Za-z]/g, '');
    if (letters && letters !== letters.toUpperCase() && letters !== letters.toLowerCase()) return word[0].toUpperCase() + word.slice(1);
    if (/^[A-Z]\.?$/i.test(word)) return word.toUpperCase(); // initials like "k."
    return word.toLowerCase().replace(/(^|[-'’.])([a-z])/g, (_, p, c) => p + c.toUpperCase());
  }).join(' ');
}

const NAME_ALIASES = ['full_name', 'fullname', 'student_name', 'student', 'participant', 'participant_name', 'recipient', 'recipient_name', 'candidate', 'candidate_name', 'employee_name', 'attendee', 'attendee_name'];

function tableToRecipients(rows, fields) {
  if (!rows.length) return { recipients: [], mapped: [], ignored: [] };
  const header = rows[0].map((h) => {
    const k = normKey(h);
    return NAME_ALIASES.includes(k) ? 'name' : k;
  });
  const hasHeader = header.some((k) => fields.includes(k));
  const keys = hasHeader ? header : fields.slice(0, rows[0].length);
  const body = hasHeader ? rows.slice(1) : rows;
  const recipients = body.map((r) => {
    const data = {};
    keys.forEach((k, i) => { if (k && fields.includes(k)) data[k] = r[i] || ''; });
    return { data };
  }).filter((r) => r.data.name);
  return {
    recipients,
    mapped: keys.filter((k) => fields.includes(k)),
    ignored: hasHeader ? rows[0].filter((_, i) => !fields.includes(keys[i])) : [],
  };
}

// ---------- icons ----------
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const icons = {
  home: svg('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>'),
  template: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/>'),
  batch: svg('<path d="M4 7h16M4 12h16M4 17h10"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2.5.5 4 2.3 4 5.5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  download: svg('<path d="M12 4v12m0 0-5-5m5 5 5-5M4 20h16"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  upload: svg('<path d="M12 20V8m0 0-5 5m5-5 5 5M4 4h16"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  send: svg('<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>'),
  copy: svg('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
};

// ---------- shell & routing ----------
const routes = [
  [/^$/, viewSimpleCertificate],
  [/^dashboard$/, viewDashboard],
  [/^records$/, viewRecords],
  [/^templates$/, viewTemplates],
  [/^templates\/new$/, viewTemplateGallery],
  [/^templates\/new\/([\w-]+)$/, (view, preset) => viewTemplateEditor(view, 'new', preset)],
  [/^templates\/(\d+)$/, viewTemplateEditor],
  [/^batches$/, viewBatches],
  [/^batches\/(\d+)$/, viewBatch],
  [/^approvals$/, viewApprovals],
  [/^profile$/, viewProfile],
  [/^users$/, viewUsers],
];

let leaveGuard = null; // returns a message if the current view has unsaved changes
window.addEventListener('hashchange', (e) => {
  if (leaveGuard) {
    const msg = leaveGuard();
    if (msg && !confirm(msg)) {
      history.replaceState(null, '', new URL(e.oldURL).hash);
      return;
    }
  }
  route();
});
window.addEventListener('beforeunload', (e) => { if (leaveGuard?.()) e.preventDefault(); });

function navigate(hash) { location.hash = hash; }

async function route() {
  leaveGuard = null;
  if (!state.me) return renderLogin();
  const hash = location.hash.replace(/^#\/?/, '');
  renderShell(hash);
  const view = $('#view');
  view.innerHTML = '<div class="muted" style="padding:40px;text-align:center"><span class="spinner"></span></div>';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try { await fn(view, ...m.slice(1)); } catch (e) { if (state.me) view.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; }
      return;
    }
  }
  view.innerHTML = '<div class="empty"><h3>Page not found</h3><a href="#/">Go home</a></div>';
}

async function refreshPendingCount() {
  if (!can.approve()) return;
  try {
    const stats = await api('GET', '/api/stats');
    state.pendingCount = stats.pending;
    const el = $('#pending-count');
    if (el) { el.textContent = stats.pending; el.hidden = !stats.pending; }
  } catch { /* ignore */ }
}

function renderShell(hash) {
  const section = hash.split('/')[0];
  const link = (href, icon, text, extra = '') =>
    `<a href="#/${href}" class="${section === href ? 'active' : ''}">${icons[icon]}<span>${text}</span>${extra}</a>`;
  $('#app').innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><img class="brand-logo" src="/brand/ayritech-logo.png" alt="">AYRITECH</div>
      <nav class="nav">
        ${can.create() ? link('', 'plus', 'New certificate') : ''}
        ${link('dashboard', 'home', 'Dashboard')}
        ${link('records', 'check', 'Records')}
        ${link('batches', 'batch', 'Batches')}
        ${can.approve() ? link('approvals', 'check', 'Approvals', `<span class="count" id="pending-count" ${state.pendingCount ? '' : 'hidden'}>${state.pendingCount}</span>`) : ''}
        ${link('templates', 'template', 'Templates')}
        ${link('profile', 'user', 'My Profile')}
        ${can.admin() ? link('users', 'users', 'Users') : ''}
      </nav>
      <div class="me"><b>${esc(state.me.name)}</b><span class="muted">${esc(state.me.role)}</span><br><button id="logout">Sign out</button></div>
    </aside>
    <main class="main" id="view"></main>
  </div>`;
  $('#logout').onclick = async () => { await api('POST', '/api/logout'); state.me = null; location.hash = ''; renderLogin(); };
  refreshPendingCount();
}

function renderLogin() {
  $('#app').innerHTML = `
  <div class="login"><form class="card" id="login-form">
    <div class="brand"><img class="brand-logo" src="/brand/ayritech-logo.png" alt="">AYRITECH</div>
    <p class="muted" style="text-align:center;margin-bottom:22px">Internship certificates for Ayritech Business Solutions</p>
    <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" required></label>
    <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
    <button class="btn primary" style="width:100%;justify-content:center;padding:10px">Sign in</button>
  </form></div>`;
  $('#login-form').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    busy(e.submitter || $('button', e.target), async () => {
      state.me = await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') });
      route();
    });
  };
  $('input[name=username]').focus();
}

// ---------- Dashboard ----------
async function viewDashboard(view) {
  const [stats, batches] = await Promise.all([api('GET', '/api/stats'), api('GET', '/api/batches')]);
  const pending = batches.filter((b) => b.status === 'pending');
  const mine = batches.filter((b) => b.created_by === state.me.id && ['draft', 'rejected'].includes(b.status));
  const recent = batches.filter((b) => b.status === 'approved').slice(0, 5);
  const hour = new Date().getHours();

  const list = (items, empty) => items.length ? `<div class="table-wrap"><table><tbody>${items.map((b) => `
      <tr class="clickable" data-href="#/batches/${b.id}">
        <td><b>${esc(b.name)}</b><div class="muted small">${b.count} certificate${b.count === 1 ? '' : 's'} · ${esc(b.template_name)}</div></td>
        <td class="end">${badge(b.status)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="muted">${empty}</p>`;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${esc(state.me.name.split(' ')[0])}</h1>
      <p class="muted" style="margin:4px 0 0">Here's what's happening with your certificates.</p></div>
      <div class="actions">${can.create() ? `<button class="btn primary" id="new-batch">${icons.plus} New batch</button>` : ''}</div>
    </div>
    ${!state.me.signature && can.approve() ? `<div class="banner warn">✍️ <div>You haven't added your signature yet. <a href="#/profile">Add it now</a> so it can be stamped automatically on the certificates you approve.</div></div>` : ''}
    <div class="grid stats">
      <div class="card stat"><div class="label">Certificates issued</div><div class="value">${stats.issued}</div></div>
      <div class="card stat"><div class="label">Awaiting approval</div><div class="value">${stats.pending}</div></div>
      <div class="card stat"><div class="label">My drafts</div><div class="value">${stats.drafts}</div></div>
      <div class="card stat"><div class="label">Templates</div><div class="value">${stats.templates}</div></div>
    </div>
    ${batches.length ? '' : `<div class="card" style="margin-bottom:16px"><h2>How it works</h2><div class="steps">
      <div class="step"><div class="n">1</div><div><b>Design a template</b><span>Pick a style, add your logo and wording once.</span></div></div>
      <div class="step"><div class="n">2</div><div><b>Add recipients</b><span>Paste from Excel or import a CSV — hundreds at once.</span></div></div>
      <div class="step"><div class="n">3</div><div><b>One-click approval</b><span>The approver's digital signature is stamped automatically.</span></div></div>
      <div class="step"><div class="n">4</div><div><b>Download &amp; share</b><span>PDFs with QR codes anyone can verify online.</span></div></div>
    </div></div>`}
    <div class="grid two">
      ${can.approve() ? `<div class="card"><h2>Waiting for your approval</h2>${list(pending, 'Nothing to review. 🎉')}</div>` : ''}
      ${can.create() ? `<div class="card"><h2>Your drafts</h2>${list(mine, 'No drafts in progress.')}</div>` : ''}
      <div class="card"><h2>Recently issued</h2>${list(recent, 'No certificates issued yet.')}</div>
    </div>`;
  $$('[data-href]', view).forEach((tr) => tr.onclick = () => navigate(tr.dataset.href));
  $('#new-batch', view)?.addEventListener('click', newBatchDialog);
}

// ---------- Batches ----------
function batchTable(batches, emptyMsg) {
  if (!batches.length) return `<div class="empty"><h3>${emptyMsg}</h3></div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Batch</th><th>Template</th><th>Certificates</th><th>Created by</th><th>Updated</th><th>Status</th></tr></thead>
    <tbody>${batches.map((b) => `
      <tr class="clickable" data-href="#/batches/${b.id}">
        <td><b>${esc(b.name)}</b></td>
        <td class="muted">${esc(b.template_name)}</td>
        <td>${b.count}</td>
        <td class="muted">${esc(b.creator_name || '')}</td>
        <td class="muted">${fmtDate(b.reviewed_at || b.submitted_at || b.created_at)}</td>
        <td>${badge(b.status)}</td></tr>`).join('')}</tbody></table></div>`;
}

async function viewBatches(view) {
  const batches = await api('GET', '/api/batches');
  const tabs = [['all', 'All'], ['draft', 'Drafts'], ['rejected', 'Changes requested'], ['pending', 'Awaiting approval'], ['approved', 'Approved']];
  let current = sessionStorage.getItem('batchTab') || 'all';
  view.innerHTML = `
    <div class="page-head"><h1>Batches</h1>
      <div class="actions">${can.create() ? `<button class="btn primary" id="new-batch">${icons.plus} New batch</button>` : ''}</div></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}">${l}<span class="n">${k === 'all' ? batches.length : batches.filter((b) => b.status === k).length}</span></button>`).join('')}</div>
    <div id="list"></div>`;
  const draw = () => {
    $$('[data-tab]', view).forEach((b) => b.classList.toggle('active', b.dataset.tab === current));
    const items = current === 'all' ? batches : batches.filter((b) => b.status === current);
    $('#list', view).innerHTML = batchTable(items, current === 'all' ? 'No batches yet — create one to get started.' : 'Nothing here.');
    $$('[data-href]', view).forEach((tr) => tr.onclick = () => navigate(tr.dataset.href));
  };
  $$('[data-tab]', view).forEach((b) => b.onclick = () => { current = b.dataset.tab; sessionStorage.setItem('batchTab', current); draw(); });
  $('#new-batch', view)?.addEventListener('click', newBatchDialog);
  draw();
}

async function viewApprovals(view) {
  const batches = await api('GET', '/api/batches');
  const pending = batches.filter((b) => b.status === 'pending');
  const reviewed = batches.filter((b) => ['approved', 'rejected'].includes(b.status)).slice(0, 10);
  view.innerHTML = `
    <div class="page-head"><h1>Approvals</h1></div>
    ${!state.me.signature ? `<div class="banner warn">✍️ <div>Add your signature in <a href="#/profile">My Profile</a> before approving — it is placed on certificates automatically.</div></div>` : ''}
    <h2>Waiting for review</h2>
    ${batchTable(pending, 'Nothing waiting for approval. 🎉')}
    <h2 style="margin-top:28px">Recently reviewed</h2>
    ${batchTable(reviewed, 'No reviews yet.')}`;
  $$('[data-href]', view).forEach((tr) => tr.onclick = () => navigate(tr.dataset.href));
}

async function viewBatch(view, id) {
  const [batch, templates] = await Promise.all([api('GET', `/api/batches/${id}`), api('GET', '/api/templates')]);
  const isOwner = batch.created_by === state.me.id || can.admin();
  const editable = ['draft', 'rejected'].includes(batch.status) && can.create() && isOwner;
  let fields = batch.fields;
  let rows = batch.certificates.map((c) => ({ id: c.id, revoked: c.revoked, data: { ...c.data } }));
  let dirty = false;
  let filter = '';
  leaveGuard = () => dirty ? 'You have unsaved changes to this batch. Leave without saving?' : null;

  const extraCols = () => {
    const seen = new Set(fields);
    const extra = [];
    rows.forEach((r) => Object.keys(r.data).forEach((k) => { if (!seen.has(k)) { seen.add(k); extra.push(k); } }));
    return extra;
  };

  view.innerHTML = `
    <div class="crumb"><a href="#/batches">Batches</a> / ${esc(batch.name)}</div>
    <div class="page-head">
      <h1 id="title">${esc(batch.name)}</h1> ${badge(batch.status)}
      <div class="actions" id="actions"></div>
    </div>
    <div id="banner"></div>
    <div class="batch-grid">
      <div>
        ${editable ? `
        <div class="card" style="margin-bottom:16px">
          <div class="drop" id="drop">${icons.upload.replace('<svg', '<svg style="width:26px;height:26px"')}<br>
            <b>Drop a CSV / Excel-exported file here</b>, click to browse, or <b>paste rows</b> copied from Excel / Google Sheets anywhere on this page.
            <div class="small" style="margin-top:6px">Columns: ${fields.map((f) => `<code>${esc(f)}</code>`).join(' ')} · <a href="#" id="csv-template">download a sample CSV</a></div>
          </div>
        </div>` : ''}
        <div class="card">
          <div class="toolbar">
            <h2 style="margin:0">Recipients <span class="muted" id="count"></span></h2>
            <input type="search" id="search" placeholder="Search…" style="margin-left:auto">
            ${editable ? `<button class="btn sm" id="tidy" title="Fix spacing and capitalisation of names, and find duplicates">Aa Tidy names</button><button class="btn sm" id="add-row">${icons.plus} Add row</button><button class="btn sm danger" id="clear-all">Clear all</button>` : ''}
          </div>
          <div class="table-wrap tall" id="table"></div>
        </div>
      </div>
      <div>
        <div class="card meta"><h2>Details</h2><dl>
          <dt>Template</dt><dd>${editable
            ? `<select id="tpl" style="padding:4px 8px">${templates.map((t) => `<option value="${t.id}" ${t.id === batch.template_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`
            : `${esc(batch.template_name)}`}</dd>
          <dt>Created by</dt><dd>${esc(batch.creator_name || '—')}</dd>
          <dt>Created</dt><dd>${fmtDate(batch.created_at)}</dd>
          ${batch.submitted_at ? `<dt>Submitted</dt><dd>${fmtDate(batch.submitted_at)}</dd>` : ''}
          ${batch.approver_name ? `<dt>${batch.status === 'approved' ? 'Approved by' : 'Reviewed by'}</dt><dd>${esc(batch.approver_name)}</dd>` : ''}
          ${batch.reviewed_at ? `<dt>Reviewed</dt><dd>${fmtDate(batch.reviewed_at)}</dd>` : ''}
        </dl></div>
        <div class="card"><h2>Activity</h2><ul class="timeline">${batch.activity.map((a) => `
          <li class="${esc(a.action)}"><b>${esc(a.user_name || 'Someone')}</b> ${esc(a.action)}<div class="muted small">${fmtDateTime(a.at)}</div>
          ${a.comment ? `<div class="c">${esc(a.comment)}</div>` : ''}</li>`).join('')}</ul></div>
      </div>
    </div>`;

  // --- banner & actions
  const banner = $('#banner', view);
  if (batch.status === 'rejected') banner.innerHTML = `<div class="banner bad"><div><b>Changes requested by ${esc(batch.approver_name)}:</b> ${esc(batch.review_comment)}<br><span class="small">Make the changes below and submit again.</span></div></div>`;
  else if (batch.status === 'pending') banner.innerHTML = can.approve()
    ? `<div class="banner info"><div>This batch is waiting for approval. Preview the certificates, then approve or send it back with a note.</div></div>`
    : `<div class="banner warn"><div>Submitted for approval — you'll be able to download certificates once it's approved.</div></div>`;
  else if (batch.status === 'approved') banner.innerHTML = `<div class="banner good"><div><b>Approved and issued.</b> ${batch.review_comment ? esc(batch.review_comment) + ' · ' : ''}Each certificate has a QR code that links to its public verification page.</div></div>`;

  const actions = $('#actions', view);
  const approved = batch.status === 'approved';
  actions.innerHTML = [
    editable ? `<span class="dirty-dot" id="dirty" hidden>● Unsaved changes</span>` : '',
    `<button class="btn" id="preview">${icons.eye} ${approved ? 'View all' : 'Preview'}</button>`,
    approved ? `<button class="btn" id="dl-zip">${icons.download} ZIP (one PDF each)</button><button class="btn primary" id="dl-pdf">${icons.download} Download all (PDF)</button>` : '',
    editable ? `<button class="btn" id="rename">Rename</button><button class="btn" id="save">Save</button><button class="btn primary" id="submit">${icons.send} Submit for approval</button>` : '',
    batch.status === 'pending' && isOwner && can.create() ? `<button class="btn" id="withdraw">${icons.undo} Withdraw</button>` : '',
    batch.status === 'pending' && can.approve() ? `<button class="btn danger" id="reject">Send back</button><button class="btn success" id="approve">${icons.check} Approve</button>` : '',
    (editable || (approved && can.admin()) || (batch.status === 'pending' && can.admin())) ? `<button class="btn ghost danger" id="delete" title="Delete batch">${icons.trash}</button>` : '',
  ].join('');

  const setDirty = (v) => { dirty = v; const d = $('#dirty', view); if (d) d.hidden = !v; };

  // --- table
  function drawTable() {
    const cols = [...fields, ...extraCols()];
    const q = filter.toLowerCase();
    const visible = rows.map((r, i) => [r, i]).filter(([r]) => !q || Object.values(r.data).some((v) => String(v).toLowerCase().includes(q)) || (r.id || '').toLowerCase().includes(q));
    $('#count', view).textContent = `(${rows.length})`;
    if (!rows.length) {
      $('#table', view).innerHTML = `<div class="empty"><h3>No recipients yet</h3><p>${editable ? 'Import a CSV, paste rows from a spreadsheet, or add them one by one.' : ''}</p>
        ${editable ? `<button class="btn" id="add-first">${icons.plus} Add a recipient</button>` : ''}</div>`;
      $('#add-first', view)?.addEventListener('click', addRow);
      return;
    }
    $('#table', view).innerHTML = `<table>
      <thead><tr><th></th>${cols.map((c) => `<th>${c === 'issued_on' ? 'Date of issue' : esc(label(c))}${REPORT_KEYS.includes(c) ? ' <span class="muted" title="Part of the work report opened by the QR code">(work report)</span>' : !fields.includes(c) && c !== 'issued_on' ? ' <span title="Not used by this template" style="color:var(--amber)">(unused)</span>' : ''}</th>`).join('')}
      ${!editable ? '<th>Certificate ID</th>' : ''}<th></th></tr></thead>
      <tbody>${visible.map(([r, i]) => `
        <tr data-i="${i}" class="${r.revoked ? 'revoked' : ''}"><td class="num">${i + 1}</td>
        ${cols.map((c) => editable
          ? ['summary', 'work', 'remarks'].includes(c) || /\n/.test(r.data[c] || '')
            ? `<td class="edit"><textarea data-k="${esc(c)}" rows="3">${esc(r.data[c] || '')}</textarea></td>`
            : `<td class="edit"><input type="${c === 'issued_on' ? 'date' : 'text'}" data-k="${esc(c)}" value="${esc(r.data[c] || '')}" placeholder="${c === 'name' ? 'Required' : ''}"></td>`
          : `<td style="white-space:pre-line">${esc(r.data[c] || '')}</td>`).join('')}
        ${!editable ? `<td><code>${esc(r.id)}</code>${r.revoked ? ' <span class="badge revoked">revoked</span>' : ''}</td>` : ''}
        <td class="end">
          ${r.id && !editable ? `<button class="btn ghost sm" data-act="view" title="View">${icons.eye}</button><button class="btn ghost sm" data-act="dl" title="Download PDF">${icons.download}</button>` : ''}
          ${r.id && approved ? `<a class="btn ghost sm" href="/verify/${encodeURIComponent(r.id)}.pdf" target="_blank" rel="noopener" title="The work report the QR code opens">Work report</a>` : ''}
          ${approved && can.approve() ? `<button class="btn ghost sm" data-act="revoke">${r.revoked ? 'Restore' : 'Revoke'}</button>` : ''}
          ${editable ? `<button class="btn ghost sm" data-act="del" title="Remove">${icons.x}</button>` : ''}
        </td></tr>`).join('')}</tbody></table>
      ${visible.length < rows.length ? `<p class="muted small" style="padding:8px 12px">${rows.length - visible.length} hidden by search</p>` : ''}`;

    $$('tbody tr', view).forEach((tr) => {
      const r = rows[Number(tr.dataset.i)];
      $$('input[data-k], textarea[data-k]', tr).forEach((inp) => inp.oninput = () => { r.data[inp.dataset.k] = inp.value; setDirty(true); });
      $$('[data-act]', tr).forEach((b) => b.onclick = async () => {
        const act = b.dataset.act;
        if (act === 'del') { rows.splice(rows.indexOf(r), 1); setDirty(true); drawTable(); }
        if (act === 'view') window.open(`/api/certificates/${r.id}/pdf?inline=1`, '_blank');
        if (act === 'dl') download(`/api/certificates/${r.id}/pdf`, `${r.id}.pdf`);
        if (act === 'revoke') {
          const ok = r.revoked || await confirmBox('Revoke certificate?', `<b>${esc(r.data.name)}</b>'s certificate will show as <b>revoked</b> on the verification page. You can restore it later.`, 'Revoke', true);
          if (!ok) return;
          await busy(b, () => api('POST', `/api/certificates/${r.id}/revoke`, { revoked: !r.revoked }));
          r.revoked = !r.revoked;
          toast(r.revoked ? 'Certificate revoked' : 'Certificate restored', 'success');
          drawTable();
        }
      });
    });
  }

  function addRow() {
    rows.push({ data: {} });
    setDirty(true);
    filter = '';
    $('#search', view).value = '';
    drawTable();
    const last = $$('tbody tr', view).at(-1);
    $('input', last)?.focus();
    last?.scrollIntoView({ block: 'nearest' });
  }

  function importText(text, source) {
    const parsed = tableToRecipients(parseTable(text), fields);
    if (!parsed.recipients.length) return toast(`No rows with a name found in the ${source}. Make sure there is a "name" column.`, 'error');
    const blank = rows.filter((r) => !Object.values(r.data).some(Boolean));
    rows = rows.filter((r) => !blank.includes(r)).concat(parsed.recipients);
    setDirty(true);
    drawTable();
    const missing = fields.filter((f) => !parsed.mapped.includes(f));
    toast(`Added ${parsed.recipients.length} recipient${parsed.recipients.length === 1 ? '' : 's'} from ${source}` +
      (missing.length ? ` — fill in: ${missing.join(', ')}` : ''), 'success');
    if (parsed.ignored.length) setTimeout(() => toast(`Ignored columns not used by the template: ${parsed.ignored.join(', ')}`), 400);
  }

  async function save(quiet) {
    const clean = rows.filter((r) => Object.values(r.data).some((v) => String(v).trim()));
    const missingName = clean.findIndex((r) => !String(r.data.name || '').trim());
    if (missingName >= 0) throw new Error(`Row ${rows.indexOf(clean[missingName]) + 1} has no name`);
    await api('PUT', `/api/batches/${batch.id}`, {
      template_id: Number($('#tpl', view)?.value || batch.template_id),
      recipients: clean.map((r) => ({ id: r.id, data: r.data })),
    });
    setDirty(false);
    if (!quiet) toast('Saved', 'success');
  }

  drawTable();
  $('#search', view).oninput = (e) => { filter = e.target.value; drawTable(); };

  if (editable) {
    $('#add-row', view).onclick = addRow;
    $('#tidy', view).onclick = () => {
      let changed = 0;
      for (const r of rows) {
        const before = String(r.data.name || '');
        const name = tidyName(before);
        if (name !== before) { r.data.name = name; changed++; }
      }
      const seen = new Map();
      rows.forEach((r, i) => {
        const k = String(r.data.name || '').toLowerCase();
        if (k) seen.set(k, [...(seen.get(k) || []), i + 1]);
      });
      const dupes = [...seen.values()].filter((v) => v.length > 1);
      if (changed) { setDirty(true); drawTable(); }
      toast(changed ? `Tidied ${changed} name${changed === 1 ? '' : 's'}` : 'All names already look tidy', 'success');
      if (dupes.length) toast(`Possible duplicates in rows: ${dupes.map((d) => d.join(' & ')).join(', ')}`, 'error');
    };
    $('#clear-all', view).onclick = async () => {
      if (rows.length && await confirmBox('Remove all recipients?', 'This clears the table. Nothing is deleted until you save.', 'Clear all', true)) {
        rows = []; setDirty(true); drawTable();
      }
    };
    $('#tpl', view).onchange = async (e) => {
      const t = templates.find((x) => x.id === Number(e.target.value));
      fields = t.fields;
      setDirty(true);
      drawTable();
      $('#drop .small', view).innerHTML = `Columns: ${fields.map((f) => `<code>${esc(f)}</code>`).join(' ')} · <a href="#" id="csv-template">download a sample CSV</a>`;
      bindSample();
    };
    const drop = $('#drop', view);
    drop.onclick = async (e) => {
      if (e.target.id === 'csv-template') return;
      const file = await pickFile('.csv,.tsv,.txt,text/csv');
      if (file) importText(await file.text(), file.name);
    };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = async (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (/\.xlsx?$/i.test(file.name)) return toast('Please save the spreadsheet as CSV first (File → Save As → CSV), or copy the rows and paste them here.', 'error');
      importText(await file.text(), file.name);
    };
    const bindSample = () => $('#csv-template', view).onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sample = fields.map((f) => f === 'name' ? 'Jane Doe' : f === 'date' ? new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : `Example ${label(f)}`);
      const csv = [fields.join(','), sample.map((v) => `"${v}"`).join(',')].join('\r\n');
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'recipients-template.csv' });
      a.click();
    };
    bindSample();

    // Paste rows straight from a spreadsheet
    const onPaste = (e) => {
      if (!document.body.contains(view) || !$('#drop', view)) return document.removeEventListener('paste', onPaste);
      const text = e.clipboardData.getData('text/plain');
      const isTable = text.includes('\t') || text.trim().split(/\r?\n/).length > 1;
      if (!isTable || $('.overlay')) return;
      e.preventDefault();
      importText(text, 'clipboard');
    };
    document.addEventListener('paste', onPaste);

    $('#save', view).onclick = (e) => busy(e.currentTarget, () => save());
    $('#rename', view).onclick = () => modal({
      title: 'Rename batch',
      body: `<label class="field"><span>Batch name</span><input type="text" id="rn" value="${esc(batch.name)}"></label>`,
      actions: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="rn-ok">Save</button>`,
      onMount: (el, close) => $('#rn-ok', el).onclick = () => busy($('#rn-ok', el), async () => {
        const name = $('#rn', el).value.trim();
        if (!name) throw new Error('Name is required');
        await api('PUT', `/api/batches/${batch.id}`, { name });
        batch.name = name;
        $('#title', view).textContent = name;
        close();
      }),
    });
    $('#submit', view).onclick = (e) => {
      const btn = e.currentTarget;
      busy(btn, async () => {
        await save(true);
        const count = rows.filter((r) => String(r.data.name || '').trim()).length;
        if (!count) throw new Error('Add at least one recipient first');
        const empties = fields.filter((f) => rows.some((r) => String(r.data.name || '').trim() && !String(r.data[f] || '').trim()));
        modal({
          title: 'Submit for approval',
          body: `<p>Send <b>${count} certificate${count === 1 ? '' : 's'}</b> to an approver?</p>
            ${empties.length ? `<div class="banner warn small">Some recipients have an empty <b>${empties.join(', ')}</b>. That text will be blank on their certificate.</div>` : ''}
            <label class="field"><span>Note for the approver (optional)</span><textarea id="note" placeholder="e.g. Final list from the attendance sheet"></textarea></label>`,
          actions: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="go">${icons.send} Submit</button>`,
          onMount: (el, close) => $('#go', el).onclick = () => busy($('#go', el), async () => {
            await api('POST', `/api/batches/${batch.id}/submit`, { comment: $('#note', el).value.trim() });
            close();
            toast('Submitted for approval', 'success');
            route();
          }),
        });
      });
    };
  }

  $('#preview', view).onclick = (e) => busy(e.currentTarget, async () => {
    if (editable && dirty) await save(true);
    if (!rows.length) throw new Error('Add recipients to preview their certificates');
    window.open(`/api/batches/${batch.id}/download?inline=1`, '_blank');
  });
  $('#dl-pdf', view)?.addEventListener('click', () => download(`/api/batches/${batch.id}/download`, 'certificates.pdf'));
  $('#dl-zip', view)?.addEventListener('click', () => download(`/api/batches/${batch.id}/download?format=zip`, 'certificates.zip'));
  $('#withdraw', view)?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    await api('POST', `/api/batches/${batch.id}/withdraw`);
    toast('Withdrawn — you can edit it again', 'success');
    route();
  }));
  $('#approve', view)?.addEventListener('click', () => {
    if (!state.me.signature) {
      toast('Add your signature in My Profile first', 'error');
      return navigate('#/profile');
    }
    modal({
      title: `Approve ${batch.count} certificate${batch.count === 1 ? '' : 's'}?`,
      body: `<p>Your signature will be applied to every certificate in <b>${esc(batch.name)}</b> and they will be issued immediately.</p>
        <div class="sig-current" style="margin:10px 0 14px"><img src="${state.me.signature}" alt="Your signature"></div>
        <label class="field"><span>Comment (optional)</span><textarea id="c"></textarea></label>`,
      actions: `<button class="btn" data-close>Cancel</button><button class="btn success" id="ok">${icons.check} Approve &amp; issue</button>`,
      onMount: (el, close) => $('#ok', el).onclick = () => busy($('#ok', el), async () => {
        await api('POST', `/api/batches/${batch.id}/approve`, { comment: $('#c', el).value.trim() });
        close();
        toast('Approved — certificates are ready to download', 'success');
        route();
      }),
    });
  });
  $('#reject', view)?.addEventListener('click', () => modal({
    title: 'Send back for changes',
    body: `<label class="field"><span>What needs to change?</span><textarea id="c" placeholder="e.g. Row 12 has a misspelt name, and the course title should be …"></textarea></label>`,
    actions: `<button class="btn" data-close>Cancel</button><button class="btn danger" id="ok">Send back</button>`,
    onMount: (el, close) => $('#ok', el).onclick = () => busy($('#ok', el), async () => {
      await api('POST', `/api/batches/${batch.id}/reject`, { comment: $('#c', el).value.trim() });
      close();
      toast('Sent back to the creator');
      route();
    }),
  }));
  $('#delete', view)?.addEventListener('click', async () => {
    const msg = approved ? 'These certificates are already issued. Deleting the batch makes them fail verification. This cannot be undone.' : 'This permanently deletes the batch and its recipients.';
    if (!await confirmBox('Delete batch?', msg, 'Delete', true)) return;
    await api('DELETE', `/api/batches/${batch.id}`);
    dirty = false;
    toast('Batch deleted');
    navigate('#/batches');
  });
}

// ---------- Profile ----------
function signaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  let drawing = false, last = null, empty = true;
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * 2;
    canvas.height = r.height * 2;
    ctx.scale(2, 2);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = '#14213d';
  };
  resize();
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 }; };
  canvas.onpointerdown = (e) => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); };
  canvas.onpointermove = (e) => {
    if (!drawing) return;
    const p = pos(e);
    const dist = Math.hypot(p.x - last.x, p.y - last.y);
    ctx.lineWidth = Math.max(1.4, Math.min(3.4, 3.6 - dist * 0.08));
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.quadraticCurveTo(last.x, last.y, (last.x + p.x) / 2, (last.y + p.y) / 2);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    empty = false;
  };
  canvas.onpointerup = canvas.onpointercancel = () => { drawing = false; };
  return {
    clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); empty = true; },
    isEmpty: () => empty,
    // Crop to the drawn area so the signature sits nicely on certificates
    toDataURL: () => {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let x0 = canvas.width, y0 = canvas.height, x1 = 0, y1 = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        if (d[(y * canvas.width + x) * 4 + 3]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      }
      const pad = 8, w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2;
      const out = Object.assign(document.createElement('canvas'), { width: w, height: h });
      out.getContext('2d').drawImage(canvas, x0 - pad, y0 - pad, w, h, 0, 0, w, h);
      return out.toDataURL('image/png');
    },
  };
}

async function viewProfile(view) {
  const me = state.me;
  view.innerHTML = `
    <div class="page-head"><h1>My Profile</h1></div>
    <div class="grid two">
      <div class="card"><h2>Details</h2>
        <label class="field"><span>Full name</span><input type="text" id="p-name" value="${esc(me.name)}"></label>
        <label class="field"><span>Job title</span><input type="text" id="p-title" value="${esc(me.title)}" placeholder="e.g. Director of Training"><div class="hint">Printed under your signature.</div></label>
        <p class="muted small">Username: <b>${esc(me.username)}</b> · Role: <b>${esc(me.role)}</b></p>
        <button class="btn primary" id="p-save">Save details</button>
      </div>
      <div class="card"><h2>Signature</h2>
        <p class="muted small">${can.approve() ? 'Stamped automatically on every certificate you approve.' : 'Used if you are given approval rights later.'}</p>
        <div class="sig-current" id="sig-current">${me.signature ? `<img src="${me.signature}" alt="Current signature">` : '<span class="muted">No signature yet</span>'}</div>
        <div class="tabs" style="margin-top:12px"><button class="active" data-sig="draw">Draw</button><button data-sig="upload">Upload image</button></div>
        <div id="sig-draw"><canvas class="sigpad" id="pad"></canvas>
          <div class="toolbar" style="margin-top:10px"><button class="btn sm" id="pad-clear">Clear</button><span class="muted small">Sign with your mouse, trackpad or finger</span>
          <button class="btn primary sm" id="pad-save" style="margin-left:auto">Use this signature</button></div></div>
        <div id="sig-upload" hidden><div class="drop" id="sig-drop">${icons.upload.replace('<svg', '<svg style="width:24px;height:24px"')}<br>
          <b>Upload from your device</b><br>A photo or scan of your signature. You can remove the paper background before saving.</div></div>
        ${me.signature ? '<button class="btn sm ghost danger" id="sig-rm" style="margin-top:10px">Remove signature</button>' : ''}
      </div>
      <div class="card"><h2>Change password</h2>
        <label class="field"><span>Current password</span><input type="password" id="pw-cur" autocomplete="current-password"></label>
        <label class="field"><span>New password</span><input type="password" id="pw-new" autocomplete="new-password"></label>
        <button class="btn" id="pw-save">Update password</button>
      </div>
    </div>`;

  const pad = signaturePad($('#pad', view));
  const saveSig = async (signature) => {
    state.me = await api('PUT', '/api/me', { signature });
    toast(signature ? 'Signature saved' : 'Signature removed', 'success');
    viewProfile(view);
  };
  $$('[data-sig]', view).forEach((b) => b.onclick = () => {
    $$('[data-sig]', view).forEach((x) => x.classList.toggle('active', x === b));
    $('#sig-draw', view).hidden = b.dataset.sig !== 'draw';
    $('#sig-upload', view).hidden = b.dataset.sig !== 'upload';
  });
  $('#pad-clear', view).onclick = () => pad.clear();
  $('#pad-save', view).onclick = (e) => busy(e.currentTarget, async () => {
    if (pad.isEmpty()) throw new Error('Draw your signature first');
    await saveSig(pad.toDataURL());
  });
  $('#sig-drop', view).onclick = () => uploadImageDialog({
    kind: 'signature', title: 'Upload your signature', library: false, maxSize: 700,
    onPick: (src) => saveSig(src).catch((e) => toast(e.message, 'error')),
  });
  $('#sig-rm', view)?.addEventListener('click', () => saveSig(null));
  $('#p-save', view).onclick = (e) => busy(e.currentTarget, async () => {
    state.me = await api('PUT', '/api/me', { name: $('#p-name', view).value, title: $('#p-title', view).value });
    $('.sidebar .me b').textContent = state.me.name;
    toast('Details saved', 'success');
  });
  $('#pw-save', view).onclick = (e) => busy(e.currentTarget, async () => {
    await api('PUT', '/api/me', { currentPassword: $('#pw-cur', view).value, newPassword: $('#pw-new', view).value });
    $('#pw-cur', view).value = $('#pw-new', view).value = '';
    toast('Password updated', 'success');
  });
}

// ---------- Users ----------
const ROLE_INFO = {
  creator: 'Creates templates and batches, submits them for approval',
  approver: 'Reviews and approves batches; their signature goes on certificates',
  admin: 'Everything, including managing users',
};

async function viewUsers(view) {
  const users = await api('GET', '/api/users');
  view.innerHTML = `
    <div class="page-head"><h1>Users</h1><div class="actions"><button class="btn primary" id="add">${icons.plus} Add user</button></div></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Signature</th><th></th></tr></thead>
      <tbody>${users.map((u) => `<tr>
        <td><b>${esc(u.name)}</b><div class="muted small">${esc(u.title || '')}</div></td>
        <td>${esc(u.username)}</td>
        <td><span class="badge ${u.role === 'admin' ? 'approved' : u.role === 'approver' ? 'pending' : 'draft'}">${u.role}</span></td>
        <td>${u.signature ? `<img src="${u.signature}" style="height:28px">` : '<span class="muted small">—</span>'}</td>
        <td class="end"><button class="btn sm" data-edit="${u.id}">Edit</button>
          ${u.id !== state.me.id ? `<button class="btn sm ghost danger" data-del="${u.id}">${icons.trash}</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
    <div class="card" style="margin-top:16px"><h2>Roles</h2>${Object.entries(ROLE_INFO).map(([r, d]) => `<p><b>${label(r)}</b> — <span class="muted">${d}</span></p>`).join('')}</div>`;

  const form = (u = {}) => modal({
    title: u.id ? `Edit ${u.name}` : 'Add user',
    body: `
      <div class="row"><label class="field"><span>Full name</span><input type="text" id="u-name" value="${esc(u.name || '')}"></label>
      <label class="field"><span>Job title</span><input type="text" id="u-title" value="${esc(u.title || '')}"></label></div>
      <div class="row"><label class="field"><span>Username</span><input type="text" id="u-user" value="${esc(u.username || '')}" ${u.id ? 'disabled' : ''}></label>
      <label class="field"><span>Role</span><select id="u-role">${Object.keys(ROLE_INFO).map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${label(r)}</option>`).join('')}</select></label></div>
      <label class="field"><span>${u.id ? 'New password (leave blank to keep)' : 'Password'}</span><input type="text" id="u-pw" autocomplete="off"></label>
      <div class="hint" id="role-hint"></div>`,
    actions: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="u-ok">${u.id ? 'Save' : 'Add user'}</button>`,
    onMount: (el, close) => {
      const hint = () => $('#role-hint', el).textContent = ROLE_INFO[$('#u-role', el).value];
      $('#u-role', el).onchange = hint;
      hint();
      $('#u-ok', el).onclick = () => busy($('#u-ok', el), async () => {
        const body = { name: $('#u-name', el).value.trim(), title: $('#u-title', el).value.trim(), role: $('#u-role', el).value, password: $('#u-pw', el).value };
        if (u.id) await api('PUT', `/api/users/${u.id}`, body);
        else await api('POST', '/api/users', { ...body, username: $('#u-user', el).value });
        close();
        toast(u.id ? 'User updated' : 'User added — share their username and password with them', 'success');
        viewUsers(view);
      });
    },
  });
  $('#add', view).onclick = () => form();
  $$('[data-edit]', view).forEach((b) => b.onclick = () => form(users.find((u) => u.id === Number(b.dataset.edit))));
  $$('[data-del]', view).forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id === Number(b.dataset.del));
    if (!await confirmBox('Delete user?', `Remove <b>${esc(u.name)}</b>'s account?`, 'Delete', true)) return;
    try { await api('DELETE', `/api/users/${u.id}`); toast('User deleted'); viewUsers(view); } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- boot ----------
(async () => {
  try { state.me = await api('GET', '/api/me'); } catch { /* not signed in */ }
  route();
})();
