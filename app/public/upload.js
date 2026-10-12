/* Upload an image (stamp, seal, signature or logo) from the device — browse, drag & drop, paste or camera —
   with background removal, trimming, and a shared library of saved images for reuse. */

const ASSET_LABEL = { stamp: 'stamp or seal', signature: 'signature', logo: 'logo' };

function uploadImageDialog({ kind, title, onPick, removeWhite = true, trim = true, maxSize = 600, library = true }) {
  let file = null;
  let result = null;
  const opts = { removeWhite, trim, threshold: 205 };

  modal({
    title: title || `Add a ${ASSET_LABEL[kind]}`,
    wide: true,
    body: `
      <div class="upload-grid ${library ? '' : 'single'}">
        <div>
          <div class="drop big" id="up-drop" tabindex="0" role="button">
            ${icons.upload.replace('<svg', '<svg style="width:30px;height:30px"')}
            <b>Upload from your device</b>
            <span>Click to browse, drag a file here, or paste an image (Ctrl+V)</span>
            <span class="small">PNG, JPG, WebP, GIF or SVG. On a phone you can take a photo.</span>
          </div>
          <div id="up-edit" hidden>
            <div class="up-preview"><img id="up-img" alt="Preview"></div>
            <label class="check"><input type="checkbox" id="up-bg" ${opts.removeWhite ? 'checked' : ''}> Remove white / paper background</label>
            <label class="range" id="up-th-row"><span>Strength</span><input type="range" id="up-th" min="150" max="245" step="5" value="${opts.threshold}"><em></em></label>
            <label class="check"><input type="checkbox" id="up-trim" ${opts.trim ? 'checked' : ''}> Trim empty margins</label>
            ${library ? `
              <label class="field" style="margin-top:8px"><span>Name</span><input type="text" id="up-name" placeholder="e.g. Principal's office stamp"></label>
              <label class="check"><input type="checkbox" id="up-save" checked> Save to library so it can be reused in other templates</label>` : ''}
            <button type="button" class="btn sm" id="up-other">Choose a different file</button>
          </div>
        </div>
        ${library ? `<div><h3>Or reuse a saved ${ASSET_LABEL[kind]}</h3><div class="lib-grid" id="up-lib"><p class="muted small">Loading…</p></div></div>` : ''}
      </div>`,
    actions: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="up-ok" disabled>Use this image</button>`,
    onMount: (el, close) => {
      const drop = $('#up-drop', el);
      const edit = $('#up-edit', el);
      const ok = $('#up-ok', el);
      const thRow = $('#up-th-row', el);

      const process = async () => {
        if (!file) return;
        thRow.hidden = !opts.removeWhite;
        $('em', thRow).textContent = opts.removeWhite ? `${Math.round((opts.threshold - 150) / 0.95)}%` : '';
        try {
          result = await readImage(file, { maxSize, ...opts });
          $('#up-img', el).src = result;
          ok.disabled = false;
        } catch (e) {
          toast(e.message, 'error');
          showPicker();
        }
      };
      const useFile = (f) => {
        if (!f) return;
        file = f;
        drop.hidden = true;
        edit.hidden = false;
        const name = $('#up-name', el);
        if (name && !name.value) name.value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 60);
        process();
      };
      const showPicker = () => { file = null; result = null; drop.hidden = false; edit.hidden = true; ok.disabled = true; };

      drop.onclick = async () => useFile(await pickFile('image/*'));
      drop.onkeydown = async (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); useFile(await pickFile('image/*')); } };
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); useFile(e.dataTransfer.files[0]); };
      $('#up-other', el).onclick = showPicker;
      $('#up-bg', el).onchange = (e) => { opts.removeWhite = e.target.checked; process(); };
      $('#up-trim', el).onchange = (e) => { opts.trim = e.target.checked; process(); };
      let thTimer;
      $('#up-th', el).oninput = (e) => { opts.threshold = Number(e.target.value); clearTimeout(thTimer); thTimer = setTimeout(process, 120); };

      // Paste an image straight from the clipboard (e.g. a screenshot or a copied picture)
      const onPaste = (e) => {
        if (!el.isConnected) return document.removeEventListener('paste', onPaste, true);
        const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
        if (!item) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const blob = item.getAsFile();
        useFile(new File([blob], `pasted-${kind}.png`, { type: blob.type }));
      };
      document.addEventListener('paste', onPaste, true);

      ok.onclick = () => busy(ok, async () => {
        if (!result) return;
        if (library && $('#up-save', el)?.checked) {
          try { await api('POST', '/api/assets', { kind, name: $('#up-name', el).value, image: result }); } catch (e) { toast('Not saved to library: ' + e.message, 'error'); }
        }
        document.removeEventListener('paste', onPaste, true);
        onPick(result);
        close();
      });

      // Library of saved images
      if (library) {
        const drawLibrary = async () => {
          const lib = $('#up-lib', el);
          try {
            const items = await api('GET', `/api/assets?kind=${kind}`);
            lib.innerHTML = items.length ? items.map((a) => `
              <div class="lib-item" data-id="${a.id}" title="${esc(a.name)} · uploaded by ${esc(a.owner || 'someone')}">
                <div class="lib-img"><img src="${a.image}" alt=""></div><span>${esc(a.name)}</span>
                ${a.created_by === state.me.id || can.admin() ? `<button type="button" class="lib-del" data-del="${a.id}" title="Delete from library">${icons.x}</button>` : ''}
              </div>`).join('')
              : `<p class="muted small">Nothing saved yet. Images you upload here are saved for next time.</p>`;
            $$('.lib-item', lib).forEach((it) => it.onclick = (e) => {
              const del = e.target.closest('[data-del]');
              const asset = items.find((a) => a.id === Number(it.dataset.id));
              if (del) {
                e.stopPropagation();
                return confirmBox('Delete from library?', `Remove <b>${esc(asset.name)}</b> from the library? Templates already using it keep their copy.`, 'Delete', true)
                  .then((yes) => yes && api('DELETE', `/api/assets/${asset.id}`).then(drawLibrary).catch((err) => toast(err.message, 'error')));
              }
              document.removeEventListener('paste', onPaste, true);
              onPick(asset.image);
              close();
            });
          } catch (e) {
            lib.innerHTML = `<p class="muted small">${esc(e.message)}</p>`;
          }
        };
        drawLibrary();
      }
    },
  });
}
