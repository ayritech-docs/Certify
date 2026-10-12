/* Templates: purpose-based gallery, template list, the editor (wording, signatures, stamps) and the batch template picker. */

const STYLE_SWATCH = {
  classic: (p, a) => `background:#fffdf7;box-shadow:inset 0 0 0 5px ${p},inset 0 0 0 9px #fffdf7,inset 0 0 0 10px ${a}`,
  elegant: (p, a) => `background:#fff;box-shadow:inset 0 0 0 4px #fff,inset 0 0 0 6px ${a},inset 0 0 0 9px #fff,inset 0 0 0 10px ${p}`,
  modern: (p, a) => `background:linear-gradient(90deg,${p} 0 10%,${a} 10% 12%,#fff 12%)`,
  minimal: (p, a) => `background:linear-gradient(180deg,${p} 0 8%,${a} 8% 11%,#fff 11% 95%,${p} 95%)`,
};
const COLOR_PRESETS = [['#1f3a5f', '#b8892b'], ['#0f5132', '#c9a227'], ['#5b1a32', '#c79a3b'], ['#1c1f2a', '#8a8f9c'], ['#4f46e5', '#06b6d4'], ['#0e7490', '#f59e0b'], ['#9d174d', '#f472b6'], ['#7c2d12', '#ea580c']];
const PLACEHOLDER_CHIPS = ['{{course}}', '{{date}}', '{{event}}', '{{position}}', '{{year}}', '{{grade}}', '{{issue_date}}', '{{id}}'];
const CATEGORY_ICON = { Education: '🎓', Corporate: '💼', Events: '🎤', Awards: '🏆', Sports: '🏅', Volunteering: '🤝' };
const STAMP_TYPES = {
  image: { label: 'Upload from device', icon: '📤' },
  seal: { label: 'Award seal', icon: '🏅' },
  round: { label: 'Round stamp', icon: '⭕' },
  rect: { label: 'Rectangle stamp', icon: '▭' },
};
const STAMP_POSITIONS = {
  'bottom-center': 'Bottom centre', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right',
  'top-left': 'Top left', 'top-right': 'Top right', 'middle-left': 'Middle left', 'middle-right': 'Middle right',
  'signature-1': 'On signature 1', 'signature-2': 'On signature 2', 'signature-3': 'On signature 3',
};

let presetsCache = null;
const getPresets = async () => (presetsCache ||= await api('GET', '/api/presets'));
const categoryChip = (c) => `${CATEGORY_ICON[c] || '📄'} ${esc(c || 'Other')}`;

// ---------- thumbnails ----------
const thumbCache = new Map();
const thumbJobs = [];
let thumbActive = 0;
function pumpThumbs() {
  while (thumbActive < 3 && thumbJobs.length) {
    const job = thumbJobs.shift();
    thumbActive++;
    job().catch(() => {}).finally(() => { thumbActive--; pumpThumbs(); });
  }
}
async function pdfToImage(blob, width) {
  const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer(), isEvalSupported: false }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const canvas = Object.assign(document.createElement('canvas'), { width: viewport.width, height: viewport.height });
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  pdf.destroy();
  return canvas.toDataURL('image/jpeg', 0.85);
}
// Fills <img data-thumb="key"> elements with rendered certificate previews.
function loadThumbs(root, configs) {
  $$('img[data-thumb]', root).forEach((img) => {
    const key = img.dataset.thumb;
    if (thumbCache.has(key)) { img.src = thumbCache.get(key); return; }
    thumbJobs.push(async () => {
      if (!img.isConnected) return;
      const blob = await api('POST', '/api/preview', { config: configs[key] });
      const url = await pdfToImage(blob, 560);
      thumbCache.set(key, url);
      img.src = url;
    });
  });
  pumpThumbs();
}

function categoryFilter(categories, current, counts) {
  return `<div class="filters">${['all', ...categories].map((c) => `<button class="filter ${c === current ? 'active' : ''}" data-cat="${esc(c)}">
    ${c === 'all' ? 'All' : categoryChip(c)}${counts ? ` <span class="n">${counts[c] || 0}</span>` : ''}</button>`).join('')}</div>`;
}

// ---------- Template list ----------
async function viewTemplates(view) {
  const [templates, { categories }] = await Promise.all([api('GET', '/api/templates'), getPresets()]);
  const counts = { all: templates.length };
  templates.forEach((t) => { const c = t.config.category || 'Other'; counts[c] = (counts[c] || 0) + 1; });
  const cats = [...categories, 'Other'].filter((c) => counts[c]);
  let current = sessionStorage.getItem('tplCat') || 'all';
  if (current !== 'all' && !counts[current]) current = 'all';

  view.innerHTML = `
    <div class="page-head"><div><h1>Templates</h1><p class="muted" style="margin:4px 0 0">Design a certificate once, then reuse it for every batch.</p></div>
      <div class="actions">${can.create() ? `<a class="btn primary" href="#/templates/new">${icons.plus} New template</a>` : ''}</div></div>
    <div id="filters"></div><div id="grid"></div>`;
  const configs = {};
  const draw = () => {
    $('#filters', view).innerHTML = cats.length > 1 ? categoryFilter(cats, current, counts) : '';
    $$('[data-cat]', view).forEach((b) => b.onclick = () => { current = b.dataset.cat; sessionStorage.setItem('tplCat', current); draw(); });
    const list = templates.filter((t) => current === 'all' || (t.config.category || 'Other') === current);
    $('#grid', view).innerHTML = list.length ? `<div class="grid tpl-grid">${list.map((t) => {
      const key = `t${t.id}-${t.updated_at}`;
      configs[key] = t.config;
      return `<div class="card tpl-card" data-id="${t.id}">
        <div class="thumb"><img data-thumb="${key}" alt=""></div>
        <div class="info"><div style="flex:1;min-width:0"><b>${esc(t.name)}</b>
          <span class="muted small">${t.config.category ? categoryChip(t.config.category) + ' · ' : ''}used by ${t.batch_count} batch${t.batch_count === 1 ? '' : 'es'}</span></div>
        ${can.create() ? `<button class="btn ghost sm" data-dup="${t.id}" title="Duplicate">${icons.copy}</button>` : ''}</div>
      </div>`;
    }).join('')}</div>` : `<div class="card empty"><h3>No templates yet</h3><p>Pick a ready-made design for your purpose and adjust it.</p>
      ${can.create() ? `<a class="btn primary" href="#/templates/new">${icons.plus} Browse designs</a>` : ''}</div>`;
    $$('.tpl-card', view).forEach((c) => c.onclick = (e) => {
      const dup = e.target.closest('[data-dup]');
      if (dup) {
        e.stopPropagation();
        return busy(dup, async () => { const { id } = await api('POST', `/api/templates/${dup.dataset.dup}/duplicate`); navigate(`#/templates/${id}`); });
      }
      navigate(`#/templates/${c.dataset.id}`);
    });
    loadThumbs(view, configs);
  };
  draw();
}

// ---------- Gallery of ready-made designs ----------
async function viewTemplateGallery(view) {
  const { categories, presets } = await getPresets();
  let current = 'all';
  const configs = Object.fromEntries(presets.map((p) => [`p-${p.id}`, p.config]));
  view.innerHTML = `
    <div class="crumb"><a href="#/templates">Templates</a> / New</div>
    <div class="page-head"><div><h1>What is the certificate for?</h1>
      <p class="muted" style="margin:4px 0 0">Pick a design that matches your purpose. You can change the wording, colours, signatures and stamps next.</p></div></div>
    <div id="filters"></div><div class="grid tpl-grid" id="grid"></div>`;
  const draw = () => {
    $('#filters', view).innerHTML = categoryFilter(categories, current);
    $$('[data-cat]', view).forEach((b) => b.onclick = () => { current = b.dataset.cat; draw(); });
    const list = presets.filter((p) => current === 'all' || p.category === current || !p.category);
    $('#grid', view).innerHTML = list.map((p) => `
      <div class="card tpl-card" data-preset="${p.id}">
        <div class="thumb"><img data-thumb="p-${p.id}" alt=""></div>
        <div class="info"><div style="flex:1;min-width:0"><b>${esc(p.name)}</b><span class="muted small">${esc(p.description)}</span></div>
        ${p.category ? `<span class="tag">${categoryChip(p.category)}</span>` : ''}</div>
      </div>`).join('');
    $$('[data-preset]', view).forEach((c) => c.onclick = () => navigate(`#/templates/new/${c.dataset.preset}`));
    loadThumbs(view, configs);
  };
  draw();
}

// ---------- New batch: choose a template by purpose ----------
async function newBatchDialog() {
  const [templates, { categories }] = await Promise.all([api('GET', '/api/templates'), getPresets()]);
  if (!templates.length) { toast('Create a template first', 'error'); return navigate('#/templates/new'); }
  const cats = [...categories, 'Other'].filter((c) => templates.some((t) => (t.config.category || 'Other') === c));
  let current = 'all';
  let selected = templates[0].id;
  const configs = {};
  modal({
    title: 'New certificate batch',
    wide: true,
    body: `
      <label class="field"><span>Batch name</span><input type="text" id="b-name" placeholder="e.g. Python Bootcamp — October 2026"></label>
      <div class="field"><span style="font-weight:500;font-size:13px;display:block;margin-bottom:6px">Choose a template</span>
        <div id="b-filters"></div><div class="picker" id="b-grid"></div>
        <div class="hint">You can switch templates later, until the batch is approved. <a href="#/templates/new" data-close>Create a new template</a></div></div>`,
    actions: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="b-create">Create batch</button>`,
    onMount: (el, close) => {
      const draw = () => {
        $('#b-filters', el).innerHTML = cats.length > 1 ? categoryFilter(cats, current) : '';
        $$('[data-cat]', el).forEach((b) => b.onclick = () => { current = b.dataset.cat; draw(); });
        const list = templates.filter((t) => current === 'all' || (t.config.category || 'Other') === current);
        $('#b-grid', el).innerHTML = list.map((t) => {
          const key = `t${t.id}-${t.updated_at}`;
          configs[key] = t.config;
          return `<button type="button" class="pick ${t.id === selected ? 'active' : ''}" data-id="${t.id}">
            <div class="thumb"><img data-thumb="${key}" alt=""></div><b>${esc(t.name)}</b>
            <span class="muted small">${t.config.category ? categoryChip(t.config.category) : 'Other'}</span></button>`;
        }).join('');
        $$('.pick', el).forEach((b) => b.onclick = () => { selected = Number(b.dataset.id); $$('.pick', el).forEach((x) => x.classList.toggle('active', x === b)); });
        loadThumbs(el, configs);
      };
      draw();
      const go = () => busy($('#b-create', el), async () => {
        const name = $('#b-name', el).value.trim();
        if (!name) throw new Error('Give the batch a name');
        const { id } = await api('POST', '/api/batches', { name, template_id: selected });
        close();
        navigate(`#/batches/${id}`);
      });
      $('#b-create', el).onclick = go;
      $('#b-name', el).onkeydown = (e) => e.key === 'Enter' && go();
    },
  });
}

// ---------- Editor ----------
function normaliseConfig(config) {
  const c = structuredClone(config);
  if (!Array.isArray(c.signatories)) {
    c.signatories = c.secondSignatory?.enabled ? [{ name: c.secondSignatory.name, title: c.secondSignatory.title, image: c.secondSignatory.image }] : [];
  }
  delete c.secondSignatory;
  c.stamps ||= [];
  c.showDate ??= true;
  c.category ??= '';
  return c;
}

async function viewTemplateEditor(view, id, presetId) {
  const isNew = id === 'new';
  const { categories, presets } = await getPresets();
  let name, config, batchCount = 0;
  if (isNew) {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return navigate('#/templates/new');
    config = normaliseConfig(preset.config);
    name = preset.id === 'blank' ? 'New template' : preset.name;
  } else {
    const t = (await api('GET', '/api/templates')).find((x) => x.id === Number(id));
    if (!t) throw new Error('Template not found');
    name = t.name;
    config = normaliseConfig(t.config);
    batchCount = t.batch_count;
  }
  const readOnly = !can.create();
  let dirty = isNew;
  leaveGuard = () => dirty && !readOnly ? 'You have unsaved template changes. Leave without saving?' : null;

  view.innerHTML = `
    <div class="crumb"><a href="#/templates">Templates</a> / ${isNew ? '<a href="#/templates/new">New</a> / ' + esc(name) : esc(name)}</div>
    <div class="page-head">
      <input type="text" id="t-name" value="${esc(name)}" style="font-size:20px;font-weight:700;max-width:420px;border-color:transparent;padding-left:4px" ${readOnly ? 'disabled' : ''}>
      <div class="actions">
        ${!isNew && can.create() ? `<button class="btn ghost danger" id="del" title="Delete template">${icons.trash}</button>` : ''}
        ${!readOnly ? `<span class="dirty-dot" id="dirty" ${dirty ? '' : 'hidden'}>● Unsaved</span><button class="btn primary" id="save">Save template</button>` : ''}
      </div>
    </div>
    ${batchCount ? `<div class="banner info small">Used by ${batchCount} batch${batchCount === 1 ? '' : 'es'}. Changes apply to drafts and pending batches. Certificates that are already approved never change.</div>` : ''}
    <div class="editor">
      <fieldset class="form" style="border:0;padding:0;margin:0" ${readOnly ? 'disabled' : ''}>
        <div class="card section"><h3>Purpose &amp; style</h3>
          <label class="field"><span>Purpose</span><select id="cat">
            ${[...categories, ''].map((c) => `<option value="${esc(c)}" ${c === config.category ? 'selected' : ''}>${c ? categoryChip(c) : 'Other'}</option>`).join('')}</select>
            <div class="hint">Used to group templates when you pick one for a batch.</div></label>
          <div class="styles">${Object.keys(STYLE_SWATCH).map((s) => `<button type="button" class="style-opt" data-style="${s}"><div class="sw"></div><div>${label(s)}</div></button>`).join('')}</div>
          <div class="colors" style="margin-top:14px">
            <label class="color-in"><input type="color" id="c-p" value="${config.primaryColor}"> Primary</label>
            <label class="color-in"><input type="color" id="c-a" value="${config.accentColor}"> Accent</label>
          </div>
          <div class="presets">${COLOR_PRESETS.map(([p, a]) => `<button type="button" class="preset" data-p="${p}" data-a="${a}" title="${p} / ${a}"><i style="background:${p}"></i><i style="background:${a}"></i></button>`).join('')}</div>
        </div>

        <div class="card section"><h3>Organisation</h3>
          <label class="field"><span>Organisation name</span><input type="text" data-bind="orgName" spellcheck="true" value="${esc(config.orgName)}"></label>
          <div class="field"><span class="lbl">Logo</span>
            <div class="img-field"><div class="img-box" id="logo-box"></div>
              <button type="button" class="btn sm" id="logo-up">${icons.upload} Upload</button>
              <button type="button" class="btn sm ghost" id="logo-rm">Remove</button></div>
            <div class="hint">PNG or JPG. Transparent PNGs look best.</div>
          </div>
        </div>

        <div class="card section"><h3>Wording</h3>
          <div class="ai-bar">
            <button type="button" class="btn sm ai" id="ai-write">✨ Write with AI</button>
            <button type="button" class="btn sm" id="ai-check">${icons.check} Check grammar</button>
            <select id="ai-rewrite" class="btn sm"><option value="">Rewrite…</option>${REWRITES.map(([l], i) => `<option value="${i}">${l}</option>`).join('')}</select>
          </div>
          <label class="field"><span>Title</span><input type="text" data-bind="title" spellcheck="true" value="${esc(config.title)}"></label>
          <label class="field"><span>Line above the name</span><input type="text" data-bind="subtitle" spellcheck="true" value="${esc(config.subtitle)}"></label>
          <label class="field"><span>Text below the name</span><textarea data-bind="body" id="body" rows="3" spellcheck="true">${esc(config.body)}</textarea>
            <div class="hint">Words in <code>{{double braces}}</code> become columns you fill in for each recipient. Click to insert:</div>
            <div class="chips">${PLACEHOLDER_CHIPS.map((p) => `<button type="button" class="chip" data-ph="${p}">${p}</button>`).join('')}</div>
            <div class="hint" id="fields-hint"></div>
          </label>
          <div id="wcheck"></div>
        </div>

        <div class="card section"><h3>Signatures</h3>
          <label class="check"><input type="checkbox" id="appr" ${config.approverSignature ? 'checked' : ''}> Approver's signature <span class="muted small">(added automatically when a batch is approved)</span></label>
          <div id="sigs"></div>
          <button type="button" class="btn sm" id="sig-add">${icons.plus} Add a signatory</button>
          <div style="margin-top:14px">
            <label class="check"><input type="checkbox" id="date" ${config.showDate ? 'checked' : ''}> Show date of issue</label>
            <label class="check"><input type="checkbox" id="qr" ${config.showQR ? 'checked' : ''}> Show verification QR code</label>
          </div>
        </div>

        <div class="card section"><h3>Stamps &amp; seals</h3>
          <p class="muted small">Upload your organisation's real stamp or seal from your computer or phone, or use a built-in seal or stamp.</p>
          <div class="stamp-add">${Object.entries(STAMP_TYPES).map(([k, v]) => `<button type="button" class="btn sm" data-add-stamp="${k}">${v.icon} ${v.label}</button>`).join('')}</div>
          <div id="stamps"></div>
        </div>
      </fieldset>

      <div class="preview-pane">
        <canvas class="preview-frame" id="frame" aria-label="Certificate preview"></canvas>
        <div class="preview-status"><span id="pv-status">Live preview with sample data</span><a href="#" id="pv-open">Open full size</a></div>
      </div>
    </div>`;

  const markDirty = () => { dirty = true; const d = $('#dirty', view); if (d) d.hidden = false; schedulePreview(); };

  // --- purpose, style & colours
  $('#cat', view).onchange = (e) => { config.category = e.target.value; markDirty(); };
  const drawStyles = () => $$('.style-opt', view).forEach((b) => {
    b.classList.toggle('active', b.dataset.style === config.style);
    $('.sw', b).style.cssText = STYLE_SWATCH[b.dataset.style](config.primaryColor, config.accentColor);
  });
  drawStyles();
  $$('.style-opt', view).forEach((b) => b.onclick = () => { config.style = b.dataset.style; drawStyles(); markDirty(); });
  $('#c-p', view).oninput = (e) => { config.primaryColor = e.target.value; drawStyles(); markDirty(); };
  $('#c-a', view).oninput = (e) => { config.accentColor = e.target.value; drawStyles(); markDirty(); };
  $$('.preset', view).forEach((b) => b.onclick = () => {
    config.primaryColor = $('#c-p', view).value = b.dataset.p;
    config.accentColor = $('#c-a', view).value = b.dataset.a;
    drawStyles();
    markDirty();
  });

  // --- wording, writing check & AI
  const updateFieldsHint = () => {
    const keys = new Set(['name']);
    const stampText = config.stamps.flatMap((s) => [s.text, s.subtext, s.center]);
    for (const k of placeholdersIn([config.title, config.subtitle, config.body, config.orgName, ...stampText].join(' '))) {
      if (k && !['id', 'issue_date'].includes(k)) keys.add(k);
    }
    $('#fields-hint', view).innerHTML = `Recipient columns: ${[...keys].map((k) => `<code>${esc(k)}</code>`).join(' ')}`;
  };
  const runCheck = () => {
    const issues = localWritingCheck(config);
    const box = $('#wcheck', view);
    if (!issues.length) {
      box.innerHTML = '<div class="wcheck ok">✓ No spelling or punctuation problems spotted</div>';
      return;
    }
    box.innerHTML = `<div class="wcheck"><b>Writing check</b>${issues.map((it, i) => `<div class="wc-row">
      <span><span class="muted">${esc(FIELD_LABEL[it.field])}:</span> ${esc(it.message)}</span>
      ${it.fix != null && !readOnly ? `<button type="button" class="btn sm" data-wfix="${i}">Fix</button>` : ''}</div>`).join('')}</div>`;
    $$('[data-wfix]', box).forEach((b) => b.onclick = () => {
      const it = issues[Number(b.dataset.wfix)];
      config[it.field] = it.fix;
      $(`[data-bind="${it.field}"]`, view).value = it.fix;
      onWordingChange();
    });
  };
  const onWordingChange = () => { updateFieldsHint(); runCheck(); markDirty(); };
  const applyWording = (w) => {
    for (const k of ['title', 'subtitle', 'body']) {
      if (w[k] == null) continue;
      config[k] = w[k];
      $(`[data-bind="${k}"]`, view).value = w[k];
    }
    onWordingChange();
  };
  const wording = () => ({ title: config.title, subtitle: config.subtitle, body: config.body });
  let checkTimer;
  $$('[data-bind]', view).forEach((inp) => inp.oninput = () => {
    config[inp.dataset.bind] = inp.value;
    updateFieldsHint();
    markDirty();
    clearTimeout(checkTimer);
    checkTimer = setTimeout(runCheck, 400);
  });
  updateFieldsHint();
  runCheck();
  $$('[data-ph]', view).forEach((chip) => chip.onclick = () => {
    const ta = $('#body', view);
    const s = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + chip.dataset.ph + ta.value.slice(ta.selectionEnd ?? s);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + chip.dataset.ph.length;
    config.body = ta.value;
    onWordingChange();
  });
  $('#ai-write', view).onclick = () => aiSuggestDialog({
    wording: wording(), orgName: config.orgName,
    purpose: [config.category, name].filter(Boolean).join(' — '), onApply: applyWording,
  });
  $('#ai-check', view).onclick = () => aiCheckDialog({ wording: wording(), onApply: applyWording });
  $('#ai-rewrite', view).onchange = (e) => {
    const r = REWRITES[Number(e.target.value)];
    e.target.value = '';
    if (r) aiRewriteDialog({ wording: wording(), instruction: r[1], label: r[0], onApply: applyWording });
  };
  $('#t-name', view).oninput = (e) => { name = e.target.value; dirty = true; const d = $('#dirty', view); if (d) d.hidden = false; };

  // --- logo
  const drawImg = (box, src) => box.innerHTML = src ? `<img src="${src}" alt="">` : '<span>None</span>';
  drawImg($('#logo-box', view), config.logo);
  $('#logo-up', view).onclick = () => uploadImageDialog({
    kind: 'logo', title: 'Add your logo', removeWhite: false, trim: true,
    onPick: (src) => { config.logo = src; drawImg($('#logo-box', view), src); markDirty(); },
  });
  $('#logo-rm', view).onclick = () => { config.logo = null; drawImg($('#logo-box', view), null); markDirty(); };

  // --- signatories
  const maxFixed = () => (config.approverSignature ? 2 : 3);
  function drawSigs() {
    const box = $('#sigs', view);
    box.innerHTML = config.signatories.map((s, i) => `
      <div class="item-card" data-i="${i}">
        <div class="item-head"><b>Signatory ${i + (config.approverSignature ? 2 : 1)}</b>
          <button type="button" class="btn ghost sm" data-rm title="Remove">${icons.x}</button></div>
        <div class="row"><label class="field"><span>Name</span><input type="text" data-k="name" value="${esc(s.name || '')}"></label>
        <label class="field"><span>Title</span><input type="text" data-k="title" value="${esc(s.title || '')}" placeholder="e.g. Head of Training"></label></div>
        <div class="img-field"><div class="img-box"></div>
          <button type="button" class="btn sm" data-draw>✍️ Draw</button>
          <button type="button" class="btn sm" data-up>${icons.upload} Upload</button>
          ${state.me.signature ? '<button type="button" class="btn sm" data-mine>Use mine</button>' : ''}
          <button type="button" class="btn sm ghost" data-clear>Clear</button></div>
      </div>`).join('');
    $$('.item-card', box).forEach((card) => {
      const s = config.signatories[Number(card.dataset.i)];
      drawImg($('.img-box', card), s.image);
      const setImage = (src) => { s.image = src; drawImg($('.img-box', card), src); markDirty(); };
      $$('input[data-k]', card).forEach((inp) => inp.oninput = () => { s[inp.dataset.k] = inp.value; markDirty(); });
      $('[data-rm]', card).onclick = () => { config.signatories.splice(config.signatories.indexOf(s), 1); drawSigs(); markDirty(); };
      $('[data-clear]', card).onclick = () => setImage(null);
      $('[data-mine]', card)?.addEventListener('click', () => {
        setImage(state.me.signature);
        if (!s.name) { s.name = state.me.name; s.title = state.me.title; drawSigs(); }
      });
      $('[data-up]', card).onclick = () => uploadImageDialog({ kind: 'signature', title: 'Upload a signature', onPick: setImage });
      $('[data-draw]', card).onclick = () => drawSignatureDialog(setImage);
    });
    $('#sig-add', view).hidden = config.signatories.length >= maxFixed();
  }
  drawSigs();
  $('#sig-add', view).onclick = () => { config.signatories.push({ name: '', title: '', image: null }); drawSigs(); markDirty(); };
  $('#appr', view).onchange = (e) => {
    config.approverSignature = e.target.checked;
    config.signatories = config.signatories.slice(0, maxFixed());
    drawSigs();
    markDirty();
  };
  $('#date', view).onchange = (e) => { config.showDate = e.target.checked; markDirty(); };
  $('#qr', view).onchange = (e) => { config.showQR = e.target.checked; markDirty(); };

  // --- stamps & seals
  const year = String(new Date().getFullYear());
  const newStamp = (type) => ({
    seal: { type, text: 'Excellence', subtext: year, color: config.accentColor, position: 'bottom-center', size: 84, rotation: 0, opacity: 1 },
    round: { type, text: config.orgName || 'Your Organisation', subtext: 'Official Seal', center: 'Approved', color: '#1d4ed8', position: config.approverSignature || config.signatories.length ? 'signature-1' : 'bottom-left', size: 92, rotation: -12, opacity: 0.85 },
    rect: { type, text: 'Verified', subtext: '', color: '#c4314b', position: 'top-right', size: 80, rotation: 8, opacity: 0.85 },
    image: { type, image: null, position: 'bottom-left', size: 100, rotation: 0, opacity: 0.95 },
  }[type]);
  const TEXT_FIELDS = {
    seal: [['text', 'Main text'], ['subtext', 'Small text']],
    round: [['text', 'Top text'], ['subtext', 'Bottom text'], ['center', 'Centre text']],
    rect: [['text', 'Main text'], ['subtext', 'Small text']],
    image: [],
  };
  const range = (k, labelText, min, max, step, value, unit = '') => `
    <label class="range"><span>${labelText}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${value}"><em>${value}${unit}</em></label>`;
  function drawStampList() {
    const box = $('#stamps', view);
    box.innerHTML = config.stamps.map((st, i) => `
      <div class="item-card" data-i="${i}">
        <div class="item-head"><b>${STAMP_TYPES[st.type].icon} ${STAMP_TYPES[st.type].label}</b>
          <button type="button" class="btn ghost sm" data-rm title="Remove">${icons.x}</button></div>
        ${st.type === 'image' ? `<div class="img-field" style="margin-bottom:10px"><div class="img-box"></div>
          <button type="button" class="btn sm" data-up>${icons.upload} ${st.image ? 'Replace' : 'Upload'} image</button></div>
          <div class="hint" style="margin:-4px 0 10px">Tip: stamp your seal on plain white paper and take a photo; the background can be removed in the upload window.</div>` : ''}
        ${TEXT_FIELDS[st.type].length ? `<div class="row wrap">${TEXT_FIELDS[st.type].map(([k, l]) => `<label class="field"><span>${l}</span><input type="text" data-k="${k}" value="${esc(st[k] || '')}"></label>`).join('')}</div>` : ''}
        <div class="row">
          <label class="field"><span>Position</span><select data-k="position">${Object.entries(STAMP_POSITIONS).map(([k, l]) => `<option value="${k}" ${st.position === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          ${st.type !== 'image' ? `<label class="field" style="flex:0 0 90px"><span>Colour</span><input type="color" data-k="color" value="${st.color}"></label>` : ''}
        </div>
        <div class="ranges">
          ${range('size', 'Size', 40, 180, 2, st.size)}
          ${range('rotation', 'Rotate', -45, 45, 1, st.rotation || 0, '°')}
          ${range('opacity', 'Opacity', 0.2, 1, 0.05, st.opacity ?? 1)}
          ${range('dx', 'Move ↔', -150, 150, 2, st.dx || 0)}
          ${range('dy', 'Move ↕', -150, 150, 2, st.dy || 0)}
        </div>
      </div>`).join('');
    $$('.item-card', box).forEach((card) => {
      const st = config.stamps[Number(card.dataset.i)];
      if (st.type === 'image') drawImg($('.img-box', card), st.image);
      $$('[data-k]', card).forEach((inp) => {
        const update = () => {
          st[inp.dataset.k] = inp.type === 'range' ? Number(inp.value) : inp.value;
          if (inp.type === 'range') inp.nextElementSibling.textContent = inp.value + (inp.dataset.k === 'rotation' ? '°' : '');
          if (inp.type === 'text') updateFieldsHint();
          markDirty();
        };
        inp.oninput = update;
        inp.onchange = update;
      });
      $('[data-rm]', card).onclick = () => { config.stamps.splice(config.stamps.indexOf(st), 1); drawStampList(); updateFieldsHint(); markDirty(); };
      $('[data-up]', card)?.addEventListener('click', () => uploadImageDialog({
        kind: 'stamp', title: 'Replace stamp image',
        onPick: (src) => { st.image = src; drawStampList(); markDirty(); },
      }));
    });
  }
  drawStampList();
  $$('[data-add-stamp]', view).forEach((b) => b.onclick = async () => {
    if (config.stamps.length >= 6) return toast('You can add up to 6 stamps', 'error');
    const st = newStamp(b.dataset.addStamp);
    const add = () => {
      config.stamps.push(st);
      drawStampList();
      updateFieldsHint();
      markDirty();
      $('#stamps .item-card:last-child', view)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    if (st.type !== 'image') return add();
    uploadImageDialog({ kind: 'stamp', title: 'Upload a stamp or seal', onPick: (src) => { st.image = src; add(); } });
  });

  // --- live preview
  let timer, lastUrl, seq = 0;
  async function renderPreview() {
    const my = ++seq;
    $('#pv-status', view).innerHTML = '<span class="spinner" style="width:11px;height:11px"></span> Updating preview…';
    try {
      const blob = await api('POST', '/api/preview', { config });
      if (my !== seq || !document.body.contains(view)) return;
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(blob);
      await renderPdfToCanvas(blob, $('#frame', view));
      if (my === seq) $('#pv-status', view).textContent = 'Live preview with sample data';
    } catch (e) {
      if (my === seq) $('#pv-status', view).textContent = 'Preview failed: ' + e.message;
    }
  }
  function schedulePreview() { clearTimeout(timer); timer = setTimeout(renderPreview, 350); }
  renderPreview();
  $('#pv-open', view).onclick = (e) => { e.preventDefault(); if (lastUrl) window.open(lastUrl, '_blank'); };

  $('#save', view)?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    if (!name.trim()) throw new Error('Give the template a name');
    if (isNew) {
      const r = await api('POST', '/api/templates', { name, config });
      dirty = false;
      toast('Template created', 'success');
      navigate(`#/templates/${r.id}`);
    } else {
      await api('PUT', `/api/templates/${id}`, { name, config });
      dirty = false;
      $('#dirty', view).hidden = true;
      toast('Template saved', 'success');
    }
  }));
  $('#del', view)?.addEventListener('click', async () => {
    if (!await confirmBox('Delete template?', `Delete <b>${esc(name)}</b>? This cannot be undone.`, 'Delete', true)) return;
    try {
      await api('DELETE', `/api/templates/${id}`);
      dirty = false;
      toast('Template deleted');
      navigate('#/templates');
    } catch (e) { toast(e.message, 'error'); }
  });
}

function drawSignatureDialog(onDone) {
  modal({
    title: 'Draw a signature',
    body: '<canvas class="sigpad" id="dpad"></canvas><p class="muted small" style="margin-top:8px">Sign with your mouse, trackpad or finger.</p>',
    actions: '<button class="btn" id="dclear">Clear</button><button class="btn" data-close>Cancel</button><button class="btn primary" id="dok">Use signature</button>',
    onMount: (el, close) => {
      const pad = signaturePad($('#dpad', el));
      $('#dclear', el).onclick = () => pad.clear();
      $('#dok', el).onclick = () => {
        if (pad.isEmpty()) return toast('Draw a signature first', 'error');
        onDone(pad.toDataURL());
        close();
      };
    },
  });
}
