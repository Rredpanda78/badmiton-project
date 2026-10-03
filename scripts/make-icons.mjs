// 產生 App 圖示（加到主畫面用）：球場綠底＋斜放的羽球。不用任何圖片套件，自己畫像素再編成 PNG。
// 執行：node scripts/make-icons.mjs  → public/icon-192.png、icon-512.png、icon-maskable-512.png、apple-touch-icon.png
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], t));
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const GREEN_TOP = hex('#2f9a6b');
const GREEN_BOT = hex('#17583e');
const LINE = hex('#f4f7f2');
const FEATHER = hex('#fbfcf8');
const RIB = hex('#c9d2cf');
const BAND = hex('#ffd54a');
const CORK_HI = hex('#f1dfbd');
const CORK_LO = hex('#c49a62');

/**
 * 在「256 為中心、512 大小」的座標中，回傳這一點的顏色與不透明度（沒東西回傳 null）。
 * scale：內容縮放（maskable 圖示要留安全邊）
 */
function shuttle(px, py, scale) {
  // 轉到羽球自己的座標：繞中心轉 -35°（羽毛朝右上）
  const a = (35 * Math.PI) / 180;
  const dx = (px - 262) / scale;
  const dy = (py - 262) / scale;
  const x = dx * Math.cos(a) + dy * Math.sin(a);
  const y = -dx * Math.sin(a) + dy * Math.cos(a);
  // 軟木頭：下面半圓＋上面一段直筒
  const corkC = 92;
  const corkR = 50;
  if ((y >= 56 && y <= corkC && Math.abs(x) <= corkR) || Math.hypot(x, y - corkC) <= corkR) {
    if (y < 72) return BAND; // 金色的環
    const t = Math.min(1, Math.max(0, (x + corkR) / (2 * corkR)));
    return mix(CORK_HI, CORK_LO, t * 0.9);
  }
  // 羽毛裙：梯形，上緣是一排圓弧
  const yTop = -175;
  const yBot = 58;
  if (y <= yBot && y >= yTop - 14) {
    const u = (yBot - y) / (yBot - yTop); // 0 = 底、1 = 頂
    const half = lerp(48, 132, Math.min(1, u));
    if (Math.abs(x) <= half) {
      const k = 16; // 羽毛數（頂端圓弧）
      const seg = (2 * half) / k;
      const fx = ((x + half) % seg) / seg - 0.5;
      const scallop = yTop - 14 * Math.sqrt(Math.max(0, 1 - 4 * fx * fx));
      if (y < scallop) return null;
      // 羽軸：從底部放射到頂端
      for (let i = -3; i <= 3; i++) {
        const rx = (i / 3.5) * half;
        if (Math.abs(x - rx) < 2.2) return RIB;
      }
      // 兩條橫綁線
      if (Math.abs(u - 0.38) < 0.018 || Math.abs(u - 0.62) < 0.018) return RIB;
      // 邊緣暗一點（立體感）
      return mix(FEATHER, RIB, Math.pow(Math.abs(x) / half, 3) * 0.6);
    }
  }
  return null;
}

/** 背景：綠色漸層＋淡淡的白線（球場） */
function background(px, py) {
  let c = mix(GREEN_TOP, GREEN_BOT, py / 512);
  const onLine = Math.abs(py - 380) < 7 || Math.abs(px - 110) < 7;
  if (onLine && px > 50 && py < 470) c = mix(c, LINE, 0.55);
  return c;
}

function render(size, { rounded, scale }) {
  const SS = 4; // 每像素 4×4 取樣抗鋸齒
  const out = Buffer.alloc(size * size * 4);
  const k = 512 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, al = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (i + (sx + 0.5) / SS) * k;
          const py = (j + (sy + 0.5) / SS) * k;
          // 圓角方形外面透明（iOS 圖示自己會切圓角，就不用）
          if (rounded) {
            const R = 104;
            const qx = Math.max(Math.abs(px - 256) - (256 - R), 0);
            const qy = Math.max(Math.abs(py - 256) - (256 - R), 0);
            if (Math.hypot(qx, qy) > R) continue;
          }
          let c = background(px, py);
          // 影子
          if (shuttle(px - 10, py - 14, scale)) c = mix(c, [0, 0, 0], 0.28);
          const s = shuttle(px, py, scale);
          if (s) c = s;
          r += c[0];
          g += c[1];
          b += c[2];
          al += 1;
        }
      }
      const n = SS * SS;
      const o = (j * size + i) * 4;
      out[o] = al ? Math.round(r / al) : 0;
      out[o + 1] = al ? Math.round(g / al) : 0;
      out[o + 2] = al ? Math.round(b / al) : 0;
      out[o + 3] = Math.round((al / n) * 255);
    }
  }
  return png(size, size, out);
}

function png(w, h, rgba) {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('public', { recursive: true });
writeFileSync('public/icon-512.png', render(512, { rounded: true, scale: 1 }));
writeFileSync('public/icon-192.png', render(192, { rounded: true, scale: 1 }));
writeFileSync('public/icon-maskable-512.png', render(512, { rounded: false, scale: 0.78 }));
writeFileSync('public/apple-touch-icon.png', render(180, { rounded: false, scale: 0.92 }));
console.log('icons written');
