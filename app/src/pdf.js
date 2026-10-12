const { PDFDocument, StandardFonts, rgb, degrees, setCharacterSpacing } = require('pdf-lib');
const QRCode = require('qrcode');
const { createStampDrawer } = require('./stamps');

const W = 842; // A4 landscape, points
const H = 595;
const RESERVED = ['id', 'issue_date'];

function defaultTemplateConfig() {
  return {
    style: 'classic',
    primaryColor: '#1f3a5f',
    accentColor: '#b8892b',
    orgName: 'Your Organization',
    title: 'Certificate of Completion',
    subtitle: 'This certificate is proudly presented to',
    body: 'for successfully completing the {{course}} programme on {{date}}.',
    logo: null,
    category: '',
    approverSignature: true,
    signatories: [], // fixed signatories: { name, title, image }
    showDate: true,
    showQR: true,
    stamps: [], // { type: 'seal'|'round'|'rect'|'image', text, subtext, center, image, color, position, size, rotation, opacity, dx, dy }
  };
}

const normKey = (k) => String(k).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function extractFields(config) {
  const keys = new Set(['name']);
  const stampText = (config.stamps || []).flatMap((st) => [st.text, st.subtext, st.center]);
  const signText = fixedSignatories(config).flatMap((s) => [s.name, s.title]);
  const text = [config.title, config.subtitle, config.body, config.orgName, ...stampText, ...signText].join(' ');
  for (const m of text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const k = normKey(m[1]);
    if (k && !RESERVED.includes(k)) keys.add(k);
  }
  return [...keys];
}

function fill(text, data) {
  return String(text || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k) => {
    const v = data[normKey(k)];
    return v == null ? '' : String(v);
  });
}

function hexToRgb(hex, shade = 1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0x333333;
  const ch = (v) => {
    const c = v / 255;
    return shade <= 1 ? c * shade : c + (1 - c) * (shade - 1); // <1 darkens, >1 lightens
  };
  return rgb(ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255));
}

// The fixed signatories, accepting the older single "secondSignatory" shape too.
function fixedSignatories(config) {
  if (Array.isArray(config.signatories)) return config.signatories.filter((s) => s && (s.name || s.image)).slice(0, 3);
  const s2 = config.secondSignatory;
  return s2?.enabled ? [s2] : [];
}

// Standard PDF fonts only cover Latin-1; replace anything else so rendering never fails.
const encodable = new WeakMap(); // font -> Map(char -> boolean)
const FALLBACK = { 'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'ı': 'i', 'Ħ': 'H', 'ħ': 'h', '‐': '-', '−': '-' };
function safe(font, text) {
  let known = encodable.get(font);
  if (!known) encodable.set(font, (known = new Map()));
  const ok = (ch) => {
    if (!known.has(ch)) {
      try { font.encodeText(ch); known.set(ch, true); } catch { known.set(ch, false); }
    }
    return known.get(ch);
  };
  return [...String(text || '').normalize('NFC')]
    .map((ch) => {
      if (ok(ch)) return ch;
      if (FALLBACK[ch]) return FALLBACK[ch];
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, ''); // e.g. ł → l fallback
      return base && base !== ch && [...base].every(ok) ? base : '?';
    })
    .join('');
}

function wrap(font, text, size, maxWidth) {
  const lines = [];
  for (const para of text.split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(test, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

class Painter {
  constructor(page, fonts) {
    this.page = page;
    this.fonts = fonts;
  }
  text(str, { x, y, font, size, color, spacing = 0, align = 'center', maxWidth }) {
    str = safe(font, str);
    const width = () => font.widthOfTextAtSize(str, size) + spacing * Math.max(0, str.length - 1);
    if (maxWidth) while (size > 8 && width() > maxWidth) size -= 1;
    const w = width();
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    if (spacing) this.page.pushOperators(setCharacterSpacing(spacing));
    this.page.drawText(str, { x: left, y, font, size, color });
    if (spacing) this.page.pushOperators(setCharacterSpacing(0));
    return size;
  }
}

async function embedImage(doc, cache, dataUrl) {
  if (!dataUrl) return null;
  if (cache.has(dataUrl)) return cache.get(dataUrl);
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUrl);
  let img = null;
  if (m) {
    const bytes = Buffer.from(m[2], 'base64');
    try {
      img = m[1].toLowerCase() === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    } catch { img = null; }
  }
  cache.set(dataUrl, img);
  return img;
}

function drawFrame(page, style, P, A) {
  const rect = (inset, thickness, color) =>
    page.drawRectangle({ x: inset, y: inset, width: W - inset * 2, height: H - inset * 2, borderColor: color, borderWidth: thickness });

  if (style === 'classic') {
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 0.992, 0.965) });
    rect(18, 8, P);
    rect(32, 1.5, A);
    for (const [x, y] of [[32, 32], [W - 32, 32], [32, H - 32], [W - 32, H - 32]]) {
      page.drawRectangle({ x: x - 7, y: y - 7, width: 14, height: 14, color: A });
      page.drawRectangle({ x: x - 3.5, y: y - 3.5, width: 7, height: 7, color: rgb(1, 0.992, 0.965) });
    }
  } else if (style === 'elegant') {
    rect(22, 1, P);
    rect(28, 3, A);
    rect(36, 0.6, P);
    const L = 46;
    for (const [x, y, dx, dy] of [[44, 44, 1, 1], [W - 44, 44, -1, 1], [44, H - 44, 1, -1], [W - 44, H - 44, -1, -1]]) {
      page.drawLine({ start: { x, y }, end: { x: x + L * dx, y }, thickness: 2.5, color: P });
      page.drawLine({ start: { x, y }, end: { x, y: y + L * dy }, thickness: 2.5, color: P });
    }
  } else if (style === 'modern') {
    page.drawRectangle({ x: 0, y: 0, width: 64, height: H, color: P });
    page.drawRectangle({ x: 64, y: 0, width: 8, height: H, color: A });
    page.drawSvgPath(`M ${W - 230} 0 L ${W} 0 L ${W} 230 Z`, { x: 0, y: H, color: P, opacity: 0.08 });
    page.drawSvgPath(`M ${W - 120} 0 L ${W} 0 L ${W} 120 Z`, { x: 0, y: H, color: A, opacity: 0.9 });
    page.drawSvgPath(`M 72 ${H - 150} L 72 ${H} L 222 ${H} Z`, { x: 0, y: H, color: P, opacity: 0.06 });
  } else {
    page.drawRectangle({ x: 0, y: H - 12, width: W, height: 12, color: P });
    page.drawRectangle({ x: 0, y: H - 16, width: W, height: 4, color: A });
    page.drawRectangle({ x: 0, y: 0, width: W, height: 6, color: P });
  }
}

// Draws paragraphs (separated by blank lines) fully justified, like a typeset letter.
// Returns the baseline below the last line.
function justifiedText(page, font, text, { x, y, width, size, lineHeight, paraGap, spacing, color }) {
  const measure = (w) => font.widthOfTextAtSize(w, size) + spacing * w.length;
  const space = font.widthOfTextAtSize(' ', size) + spacing;
  page.pushOperators(setCharacterSpacing(spacing));
  for (const para of text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    const lines = [[]];
    for (const word of para.split(/\s+/)) {
      const line = lines[lines.length - 1];
      const len = [...line, word].reduce((n, w) => n + measure(w), 0) + space * line.length;
      if (line.length && len > width) lines.push([word]);
      else line.push(word);
    }
    lines.forEach((words, i) => {
      const used = words.reduce((n, w) => n + measure(w), 0);
      const gap = i < lines.length - 1 && words.length > 1 ? (width - used) / (words.length - 1) : space;
      let wx = x;
      for (const w of words) {
        page.drawText(w, { x: wx, y, size, font, color });
        wx += measure(w) + gap;
      }
      y -= lineHeight;
    });
    y -= paraGap;
  }
  page.pushOperators(setCharacterSpacing(0));
  return y;
}

// Ayritech's own A4 portrait certificate, recreating the company's printed design.
// Artwork coordinates are in the units of the original 924×1308 design, scaled to the page.
async function drawAyritechCertificate(doc, cache, fonts, config, data, ctx) {
  const PW = 595.5, PH = 842.25, k = PW / 924;
  const page = doc.addPage([PW, PH]);
  const p = new Painter(page, fonts);
  const fullData = { ...data, id: ctx.certId, issue_date: ctx.issueDate };
  const dark = hexToRgb(config.primaryColor || '#3a3536');
  const orange = hexToRgb(config.accentColor || '#f5873a');
  const ink = rgb(0.2, 0.2, 0.22);
  const art = (d, opts) => page.drawSvgPath(d, { x: 0, y: PH, scale: k, ...opts });

  // Corner artwork: dark and orange triangles with fine diagonal lines.
  for (let i = 0; i < 7; i++) {
    const x0 = 596 + i * 11;
    art(`M ${x0} 0 L ${x0 + 155 + i * 4} ${178 + i * 5}`, { borderColor: rgb(0.93, 0.42, 0.38), borderWidth: 1.4 });
  }
  art('M 680 0 L 924 0 L 924 55 L 820 160 Z', { color: dark });
  art('M 748 232 L 924 55 L 924 410 Z', { color: orange });
  art('M 0 1082 L 226 1308 L 0 1308 Z', { color: dark });
  for (let d = 34; d < 200; d += 22) art(`M 0 ${1082 + d} L ${226 - d} 1308`, { borderColor: rgb(1, 1, 1), borderWidth: 1.6 });
  art('M 100 1308 L 220 1188 L 340 1308 Z', { color: orange });
  art('M 128 1308 L 220 1216 L 312 1308 Z', { color: hexToRgb(config.accentColor || '#f5873a', 1.25) });

  // Logo and wordmark, top left.
  const logo = await embedImage(doc, cache, config.logo);
  if (logo) {
    const s = Math.min(72 / logo.width, 68 / logo.height);
    page.drawImage(logo, { x: 52, y: PH - 20 - logo.height * s, width: logo.width * s, height: logo.height * s });
  }
  if (config.wordmark) p.text(config.wordmark, { x: 50, y: PH - 118, font: fonts.helvBold, size: 14.5, color: rgb(0.1, 0.1, 0.12), align: 'left' });

  // Title: letter-spaced to the width of the original design.
  const spread = (str, font, size, width, y) => {
    str = safe(font, str);
    const spacing = Math.max(0, (width - font.widthOfTextAtSize(str, size)) / Math.max(1, str.length - 1));
    p.text(str, { x: PW / 2, y, font, size, color: dark, spacing: Math.min(spacing, size * 0.35) });
  };
  spread(fill(config.title, fullData).toUpperCase(), fonts.times, 42, 308, PH - 208);
  if (config.subtitle) spread(fill(config.subtitle, fullData).toUpperCase(), fonts.times, 13.5, 154, PH - 236);

  const body = fill(config.body, fullData).split(/\n\s*\n/).map((para) => safe(fonts.times, para.replace(/\s+/g, ' '))).join('\n\n');
  justifiedText(page, fonts.times, body, {
    x: 62.5, y: PH - 303, width: 483, size: 13.4, lineHeight: 20, paraGap: 20.5, spacing: 1.9, color: ink,
  });

  // Verification QR, bottom centre.
  if (config.showQR && ctx.verifyUrl) {
    const png = await QRCode.toBuffer(ctx.verifyUrl, { margin: 0, width: 300, errorCorrectionLevel: 'M' });
    page.drawImage(await doc.embedPng(png), { x: 261, y: 113, width: 74, height: 74 });
  }
  p.text(`Certificate ID: ${ctx.certId}`, { x: 298, y: 101, font: fonts.helv, size: 6.5, color: rgb(0.45, 0.45, 0.48) });

  // Seal & signature with the signatory's name and designation, bottom right.
  const signer = fixedSignatories(config)[0];
  if (signer) {
    const img = await embedImage(doc, cache, signer.image);
    if (img) {
      const s = Math.min(220 / img.width, 101 / img.height);
      page.drawImage(img, { x: 356, y: 103, width: img.width * s, height: img.height * s });
    }
    p.text(fill(signer.name, fullData), { x: 464, y: 94, font: fonts.times, size: 11.5, color: rgb(0.1, 0.1, 0.12), maxWidth: 200 });
    p.text(fill(signer.title, fullData), { x: 464, y: 80, font: fonts.times, size: 11.5, color: rgb(0.1, 0.1, 0.12), maxWidth: 200 });
  }

  if (ctx.watermark) {
    const size = 90;
    const w = fonts.helvBold.widthOfTextAtSize(ctx.watermark, size);
    const a = Math.PI / 4;
    page.drawText(ctx.watermark, {
      x: PW / 2 - (w / 2) * Math.cos(a) + 25, y: PH / 2 - (w / 2) * Math.sin(a) - 25,
      size, font: fonts.helvBold, color: rgb(0.85, 0.2, 0.2), opacity: 0.12, rotate: degrees(45),
    });
  }
}

async function drawCertificate(doc, cache, fonts, config, data, ctx) {
  if (config.style === 'ayritech') return drawAyritechCertificate(doc, cache, fonts, config, data, ctx);
  const page = doc.addPage([W, H]);
  const p = new Painter(page, fonts);
  const style = config.style || 'classic';
  const P = hexToRgb(config.primaryColor);
  const A = hexToRgb(config.accentColor);
  const grey = rgb(0.35, 0.35, 0.38);
  const serif = style === 'classic' || style === 'elegant';
  const F = serif
    ? { title: fonts.timesBold, sub: fonts.timesItalic, name: fonts.timesBoldItalic, body: fonts.times, bold: fonts.timesBold }
    : { title: fonts.helvBold, sub: fonts.helvOblique, name: fonts.helvBold, body: fonts.helv, bold: fonts.helvBold };
  if (style === 'elegant') { F.title = fonts.times; F.name = fonts.timesItalic; }

  drawFrame(page, style, P, A);
  const cx = style === 'modern' ? 72 + (W - 72) / 2 : W / 2;
  const fullData = { ...data, id: ctx.certId, issue_date: ctx.issueDate };
  const logo = await embedImage(doc, cache, config.logo);
  const bodyLines = wrap(F.body, safe(F.body, fill(config.body, fullData)), 15, 580).slice(0, 4);

  // Lay the main content out twice: once to measure its height, then to draw it
  // vertically centred in the space above the signature row.
  const layout = (y, draw) => {
    if (logo) {
      const s = Math.min(150 / logo.width, 60 / logo.height);
      const w = logo.width * s, h = logo.height * s;
      if (draw) page.drawImage(logo, { x: cx - w / 2, y: y - h, width: w, height: h });
      y -= h + 26;
    } else y -= 12;

    if (config.orgName) {
      if (draw) p.text(fill(config.orgName, fullData).toUpperCase(), { x: cx, y, font: F.bold, size: 12.5, color: P, spacing: 2.5, maxWidth: 600 });
      y -= 52;
    } else y -= 30;

    const title = fill(config.title, fullData);
    if (draw) p.text(style === 'elegant' || style === 'modern' ? title.toUpperCase() : title, {
      x: cx, y, font: F.title, size: style === 'elegant' ? 34 : 40, color: P,
      spacing: style === 'elegant' ? 3 : style === 'modern' ? 1.5 : 0, maxWidth: 640,
    });
    y -= 20;
    if (draw && style !== 'minimal') page.drawLine({ start: { x: cx - 50, y }, end: { x: cx + 50, y }, thickness: 1.5, color: A });
    y -= 40;

    if (config.subtitle) {
      if (draw) p.text(fill(config.subtitle, fullData), { x: cx, y, font: F.sub, size: 14, color: grey, maxWidth: 600 });
      y -= 58;
    } else y -= 26;

    if (draw) p.text(data.name || '', { x: cx, y, font: F.name, size: 46, color: style === 'classic' ? A : P, maxWidth: 580 });
    y -= 16;
    if (draw) page.drawLine({ start: { x: cx - 210, y }, end: { x: cx + 210, y }, thickness: 0.8, color: grey });
    y -= 34;

    for (const line of bodyLines) {
      if (draw) p.text(line, { x: cx, y, font: F.body, size: 15, color: rgb(0.2, 0.2, 0.22) });
      y -= 22;
    }
    return y + 22;
  };
  const top = H - 58, bottom = 200;
  const height = top - layout(top, false);
  layout(top - Math.max(0, (top - bottom - height) / 2), true);

  // Bottom row: approver, fixed signatories and the issue date share evenly spaced slots.
  const sigY = 136;
  const ink = rgb(0.15, 0.15, 0.18);
  const slots = [];
  if (config.approverSignature) {
    slots.push(ctx.approver
      ? { name: ctx.approver.name, title: ctx.approver.title, image: ctx.approver.signature }
      : { name: 'Approver', title: 'Awaiting approval', pending: true });
  }
  for (const s of fixedSignatories(config)) slots.push({ name: fill(s.name, fullData), title: fill(s.title, fullData), image: s.image });
  if (config.showDate !== false) slots.push({ date: true });
  const layouts = { 1: [[0], 95], 2: [[-235, 235], 95], 3: [[-250, 0, 250], 85], 4: [[-285, -95, 95, 285], 75] };
  const [offsets, half] = layouts[Math.min(slots.length, 4)] || [[], 95];
  const slotX = offsets.map((o) => cx + o);
  for (let i = 0; i < slotX.length; i++) {
    const s = slots[i];
    const sx = slotX[i];
    if (s.date) {
      p.text(ctx.issueDate, { x: sx, y: sigY + 6, font: F.body, size: 12, color: ink, maxWidth: half * 2 });
    } else {
      const img = await embedImage(doc, cache, s.image);
      if (img) {
        const sc = Math.min((half * 2 - 20) / img.width, 48 / img.height);
        page.drawImage(img, { x: sx - (img.width * sc) / 2, y: sigY + 4, width: img.width * sc, height: img.height * sc });
      } else if (s.pending) {
        p.text('signature pending', { x: sx, y: sigY + 10, font: fonts.helvOblique, size: 9, color: rgb(0.7, 0.7, 0.72) });
      }
    }
    page.drawLine({ start: { x: sx - half, y: sigY }, end: { x: sx + half, y: sigY }, thickness: 0.8, color: grey });
    p.text(s.date ? 'Date of Issue' : s.name || '', { x: sx, y: sigY - 16, font: F.bold, size: 11, color: ink, maxWidth: half * 2 + 10 });
    if (!s.date) p.text(s.title || '', { x: sx, y: sigY - 30, font: F.body, size: 9.5, color: grey, maxWidth: half * 2 + 10 });
  }

  // Verification QR + ID
  if (config.showQR && ctx.verifyUrl) {
    const png = await QRCode.toBuffer(ctx.verifyUrl, { margin: 0, width: 200, errorCorrectionLevel: 'M' });
    const qr = await doc.embedPng(png);
    page.drawImage(qr, { x: cx - 25, y: 48, width: 50, height: 50 });
    p.text(`Certificate ID: ${ctx.certId}`, { x: cx, y: 38, font: fonts.helv, size: 7, color: grey });
  } else {
    p.text(`Certificate ID: ${ctx.certId}`, { x: cx, y: 50, font: fonts.helv, size: 7.5, color: grey });
  }

  const drawStamps = createStampDrawer({
    page, fonts, safe, hexToRgb, W, H,
    embedImage: (src) => embedImage(doc, cache, src),
  });
  await drawStamps(config.stamps, (t) => fill(t, fullData), { cx, slotX, sigY, style });

  if (ctx.watermark) {
    const size = 110;
    const w = fonts.helvBold.widthOfTextAtSize(ctx.watermark, size);
    page.drawText(ctx.watermark, {
      x: W / 2 - (w / 2) * Math.cos(Math.PI / 9) + 20, y: H / 2 - (w / 2) * Math.sin(Math.PI / 9) - 20,
      size, font: fonts.helvBold, color: rgb(0.85, 0.2, 0.2), opacity: 0.13, rotate: degrees(20),
    });
  }
}

async function buildPdf(items) {
  const doc = await PDFDocument.create();
  const fonts = {
    times: await doc.embedFont(StandardFonts.TimesRoman),
    timesBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    timesItalic: await doc.embedFont(StandardFonts.TimesRomanItalic),
    timesBoldItalic: await doc.embedFont(StandardFonts.TimesRomanBoldItalic),
    helv: await doc.embedFont(StandardFonts.Helvetica),
    helvBold: await doc.embedFont(StandardFonts.HelveticaBold),
    helvOblique: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
  const cache = new Map();
  for (const it of items) await drawCertificate(doc, cache, fonts, it.config, it.data, it.ctx);
  doc.setTitle(items.length === 1 ? `Certificate ${items[0].ctx.certId}` : 'Certificates');
  doc.setProducer('Certify');
  return doc.save();
}

module.exports = { defaultTemplateConfig, extractFields, normKey, fill, fixedSignatories, buildPdf, embedImage, safe, wrap, hexToRgb };
