/* Writing help for certificate wording: an offline checker plus the AI assistant. */

const MISSPELLINGS = {
  recieve: 'receive', recieved: 'received', acheive: 'achieve', acheived: 'achieved', acheivement: 'achievement',
  achievment: 'achievement', sucessfully: 'successfully', successfuly: 'successfully', succesfully: 'successfully',
  sucessful: 'successful', succesful: 'successful', completeing: 'completing', compleated: 'completed',
  particpation: 'participation', partcipation: 'participation', paticipation: 'participation', particpated: 'participated',
  certifcate: 'certificate', certificat: 'certificate', certficate: 'certificate', excelence: 'excellence',
  excellance: 'excellence', oustanding: 'outstanding', outstandig: 'outstanding', apreciation: 'appreciation',
  appriciation: 'appreciation', appreciaton: 'appreciation', dedicaiton: 'dedication', dedicaton: 'dedication',
  commitee: 'committee', comittee: 'committee', committment: 'commitment', commitement: 'commitment',
  recogntion: 'recognition', recognisation: 'recognition', occured: 'occurred', seperate: 'separate',
  accomodate: 'accommodate', untill: 'until', definately: 'definitely', persue: 'pursue', knowlege: 'knowledge',
  proffesional: 'professional', profesional: 'professional', contribtion: 'contribution', contibution: 'contribution',
  perfomance: 'performance', performace: 'performance', exellent: 'excellent', excelent: 'excellent',
  presnted: 'presented', presentd: 'presented', organisaton: 'organisation', organizaton: 'organization',
  sucess: 'success', succes: 'success', accomplishement: 'accomplishment', acomplishment: 'accomplishment',
  volunter: 'volunteer', gratitute: 'gratitude', greatful: 'grateful',
  sincerly: 'sincerely', truely: 'truly', begining: 'beginning', programm: 'programme', hardwork: 'hard work',
  wich: 'which', thier: 'their', alot: 'a lot', inspite: 'in spite', infront: 'in front',
};

const FIELD_LABEL = { title: 'Title', subtitle: 'Line above the name', body: 'Text below the name', orgName: 'Organisation name' };

const placeholdersIn = (text) => [...String(text || '').matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => normKey(m[1]));

// Returns [{ field, message, fix?: string }] — fix is the corrected full text for that field.
function localWritingCheck(w) {
  const issues = [];
  const add = (field, message, fix) => issues.push({ field, message, fix });
  for (const field of ['orgName', 'title', 'subtitle', 'body']) {
    const text = String(w[field] || '');
    if (!text.trim()) continue;

    const single = text.match(/(^|[^{])\{([a-zA-Z_ ]+)\}(?!\})/);
    if (single) add(field, `"{${single[2]}}" should use double braces: {{${single[2].trim()}}}`, text.replace(/(^|[^{])\{([a-zA-Z_ ]+)\}(?!\})/g, (_, pre, k) => `${pre}{{${k.trim()}}}`));
    if ((text.match(/\{\{/g) || []).length !== (text.match(/\}\}/g) || []).length) add(field, 'A placeholder is missing its opening {{ or closing }}');

    const rep = text.match(/\b(\w+)\s+\1\b/i);
    if (rep && !/^\d+$/.test(rep[1])) add(field, `Repeated word: "${rep[0]}"`, text.replace(/\b(\w+)\s+\1\b/gi, '$1'));
    if (/ {2,}/.test(text)) add(field, 'Extra spaces between words', text.replace(/ {2,}/g, ' '));
    if (/\s+[,.!?;:](?!\w)/.test(text)) add(field, 'Space before punctuation', text.replace(/\s+([,.!?;:])(?!\w)/g, '$1'));
    if (/[,;](?=[A-Za-z])/.test(text)) add(field, 'Missing space after a comma', text.replace(/([,;])(?=[A-Za-z])/g, '$1 '));
    if (/\bi\b/.test(text) && field !== 'orgName') add(field, 'Capitalise "I"', text.replace(/\bi\b/g, 'I'));

    for (const word of text.match(/[A-Za-z]+/g) || []) {
      const fix = MISSPELLINGS[word.toLowerCase()];
      if (fix) {
        const cased = word[0] === word[0].toUpperCase() ? fix[0].toUpperCase() + fix.slice(1) : fix;
        add(field, `Possible spelling mistake: "${word}" → "${cased}"`, text.replace(new RegExp(`\\b${word}\\b`, 'g'), cased));
      }
    }
  }
  const title = String(w.title || '').trim();
  if (title && /^[a-z]/.test(title)) add('title', 'Start the title with a capital letter', title[0].toUpperCase() + title.slice(1));
  const body = String(w.body || '').trim();
  if (body && !/[.!?)]$/.test(body)) add('body', 'End the text with a full stop', body + '.');
  if (body.length > 260) add('body', 'This text is long and may print in small type; aim for one or two sentences');
  if (/\b(jane doe|john doe)\b/i.test(body + w.subtitle)) add('body', 'The recipient name is printed separately; use {{name}} only if you need it again');
  return issues;
}

// ---------- AI ----------
let aiStatus = null;
async function getAiStatus() {
  if (!aiStatus) aiStatus = await api('GET', '/api/ai/status').catch(() => ({ enabled: false }));
  return aiStatus;
}

const AI_OFF_NOTE = `<div class="banner warn small"><div><b>The AI assistant isn't set up yet.</b> Ask whoever runs the server to add an
  <code>ANTHROPIC_API_KEY</code> (from console.anthropic.com) to its environment and restart it. The built-in writing check below still works without it.</div></div>`;

function lostPlaceholders(before, after) {
  const keep = new Set(placeholdersIn([after.title, after.subtitle, after.body].join(' ')));
  return [...new Set(placeholdersIn([before.title, before.subtitle, before.body].join(' ')))].filter((k) => !keep.has(k));
}

const wordingCard = (o, before) => {
  const lost = lostPlaceholders(before, o);
  return `<div class="ai-option">
    <div class="ai-t">${esc(o.title)}</div>
    <div class="ai-s">${esc(o.subtitle)}</div>
    <div class="ai-n">Recipient Name</div>
    <div class="ai-b">${esc(o.body).replace(/\{\{\s*([^}]+?)\s*\}\}/g, '<code>{{$1}}</code>')}</div>
    ${lost.length ? `<div class="small" style="color:var(--amber);margin-top:6px">Drops ${lost.map((k) => `<code>{{${esc(k)}}}</code>`).join(' ')}</div>` : ''}
  </div>`;
};

// "Write with AI": generate three wording options from a purpose, tone and details.
async function aiSuggestDialog({ wording, purpose, orgName, onApply }) {
  const status = await getAiStatus();
  modal({
    title: '✨ Write with AI',
    wide: true,
    body: `${status.enabled ? '' : AI_OFF_NOTE}
      <div class="row">
        <label class="field"><span>What is the certificate for?</span><input type="text" id="ai-purpose" value="${esc(purpose)}" placeholder="e.g. Completing a 3-day Python bootcamp"></label>
        <label class="field" style="max-width:200px"><span>Tone</span><select id="ai-tone">
          ${['Formal', 'Warm and friendly', 'Celebratory', 'Simple and clear', 'Inspirational'].map((t) => `<option>${t}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Any details to include? (optional)</span><textarea id="ai-details" rows="2" placeholder="e.g. Organised by the Computer Science department; mention the final project"></textarea></label>
      <label class="check"><input type="checkbox" id="ai-build" checked> Build on my current wording</label>
      <div id="ai-out"></div>`,
    actions: `<button class="btn" data-close>Close</button><button class="btn primary" id="ai-go" ${status.enabled ? '' : 'disabled'}>Generate options</button>`,
    onMount: (el, close) => {
      $('#ai-go', el).onclick = () => busy($('#ai-go', el), async () => {
        const out = $('#ai-out', el);
        out.innerHTML = '<p class="muted"><span class="spinner"></span> Writing options…</p>';
        try {
          const { options } = await api('POST', '/api/ai/suggest', {
            purpose: $('#ai-purpose', el).value, tone: $('#ai-tone', el).value, details: $('#ai-details', el).value,
            orgName, wording: $('#ai-build', el).checked ? wording : null,
          });
          out.innerHTML = `<div class="ai-options">${options.map((o, i) => `<div>${wordingCard(o, wording)}
            <button class="btn sm primary" data-use="${i}" style="margin-top:8px">Use this</button></div>`).join('')}</div>`;
          $$('[data-use]', out).forEach((b) => b.onclick = () => { onApply(options[Number(b.dataset.use)]); close(); toast('Wording applied', 'success'); });
          $('#ai-go', el).textContent = 'Try again';
        } catch (e) {
          out.innerHTML = `<div class="banner bad small">${esc(e.message)}</div>`;
        }
      });
    },
  });
}

// "Check with AI": proofread and offer fixes one by one or all at once.
async function aiCheckDialog({ wording, onApply }) {
  const status = await getAiStatus();
  if (!status.enabled) return modal({ title: 'Check grammar with AI', body: AI_OFF_NOTE, actions: '<button class="btn" data-close>OK</button>' });
  modal({
    title: 'Grammar & spelling check',
    wide: true,
    body: '<div id="ai-out"><p class="muted"><span class="spinner"></span> Proofreading your wording…</p></div>',
    actions: '<button class="btn" data-close>Close</button><button class="btn primary" id="ai-all" hidden>Apply all fixes</button>',
    onMount: async (el, close) => {
      const out = $('#ai-out', el);
      try {
        const { issues, corrected } = await api('POST', '/api/ai/check', { wording });
        if (!issues.length) {
          out.innerHTML = '<div class="banner good"><div>✓ No problems found. Your wording reads well.</div></div>';
          return;
        }
        let current = { ...wording };
        out.innerHTML = `<p class="muted small">${issues.length} suggestion${issues.length === 1 ? '' : 's'}:</p>
          <div class="issues">${issues.map((it, i) => `<div class="issue" data-i="${i}">
            <div class="small muted">${esc(FIELD_LABEL[it.field] || it.field)}</div>
            <div><del>${esc(it.original)}</del> → <ins>${esc(it.suggestion)}</ins></div>
            <div class="small muted">${esc(it.explanation)}</div>
            <button class="btn sm" data-fix="${i}">Apply</button></div>`).join('')}</div>`;
        $$('[data-fix]', out).forEach((b) => b.onclick = () => {
          const it = issues[Number(b.dataset.fix)];
          if (!current[it.field]?.includes(it.original)) return toast('That text has already changed', 'error');
          current = { ...current, [it.field]: current[it.field].replace(it.original, it.suggestion) };
          onApply(current);
          b.replaceWith(Object.assign(document.createElement('span'), { className: 'small', style: 'color:var(--green)', textContent: '✓ Applied' }));
        });
        const all = $('#ai-all', el);
        all.hidden = false;
        all.onclick = () => {
          const lost = lostPlaceholders(wording, corrected);
          onApply(lost.length ? current : corrected);
          close();
          toast('All fixes applied', 'success');
        };
      } catch (e) {
        out.innerHTML = `<div class="banner bad small">${esc(e.message)}</div>`;
      }
    },
  });
}

// Quick rewrites: shows before/after and lets the user accept.
async function aiRewriteDialog({ wording, instruction, label, onApply }) {
  const status = await getAiStatus();
  if (!status.enabled) return modal({ title: label, body: AI_OFF_NOTE, actions: '<button class="btn" data-close>OK</button>' });
  modal({
    title: label,
    wide: true,
    body: '<div id="ai-out"><p class="muted"><span class="spinner"></span> Rewriting…</p></div>',
    actions: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="ai-ok" disabled>Use new wording</button>',
    onMount: async (el, close) => {
      try {
        const result = await api('POST', '/api/ai/rewrite', { wording, instruction });
        $('#ai-out', el).innerHTML = `<div class="ai-options two-up"><div><h3>Before</h3>${wordingCard(wording, wording)}</div>
          <div><h3>After</h3>${wordingCard(result, wording)}</div></div>`;
        const ok = $('#ai-ok', el);
        ok.disabled = false;
        ok.onclick = () => { onApply(result); close(); toast('Wording updated', 'success'); };
      } catch (e) {
        $('#ai-out', el).innerHTML = `<div class="banner bad small">${esc(e.message)}</div>`;
      }
    },
  });
}

const REWRITES = [
  ['Make it more formal', 'Make it more formal and dignified.'],
  ['Make it shorter', 'Make it noticeably shorter and more concise.'],
  ['Make it warmer', 'Make it warmer and more personal, while staying professional.'],
  ['Make it more celebratory', 'Make it more celebratory and uplifting.'],
  ['Simplify the language', 'Use simpler, plain English that is easy for anyone to read.'],
];
