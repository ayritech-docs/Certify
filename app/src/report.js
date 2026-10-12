/* The work report: a per-certificate PDF, opened by the certificate's QR code, that describes in detail
   the work the intern did, so anyone checking the certificate can see exactly what it stands for. */

const { PDFDocument, StandardFonts, rgb, degrees, setCharacterSpacing } = require('pdf-lib');
const { embedImage, safe, wrap, fill, fixedSignatories, hexToRgb } = require('./pdf');

const PW = 595.5, PH = 842.25;
const L = 56, R = PW - 56, BOTTOM = 78;

// Lines of a list field, without any bullet characters people typed themselves.
const listItems = (s) => String(s || '').split(/\n/).map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
const paragraphs = (s) => String(s || '').split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);

async function buildReport({ config, data, ctx }) {
  const doc = await PDFDocument.create();
  const f = {
    times: await doc.embedFont(StandardFonts.TimesRoman),
    timesBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    timesItalic: await doc.embedFont(StandardFonts.TimesRomanItalic),
    helv: await doc.embedFont(StandardFonts.Helvetica),
    helvBold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const cache = new Map();
  const dark = hexToRgb(config.primaryColor || '#3a3536');
  const orange = hexToRgb(config.accentColor || '#f5873a');
  const ink = rgb(0.16, 0.16, 0.19);
  const grey = rgb(0.42, 0.42, 0.46);
  const full = { ...data, id: ctx.certId, issue_date: ctx.issueDate };
  const org = fill(config.orgName, full);
  const certTitle = fill(config.displayTitle || config.title, full);
  const logo = await embedImage(doc, cache, config.logo);
  let page, y;

  const text = (str, { x, font, size, color = ink, spacing = 0, align = 'left' }) => {
    str = safe(font, str);
    const w = font.widthOfTextAtSize(str, size) + spacing * Math.max(0, str.length - 1);
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    if (spacing) page.pushOperators(setCharacterSpacing(spacing));
    page.drawText(str, { x: left, y, size, font, color });
    if (spacing) page.pushOperators(setCharacterSpacing(0));
  };

  // Letterhead on every page: logo, wordmark, organisation and the corner artwork of the certificate.
  const newPage = () => {
    page = doc.addPage([PW, PH]);
    page.drawSvgPath('M 505 0 L 595.5 0 L 595.5 22 L 553 64 Z', { x: 0, y: PH, color: dark });
    page.drawSvgPath('M 548 70 L 595.5 22 L 595.5 118 Z', { x: 0, y: PH, color: orange });
    let x = L;
    if (logo) {
      const s = Math.min(46 / logo.width, 44 / logo.height);
      page.drawImage(logo, { x, y: PH - 40 - logo.height * s, width: logo.width * s, height: logo.height * s });
      x += logo.width * s + 12;
    }
    y = PH - 62;
    if (config.wordmark) text(config.wordmark, { x, font: f.helvBold, size: 16, color: rgb(0.1, 0.1, 0.12) });
    y = PH - 77;
    text(org, { x, font: f.helv, size: 9, color: grey });
    page.drawLine({ start: { x: L, y: PH - 98 }, end: { x: 420, y: PH - 98 }, thickness: 2, color: orange });
    y = PH - 130;
  };
  const ensure = (h) => { if (y - h < BOTTOM) newPage(); };

  const para = (str, { font = f.times, size = 11.5, color = ink, indent = 0, after = 8 } = {}) => {
    const lh = size * 1.45;
    for (const p of paragraphs(str)) {
      for (const line of wrap(font, safe(font, p), size, R - L - indent)) {
        ensure(lh);
        text(line, { x: L + indent, font, size, color });
        y -= lh;
      }
      y -= after;
    }
  };
  const heading = (str) => {
    ensure(48);
    y -= 6;
    text(str.toUpperCase(), { x: L, font: f.helvBold, size: 9.5, color: orange, spacing: 1.2 });
    y -= 18;
  };
  const bullets = (items) => {
    const size = 11.5, lh = size * 1.45;
    for (const item of items) {
      wrap(f.times, safe(f.times, item), size, R - L - 16).forEach((line, i) => {
        ensure(lh);
        if (i === 0) text('•', { x: L + 2, font: f.times, size, color: orange });
        text(line, { x: L + 16, font: f.times, size });
        y -= lh;
      });
      y -= 3;
    }
    y -= 6;
  };

  newPage();

  // Title
  text(fill(config.reportTitle || 'Internship Work Report', full).toUpperCase(), { x: PW / 2, font: f.times, size: 22, color: dark, spacing: 3, align: 'center' });
  y -= 20;
  text(`Supporting document to the ${certTitle} · ID ${ctx.certId}`, { x: PW / 2, font: f.timesItalic, size: 11, color: grey, align: 'center' });
  y -= 34;

  // Key details
  const period = data.start_date && data.end_date ? `${data.start_date} – ${data.end_date}` : data.start_date || data.end_date || '';
  const rows = [
    ['Intern', data.name],
    ['Role', data.role],
    ['Internship period', period],
    ['Project / team', data.project],
    ['Date of issue', ctx.issueDate],
    ['Certificate ID', ctx.certId],
  ].filter(([, v]) => v);
  const boxTop = y + 14;
  for (const [label, value] of rows) {
    const lines = wrap(f.timesBold, safe(f.timesBold, value), 11.5, R - L - 150);
    text(label, { x: L + 14, font: f.helv, size: 9, color: grey });
    lines.forEach((line, i) => { if (i) y -= 15; text(line, { x: L + 140, font: f.timesBold, size: 11.5 }); });
    y -= 20;
  }
  page.drawRectangle({ x: L, y: y + 6, width: R - L, height: boxTop - y - 6, borderColor: rgb(0.88, 0.86, 0.82), borderWidth: 1 });
  page.drawRectangle({ x: L, y: y + 6, width: 3, height: boxTop - y - 6, color: orange });
  y -= 18;

  // The work itself
  const sections = [
    ['Summary of work', data.summary, para],
    ['Key tasks and contributions', listItems(data.work), bullets],
    ['Skills and tools', data.skills, para],
    ['Performance and remarks', data.remarks, para],
  ].filter(([, v]) => (Array.isArray(v) ? v.length : String(v || '').trim()));
  if (!sections.length) para('No further details of the work were recorded for this certificate.', { font: f.timesItalic, color: grey });
  for (const [title, value, draw] of sections) {
    heading(title);
    draw(value);
  }

  // Confirmation and sign-off, kept together on one page
  ensure(240);
  heading('Confirmation');
  para(`This report accompanies the ${certTitle} (ID ${ctx.certId}) issued by ${org} to ${data.name || 'the intern'} on ${ctx.issueDate}. ${org} confirms that the work described above was carried out during the internship.`);

  const signer = fixedSignatories(config)[0];
  if (signer) {
    ensure(130);
    const img = await embedImage(doc, cache, signer.image);
    const cx = R - 95;
    y -= 6;
    if (img) {
      const s = Math.min(200 / img.width, 88 / img.height);
      const w = img.width * s, h = img.height * s;
      page.drawImage(img, { x: cx - w * 0.35, y: y - h, width: w, height: h });
      y -= h + 4;
    } else y -= 50;
    page.drawLine({ start: { x: cx - 90, y }, end: { x: cx + 90, y }, thickness: 0.8, color: grey });
    y -= 15;
    text(fill(signer.name, full), { x: cx, font: f.timesBold, size: 11.5, align: 'center' });
    y -= 14;
    text(fill(signer.title, full), { x: cx, font: f.times, size: 10.5, color: grey, align: 'center' });
  }

  // Footer and watermark on every page
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    page = pg;
    pg.drawLine({ start: { x: L, y: 52 }, end: { x: R, y: 52 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.87) });
    y = 38;
    if (ctx.pageUrl) text(`Check this certificate online: ${ctx.pageUrl}`, { x: L, font: f.helv, size: 7.5, color: grey });
    text(`Page ${i + 1} of ${pages.length}`, { x: R, font: f.helv, size: 7.5, color: grey, align: 'right' });
    if (ctx.watermark) {
      // Shrink longer watermarks so they still fit across the page diagonal
      const size = Math.min(90, (0.8 * Math.hypot(PW, PH)) / f.helvBold.widthOfTextAtSize(ctx.watermark, 1));
      const w = f.helvBold.widthOfTextAtSize(ctx.watermark, size), a = Math.PI / 4;
      pg.drawText(ctx.watermark, {
        x: PW / 2 - (w / 2) * Math.cos(a) + 25, y: PH / 2 - (w / 2) * Math.sin(a) - 25,
        size, font: f.helvBold, color: rgb(0.85, 0.2, 0.2), opacity: 0.12, rotate: degrees(45),
      });
    }
  });

  doc.setTitle(`${data.name || 'Intern'} – Work report ${ctx.certId}`);
  doc.setAuthor(org);
  doc.setProducer('Certify');
  return doc.save();
}

module.exports = { buildReport };
