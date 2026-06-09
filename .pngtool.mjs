import fs from 'node:fs';
import zlib from 'node:zlib';

const SRC = String.raw`C:\Users\ivan\.cursor\projects\c-Users-ivan-Workspace-repos-bios-creategreen\assets\c__Users_ivan_AppData_Roaming_Cursor_User_workspaceStorage_7c926b9ffb6bad77835a1bb983c2fc99_images_CREATEGREEN_Sticker-a5f1e2a4-7ebb-4639-bc7d-199cd21edba9.png`;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function decodePNG(file) {
  const b = fs.readFileSync(file);
  let o = 8;
  let width, height, bitDepth, colorType;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString('ascii', o + 4, o + 8);
    const data = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit supported, got ' + bitDepth);
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : null;
  if (!channels) throw new Error('unsupported colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let p = 0;
  const paeth = (a, b2, c) => {
    const pp = a + b2 - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b2), pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b2 : c;
  };
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    for (let x = 0; x < stride; x++) {
      const rv = raw[p++];
      const a = x >= channels ? cur[x - channels] : 0;
      const bb = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v;
      if (ft === 0) v = rv;
      else if (ft === 1) v = rv + a;
      else if (ft === 2) v = rv + bb;
      else if (ft === 3) v = rv + ((a + bb) >> 1);
      else if (ft === 4) v = rv + paeth(a, bb, c);
      else throw new Error('bad filter ' + ft);
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      if (channels === 1) { out[di] = out[di+1] = out[di+2] = cur[si]; out[di+3] = 255; }
      else { out[di] = cur[si]; out[di+1] = cur[si+1]; out[di+2] = cur[si+2]; out[di+3] = channels === 4 ? cur[si+3] : 255; }
    }
    cur.copy(prev);
  }
  return { width, height, data: out };
}

function encodePNG(width, height, data) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const comp = zlib.deflateSync(raw, { level: 9 });
  const chunks = [];
  const chunk = (type, payload) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(payload.length);
    const t = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.concat([t, payload]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcBuf));
    chunks.push(len, t, payload, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk('IHDR', ihdr);
  chunk('IDAT', comp);
  chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), ...chunks]);
}

const cmd = process.argv[2];
const img = decodePNG(SRC);

if (cmd === 'info') {
  console.log('size', img.width, 'x', img.height);
  // sample a grid of colors to locate the green logo
  const sx = 40, sy = 24;
  for (let gy = 0; gy < sy; gy++) {
    let row = '';
    for (let gx = 0; gx < sx; gx++) {
      const x = Math.floor((gx + 0.5) * img.width / sx);
      const y = Math.floor((gy + 0.5) * img.height / sy);
      const i = (y * img.width + x) * 4;
      const r = img.data[i], g = img.data[i+1], b = img.data[i+2];
      // classify: white '.', lime-green 'G', blue 'B', other 'o'
      let ch = 'o';
      if (r > 235 && g > 235 && b > 235) ch = '.';
      else if (g > 140 && r > 110 && r < 200 && b < 120) ch = 'G';
      else if (b > 110 && b > r + 20 && b > g) ch = 'B';
      row += ch;
    }
    console.log(row);
  }
}

if (cmd === 'crop') {
  const x0 = +process.argv[3], y0 = +process.argv[4], x1 = +process.argv[5], y1 = +process.argv[6];
  const dst = process.argv[7];
  const transparent = process.argv[8] === 'transparent';
  const w = x1 - x0, h = y1 - y0;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * img.width + (x0 + x)) * 4;
      const di = (y * w + x) * 4;
      let r = img.data[si], g = img.data[si+1], b = img.data[si+2], a = img.data[si+3];
      if (transparent) {
        // map whiteness to alpha so anti-aliased edges stay smooth
        const minc = Math.min(r, g, b);
        if (minc > 250) { a = 0; }
        else if (minc > 200) {
          // partial: alpha based on how far from white
          a = Math.round((255 - minc) / (255 - 200) * 255);
        }
      }
      out[di] = r; out[di+1] = g; out[di+2] = b; out[di+3] = a;
    }
  }
  fs.writeFileSync(dst, encodePNG(w, h, out));
  console.log('wrote', dst, w, 'x', h);
}

if (cmd === 'bbox') {
  // find bounding box of lime-green logo pixels
  let minx=1e9,miny=1e9,maxx=-1,maxy=-1;
  for (let y=0;y<img.height;y++) for (let x=0;x<img.width;x++){
    const i=(y*img.width+x)*4;
    const r=img.data[i],g=img.data[i+1],b=img.data[i+2];
    if (g>140 && r>110 && r<200 && b<120){
      if(x<minx)minx=x; if(x>maxx)maxx=x; if(y<miny)miny=y; if(y>maxy)maxy=y;
    }
  }
  console.log('lime bbox', minx, miny, maxx, maxy);
}
