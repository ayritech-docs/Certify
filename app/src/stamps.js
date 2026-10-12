// Stamps, seals and badges drawn on top of a certificate page.
const { rgb, degrees } = require('pdf-lib');

const rad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
const rot = (vx, vy, deg) => {
  const a = rad(deg);
  return [vx * Math.cos(a) - vy * Math.sin(a), vx * Math.sin(a) + vy * Math.cos(a)];
};

const POSITIONS = ['bottom-left', 'bottom-center', 'bottom-right', 'top-left', 'top-right', 'middle-left', 'middle-right', 'signature-1', 'signature-2', 'signature-3'];

function anchor(position, { W, H, cx, slotX, sigY, style }) {
  const L = style === 'modern' ? 135 : 108;
  const R = W - 108;
  const sig = /^signature-(\d)$/.exec(position || '');
  if (sig) {
    const x = slotX[Number(sig[1]) - 1];
    if (x != null) return [x - 48, sigY + 14];
  }
  // "Bottom centre" sits between signatures; when a slot already occupies the centre, use the gap left of it.
  let centre = [cx, sigY + 34];
  if (slotX.length === 1) centre = [cx + 210, sigY + 20];
  else if (slotX.length % 2 === 1) centre = [(slotX[0] + slotX[1]) / 2, sigY + 28];
  return {
    'bottom-left': [L, 108], 'bottom-right': [R, 108], 'bottom-center': centre,
    'top-left': [L, H - 108], 'top-right': [R, H - 108],
    'middle-left': [L, H / 2], 'middle-right': [R, H / 2],
  }[position] || [R, 108];
}

function createStampDrawer({ page, fonts, safe, hexToRgb, embedImage, W, H }) {
  const polygon = (pts, opts) =>
    page.drawSvgPath(`M ${pts.map(([x, y]) => `${x} ${H - y}`).join(' L ')} Z`, { x: 0, y: H, ...opts });

  const fitSize = (font, str, maxWidth, maxSize) => {
    const w = font.widthOfTextAtSize(safe(font, str) || ' ', 1);
    return Math.max(4, Math.min(maxSize, maxWidth / w));
  };

  // Text centred on (x, y), rotated by deg around that point.
  const centredText = (str, { x, y, font, size, color, deg = 0, opacity = 1 }) => {
    str = safe(font, str);
    const w = font.widthOfTextAtSize(str, size);
    const [ox, oy] = rot(-w / 2, -size * 0.35, deg);
    page.drawText(str, { x: x + ox, y: y + oy, size, font, color, opacity, rotate: degrees(deg) });
  };

  // Text along a circle: the top arc reads left-to-right over the top, the bottom arc under the bottom.
  const arcText = (str, { x, y, radius, font, size, color, deg = 0, opacity = 1, bottom = false }) => {
    const chars = [...safe(font, str)];
    if (!chars.length) return;
    const gap = size * 0.12;
    const widths = chars.map((ch) => font.widthOfTextAtSize(ch, size));
    const total = widths.reduce((a, b) => a + b + gap, -gap);
    const R = bottom ? radius + size * 0.36 : radius - size * 0.36;
    let acc = 0;
    chars.forEach((ch, i) => {
      const along = acc + widths[i] / 2 - total / 2;
      acc += widths[i] + gap;
      const a = (bottom ? 270 + toDeg(along / R) : 90 - toDeg(along / R)) + deg;
      const rotation = bottom ? a + 90 : a - 90;
      const [ox, oy] = rot(-widths[i] / 2, 0, rotation);
      page.drawText(ch, {
        x: x + R * Math.cos(rad(a)) + ox, y: y + R * Math.sin(rad(a)) + oy,
        size, font, color, opacity, rotate: degrees(rotation),
      });
    });
  };

  const seal = ({ x, y, r, deg, opacity, hex, text, sub }) => {
    const color = hexToRgb(hex);
    const dark = hexToRgb(hex, 0.72);
    const light = hexToRgb(hex, 1.75);
    for (const s of [-1, 1]) { // ribbon tails
      const pts = [[0.08, -0.2], [0.56, -0.2], [0.74, -1.2], [0.5, -1.0], [0.3, -1.26]]
        .map(([px, py]) => rot(s * px * r, py * r, deg))
        .map(([px, py]) => [x + px, y + py]);
      polygon(pts, { color: dark, opacity });
    }
    const n = 36;
    const burst = Array.from({ length: n * 2 }, (_, i) => {
      const a = rad((i * 180) / n + deg);
      const rr = i % 2 ? r * 0.9 : r;
      return [x + rr * Math.cos(a), y + rr * Math.sin(a)];
    });
    polygon(burst, { color, opacity });
    page.drawCircle({ x, y, size: r * 0.8, color: dark, opacity });
    page.drawCircle({ x, y, size: r * 0.72, borderColor: light, borderWidth: Math.max(0.6, r * 0.025), borderOpacity: opacity });
    if (text) {
      const t = text.toUpperCase();
      centredText(t, { x, y: sub ? y + r * 0.1 : y, font: fonts.timesBold, size: fitSize(fonts.timesBold, t, r * 1.15, r * 0.32), color: rgb(1, 1, 1), deg, opacity });
    }
    if (sub) {
      const t = sub.toUpperCase();
      const [sx, sy] = rot(0, -r * 0.3, deg);
      centredText(t, { x: x + sx, y: y + sy, font: fonts.helvBold, size: fitSize(fonts.helvBold, t, r * 0.95, r * 0.16), color: light, deg, opacity });
    }
  };

  const round = ({ x, y, r, deg, opacity, hex, text, sub, center }) => {
    const color = hexToRgb(hex);
    const bw = Math.max(1.2, r * 0.05);
    const inner = r * 0.56;
    page.drawCircle({ x, y, size: r, borderColor: color, borderWidth: bw, borderOpacity: opacity });
    page.drawCircle({ x, y, size: r - bw * 2.2, borderColor: color, borderWidth: bw * 0.4, borderOpacity: opacity });
    page.drawCircle({ x, y, size: inner, borderColor: color, borderWidth: bw * 0.4, borderOpacity: opacity });
    const ringMid = (r - bw * 2.2 + inner) / 2;
    const ringSize = Math.min(r * 0.2, (r - bw * 2.2 - inner) * 0.7);
    const f = fonts.helvBold;
    const arcSize = (str, maxDeg) => fitSize(f, str, rad(maxDeg) * ringMid * 0.85, ringSize);
    if (text) arcText(text.toUpperCase(), { x, y, radius: ringMid, font: f, size: arcSize(text.toUpperCase(), 200), color, deg, opacity });
    if (sub) arcText(sub.toUpperCase(), { x, y, radius: ringMid, font: f, size: arcSize(sub.toUpperCase(), 140), color, deg, opacity, bottom: true });
    if (center) {
      const t = center.toUpperCase();
      centredText(t, { x, y, font: f, size: fitSize(f, t, inner * 1.7, r * 0.26), color, deg, opacity });
    }
  };

  const rect = ({ x, y, size, deg, opacity, hex, text, sub }) => {
    const color = hexToRgb(hex);
    const w = size * 1.5, h = size * 0.56;
    const bw = Math.max(1.4, size * 0.03);
    for (const [inset, width] of [[0, bw], [bw * 2.2, bw * 0.45]]) {
      const [ox, oy] = rot(-w / 2 + inset, -h / 2 + inset, deg);
      page.drawRectangle({ x: x + ox, y: y + oy, width: w - inset * 2, height: h - inset * 2, borderColor: color, borderWidth: width, borderOpacity: opacity, rotate: degrees(deg) });
    }
    if (text) {
      const t = text.toUpperCase();
      const [tx, ty] = rot(0, sub ? h * 0.1 : 0, deg);
      centredText(t, { x: x + tx, y: y + ty, font: fonts.helvBold, size: fitSize(fonts.helvBold, t, w * 0.82, h * (sub ? 0.36 : 0.46)), color, deg, opacity });
    }
    if (sub) {
      const t = sub.toUpperCase();
      const [sx, sy] = rot(0, -h * 0.25, deg);
      centredText(t, { x: x + sx, y: y + sy, font: fonts.helv, size: fitSize(fonts.helv, t, w * 0.8, h * 0.15), color, deg, opacity });
    }
  };

  return async function drawStamps(stamps, fillText, geo) {
    for (const st of stamps || []) {
      const [ax, ay] = anchor(st.position, { W, H, ...geo });
      const size = Math.max(30, Math.min(220, Number(st.size) || 90));
      const args = {
        x: ax + Number(st.dx || 0), y: ay + Number(st.dy || 0), size, r: size / 2,
        deg: Number(st.rotation || 0),
        opacity: Math.max(0.1, Math.min(1, st.opacity == null ? 1 : Number(st.opacity))),
        hex: st.color || '#b8892b',
        text: fillText(st.text), sub: fillText(st.subtext), center: fillText(st.center),
      };
      if (st.type === 'seal') seal(args);
      else if (st.type === 'round') round(args);
      else if (st.type === 'rect') rect(args);
      else if (st.type === 'image') {
        const img = await embedImage(st.image);
        if (!img) continue;
        const sc = Math.min(size / img.width, size / img.height);
        const w = img.width * sc, h = img.height * sc;
        const [ox, oy] = rot(-w / 2, -h / 2, args.deg);
        page.drawImage(img, { x: args.x + ox, y: args.y + oy, width: w, height: h, rotate: degrees(args.deg), opacity: args.opacity });
      }
    }
  };
}

module.exports = { createStampDrawer, POSITIONS };
