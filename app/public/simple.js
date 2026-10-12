/* Ayritech internship certificate: one short form with a live preview,
   plus the records page listing every certificate issued. */

const COMPANY = 'Ayritech Business Solutions';
const SIMPLE_TEMPLATE_NAME = 'Ayritech internship certificate';
const DEFAULT_BRAND = { logo: '/brand/ayritech-logo.png', seal: '/brand/ayritech-seal-signature.png' };
const DEFAULT_SIGNER = { signatory: 'Ritesh Sawant', designation: 'CEO AYRITECH' };
const SIMPLE_FIELDS = [
  ['name', 'Intern name', 'e.g. Bhumi Govind Koli'],
  ['gender', 'Gender', 'Choose…', 'select'],
  ['role', 'Internship role', 'e.g. Software Development Engineer (SDE) Intern'],
  ['start_date', 'Start date', '', 'date'],
  ['end_date', 'End date', '', 'date'],
  ['issued_on', 'Date of issue', '', 'date'],
  ['signatory', 'Signed by', 'e.g. Ritesh Sawant'],
  ['designation', 'Designation', 'e.g. CEO AYRITECH'],
];
// The intern's work report: the detailed PDF that the certificate's QR code opens.
const REPORT_FIELDS = [
  ['project', 'Project / team', 'e.g. Customer Feedback Platform', 'text', 'optional'],
  ['summary', 'Summary of work', 'A few sentences on what the intern worked on and was responsible for.', 'textarea', 'optional'],
  ['work', 'Key tasks and contributions', 'One per line, e.g.\nBuilt the feedback analytics dashboard in React\nDesigned 12 REST API endpoints in Node.js\nFixed 35 bugs reported by clients', 'textarea', 'optional'],
  ['skills', 'Skills and tools', 'e.g. React, Node.js, PostgreSQL, Git', 'text', 'optional'],
  ['remarks', 'Performance and remarks', 'e.g. Consistently delivered ahead of schedule and was rated "Excellent" in the final review.', 'textarea', 'optional'],
];
// The wording uses the intern's possessive pronoun ("his assigned project").
const GENDERS = { female: ['Female', 'her'], male: ['Male', 'his'], other: ['Other / prefer not to say', 'their'] };
const BRANDING = [
  ['logo', 'Company logo', 'logo'],
  ['seal', 'Seal & signature', 'stamp'],
];

function simpleTemplateConfig(brand = {}) {
  return {
    style: 'ayritech',
    primaryColor: '#3a3536',
    accentColor: '#f5873a',
    wordmark: 'AYRITECH',
    orgName: COMPANY,
    title: 'Certificate',
    subtitle: 'of Internship',
    displayTitle: 'Certificate of Internship',
    body: [
      `This is to certify that {{name}} has completed an internship as a {{role}} at ${COMPANY}.`,
      'The internship commenced on {{start_date}}, and concluded on {{end_date}}.',
      'During this period, {{name}} demonstrated commendable dedication and made valuable contributions to {{pronoun}} assigned project.',
      'We appreciate {{pronoun}} hard work and commitment throughout the internship. We wish {{name}} all the best in {{pronoun}} future endeavors.',
    ].join('\n\n'),
    // One-line summary used on the confirmation page that the QR code opens.
    reason: 'for completing an internship as a {{role}} from {{start_date}} to {{end_date}}',
    logo: brand.logo || null,
    category: 'Corporate',
    approverSignature: false,
    signatories: [{ name: '{{signatory}}', title: '{{designation}}', image: brand.seal || null }],
    showDate: false,
    showQR: true,
    stamps: [],
  };
}

const brandingOf = (config) => ({ logo: config?.logo || null, seal: config?.signatories?.[0]?.image || null });

async function urlToDataUrl(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not load ' + url));
    r.readAsDataURL(blob);
  });
}

// "2025-06-01" -> "June 1, 2025", the style used on Ayritech certificates.
const longDate = (iso) => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';

const findSimpleTemplate = async () => (await api('GET', '/api/templates')).find((t) => t.name === SIMPLE_TEMPLATE_NAME);

// Saves the branding into the shared certificate template (creating it the first time) and returns its id.
// Approval freezes a copy of the template, so changing the branding later never alters issued certificates.
async function saveSimpleTemplate(brand) {
  const config = simpleTemplateConfig(brand);
  const existing = await findSimpleTemplate();
  if (!existing) return (await api('POST', '/api/templates', { name: SIMPLE_TEMPLATE_NAME, config })).id;
  await api('PUT', `/api/templates/${existing.id}`, { name: SIMPLE_TEMPLATE_NAME, config });
  return existing.id;
}

async function viewSimpleCertificate(view) {
  if (!can.create()) return viewDashboard(view);
  const brand = brandingOf((await findSimpleTemplate())?.config);
  for (const k of Object.keys(DEFAULT_BRAND)) if (!brand[k]) brand[k] = await urlToDataUrl(DEFAULT_BRAND[k]);
  const values = Object.fromEntries([...SIMPLE_FIELDS, ...REPORT_FIELDS].map(([k]) => [k, '']));
  const isReportField = (k) => REPORT_FIELDS.some(([f]) => f === k);
  let previewMode = 'certificate';
  let signer = DEFAULT_SIGNER;
  try { signer = { ...signer, ...JSON.parse(localStorage.getItem('certify.signer') || '{}') }; } catch { /* storage unavailable */ }
  Object.assign(values, signer);
  values.issued_on = new Date().toLocaleDateString('en-CA'); // today, as yyyy-mm-dd
  let touched = false;
  leaveGuard = () => touched ? 'This certificate has not been saved. Leave anyway?' : null;

  // What the certificate prints: dates written out in full, gender turned into the pronoun used in the wording.
  // issued_on stays as yyyy-mm-dd; the server shows it as the date of issue.
  const certData = () => {
    const { gender, ...rest } = values;
    return { ...rest, pronoun: GENDERS[gender]?.[1] || '', start_date: longDate(values.start_date), end_date: longDate(values.end_date) };
  };

  const fieldHtml = ([k, text, hint, type, optional]) => `
    <label class="field"><span>${text}${optional ? ' <span class="muted">(optional)</span>' : ''}</span>
      ${type === 'textarea'
        ? `<textarea name="${k}" rows="4" placeholder="${esc(hint)}">${esc(values[k])}</textarea>`
        : type === 'select'
        ? `<select name="${k}"><option value="">${esc(hint)}</option>${Object.entries(GENDERS).map(([v, [lbl]]) => `<option value="${v}">${esc(lbl)}</option>`).join('')}</select>`
        : `<input type="${type || 'text'}" name="${k}" placeholder="${esc(hint)}" value="${esc(values[k])}">`}
    </label>`;

  view.innerHTML = `
    <div class="page-head"><div><h1>New internship certificate</h1>
      <p class="muted" style="margin:4px 0 0">Fill in the intern's details and the work report. The preview updates as you type.</p></div></div>
    <div class="editor">
      <form id="simple-form" novalidate>
        <div class="card">
          <h2>Certificate</h2>
          ${SIMPLE_FIELDS.map(fieldHtml).join('')}
        </div>
        <div class="card">
          <h2>Work report</h2>
          <p class="muted small" style="margin-top:-6px">A detailed PDF of the intern's work. Scanning the QR code on the certificate opens it, so anyone checking the certificate can see exactly what was done.</p>
          ${REPORT_FIELDS.map(fieldHtml).join('')}
          <button class="btn primary" id="simple-save" style="width:100%;justify-content:center;padding:10px">Save certificate</button>
        </div>
        <div class="card">
          <h2>Logo, seal &amp; signature</h2>
          <p class="muted small" style="margin-top:-6px">Printed on the certificate and shown on the page its QR code opens.</p>
          ${BRANDING.map(([k, text]) => `
            <div class="field" style="margin-bottom:12px"><span class="lbl">${text}</span>
              <div class="img-field" data-brand="${k}"><div class="img-box"></div>
                <button type="button" class="btn sm" data-up>${icons.upload} Replace</button>
                <button type="button" class="btn sm ghost" data-reset>Use original</button></div></div>`).join('')}
        </div>
      </form>
      <div class="preview-pane">
        <div class="tabs" style="max-width:520px">
          <button type="button" data-mode="certificate" class="active">Certificate</button>
          <button type="button" data-mode="report">Work report</button>
        </div>
        <canvas class="preview-frame" id="frame" style="aspect-ratio:595/842;max-width:520px" aria-label="Preview"></canvas>
        <div class="preview-status" style="max-width:520px"><span id="pv-status"></span><a href="#" id="pv-open">Open full PDF</a></div>
      </div>
    </div>`;

  const form = $('#simple-form', view);
  let timer, seq = 0, lastUrl;
  async function renderPreview() {
    const my = ++seq;
    $('#pv-status', view).innerHTML = '<span class="spinner" style="width:11px;height:11px"></span> Updating preview…';
    try {
      // Empty fields fall back to the server's sample values so the layout is always visible.
      const data = Object.fromEntries(Object.entries(certData()).filter(([, v]) => v.trim()));
      const blob = previewMode === 'report'
        ? await api('POST', '/api/report-preview', { config: simpleTemplateConfig(brand), data: certData() })
        : await api('POST', '/api/preview', { config: simpleTemplateConfig(brand), data });
      if (my !== seq || !document.body.contains(view)) return;
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(blob);
      await renderPdfToCanvas(blob, $('#frame', view));
      if (my === seq) $('#pv-status', view).textContent = previewMode === 'report' ? 'Work report, page 1' : 'Certificate';
    } catch (e) {
      if (my === seq) $('#pv-status', view).textContent = 'Preview failed: ' + e.message;
    }
  }
  const schedulePreview = () => { clearTimeout(timer); timer = setTimeout(renderPreview, 350); };

  const drawBrandImg = (k) => {
    $(`[data-brand="${k}"] .img-box`, form).innerHTML = brand[k] ? `<img src="${brand[k]}" alt="">` : '<span>None</span>';
  };
  for (const [k, text, kind] of BRANDING) {
    drawBrandImg(k);
    const set = (src) => { brand[k] = src; touched = true; drawBrandImg(k); schedulePreview(); };
    $(`[data-brand="${k}"] [data-up]`, form).onclick = () => uploadImageDialog({
      kind, title: `Upload the ${text.toLowerCase()}`, removeWhite: kind !== 'logo', onPick: set,
    });
    $(`[data-brand="${k}"] [data-reset]`, form).onclick = async () => set(await urlToDataUrl(DEFAULT_BRAND[k]));
  }

  form.oninput = (e) => {
    if (!(e.target.name in values)) return;
    values[e.target.name] = e.target.value;
    touched = true;
    if (previewMode === 'report' || !isReportField(e.target.name)) schedulePreview();
  };
  $$('[data-mode]', view).forEach((b) => b.onclick = () => {
    previewMode = b.dataset.mode;
    $$('[data-mode]', view).forEach((x) => x.classList.toggle('active', x === b));
    renderPreview();
  });
  // Typing in the work report switches the preview to it.
  form.addEventListener('focusin', (e) => {
    const mode = isReportField(e.target.name) ? 'report' : SIMPLE_FIELDS.some(([f]) => f === e.target.name) ? 'certificate' : null;
    if (mode && mode !== previewMode) $(`[data-mode="${mode}"]`, view).click();
  });
  $('#pv-open', view).onclick = (e) => { e.preventDefault(); if (lastUrl) window.open(lastUrl, '_blank'); };
  renderPreview();

  form.onsubmit = (e) => {
    e.preventDefault();
    const missing = SIMPLE_FIELDS.find(([k, , , , optional]) => !optional && !values[k].trim());
    if (missing) {
      toast(`Please fill in "${missing[1]}"`, 'error');
      $(`[name=${missing[0]}]`, form).focus();
      return;
    }
    if (values.issued_on < values.end_date && !confirm('The date of issue is before the end of the internship. Save anyway?')) {
      $('[name=issued_on]', form).focus();
      return;
    }
    if (values.end_date < values.start_date) {
      toast('The end date is before the start date', 'error');
      $('[name=end_date]', form).focus();
      return;
    }
    busy($('#simple-save', view), async () => {
      const data = Object.fromEntries(Object.entries(certData()).map(([k, v]) => [k, v.trim()]));
      const template_id = await saveSimpleTemplate(brand);
      const { id } = await api('POST', '/api/batches', { name: `${data.name} – ${data.role}`, template_id });
      await api('PUT', `/api/batches/${id}`, { recipients: [{ data }] });
      try { localStorage.setItem('certify.signer', JSON.stringify({ signatory: data.signatory, designation: data.designation })); } catch { /* storage unavailable */ }
      leaveGuard = null;
      toast('Certificate saved');
      navigate(`#/batches/${id}`);
    });
  };
  $('[name=name]', form).focus();
}

// ---------- Records: every certificate, with its confirmation page ----------
async function viewRecords(view) {
  const certs = await api('GET', '/api/certificates');
  const statusOf = (c) => c.status !== 'approved' ? badge(c.status) : c.revoked ? '<span class="badge rejected">revoked</span>' : '<span class="badge approved">issued</span>';
  view.innerHTML = `
    <div class="page-head"><div><h1>Records</h1>
      <p class="muted" style="margin:4px 0 0">Every certificate and the work it confirms. "Work report" opens the same PDF a QR scan shows.</p></div>
      <div class="actions"><input type="search" id="rec-q" placeholder="Search name, role, ID…" style="min-width:240px">
        ${can.approve() ? '<button class="btn" id="rec-site">Verification site</button>' : ''}</div></div>
    <div id="rec-list"></div>`;
  $('#rec-site', view)?.addEventListener('click', verificationSiteDialog);
  const draw = (q) => {
    const items = certs.filter((c) => !q || [c.name, c.organization, c.reason, c.id, ...c.work].join(' ').toLowerCase().includes(q));
    $('#rec-list', view).innerHTML = !items.length
      ? `<div class="empty"><h3>${certs.length ? 'No matches' : 'No certificates yet'}</h3></div>`
      : `<div class="table-wrap"><table>
        <thead><tr><th>Recipient</th><th>For</th><th>Work items</th><th>Issued</th><th>Status</th><th></th></tr></thead>
        <tbody>${items.map((c) => `
          <tr class="clickable" data-href="#/batches/${c.batch_id}">
            <td><b>${esc(c.name)}</b><div class="muted small"><code>${esc(c.id)}</code></div></td>
            <td class="muted">${esc(c.reason)}</td>
            <td>${c.work.length || '<span class="muted">–</span>'}</td>
            <td class="muted">${esc(c.issued || '')}</td>
            <td>${statusOf(c)}</td>
            <td class="end">${c.status === 'approved' ? `<a class="btn sm" href="/verify/${encodeURIComponent(c.id)}.pdf" target="_blank" rel="noopener">Work report</a> <a class="btn sm ghost" href="/verify/${encodeURIComponent(c.id)}" target="_blank" rel="noopener">Confirmation page</a>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>`;
    $$('[data-href]', view).forEach((tr) => tr.onclick = (e) => { if (!e.target.closest('a')) navigate(tr.dataset.href); });
  };
  $('#rec-q', view).oninput = (e) => draw(e.target.value.trim().toLowerCase());
  draw('');
}

// The verification site: a folder of plain pages and work reports, published for free on GitHub Pages,
// so QR codes work for anyone without Certify being online.
// The site updates itself: every approval or revoke pushes it to the GitHub repository behind the address.
function publishStatusText({ repo, publish: p }) {
  if (!repo) return 'Automatic updates need a GitHub Pages address. Until then, upload the site folder by hand after each approval.';
  const when = p.at ? ` (${new Date(p.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })})` : '';
  if (p.state === 'publishing') return 'Updating the site now…';
  if (p.state === 'error') return `<span style="color:var(--danger,#b42318)">The last update failed${when}: ${esc(p.error)}</span>`;
  if (p.state === 'ok') return `Up to date${when}. Changes appear on the site a minute or two after each approval.`;
  return 'The site updates automatically after each approval or revoke.';
}

async function verificationSiteDialog() {
  const settings = await api('GET', '/api/settings');
  const { site_url, fixed } = settings;
  modal({
    title: 'Verification site',
    body: `
      <p class="muted small" style="margin-top:0">QR codes open each intern's work report from this site, so anyone can scan them, even while this computer is off.</p>
      <p class="small" id="site-status">${publishStatusText(settings)}</p>
      <label class="field"><span>Site address</span>
        <input id="site-url" placeholder="https://your-username.github.io/certify-verify" value="${esc(site_url)}" ${fixed ? 'disabled' : ''}></label>
      ${fixed ? '<p class="muted small">Set by the PUBLIC_URL environment variable, which overrides this setting.</p>' : ''}
      <p class="muted small">Pushes use the GitHub login saved on this computer, which needs write access to <code>${esc(settings.repo || 'the repository')}</code>. Certificates downloaded before the address changed still point to the old one, so download them again.</p>`,
    actions: `<button class="btn" id="site-dl">${icons.download} Download site folder</button>
      ${settings.repo ? '<button class="btn" id="site-pub">Update now</button>' : ''}
      ${fixed ? '' : '<button class="btn primary" id="site-save">Save address</button>'}`,
    onMount: (el) => {
      const refresh = (s) => { $('#site-status', el).innerHTML = publishStatusText(s); };
      $('#site-dl', el).onclick = () => download('/api/site-export', 'verification-site.zip');
      $('#site-pub', el)?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
        $('#site-status', el).textContent = 'Updating the site now…';
        const p = await api('POST', '/api/site-publish');
        refresh({ repo: settings.repo, publish: p });
        if (p.state === 'ok') toast('Verification site updated', 'success');
      }));
      $('#site-save', el)?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
        const r = await api('PUT', '/api/settings', { site_url: $('#site-url', el).value });
        $('#site-url', el).value = r.site_url;
        toast(r.site_url ? 'Saved. New QR codes open ' + r.site_url : 'Cleared. QR codes use this computer again', 'success');
      }));
    },
  });
}
