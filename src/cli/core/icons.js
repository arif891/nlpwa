import { deflateSync } from 'node:zlib';

// Precompute CRC32 lookup table for standard PNG chunk checksums
const CRC_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function createChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcPayload = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcPayload), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function parseHexColor(hex, defaultColor = { r: 14, g: 165, b: 233 }) {
  if (!hex || typeof hex !== 'string') return defaultColor;
  const clean = hex.replace(/^#/, '');
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16),
    };
  }
  if (clean.length === 6) {
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16),
    };
  }
  return defaultColor;
}

/**
 * Generate a valid, standalone PNG icon buffer in pure Node.js.
 * Produces a sleek gradient/rounded app badge icon without external dependencies.
 *
 * @param {number} size 192 or 512
 * @param {Object} [options]
 * @param {string} [options.themeColor='#0ea5e9']
 * @param {string} [options.bgColor='#0f172a']
 * @returns {Buffer} Valid PNG file buffer
 */
export function createPngIcon(size = 192, options = {}) {
  const theme = parseHexColor(options.themeColor, { r: 14, g: 165, b: 233 });
  const bg = parseHexColor(options.bgColor, { r: 15, g: 23, b: 42 });

  // Scanlines: 1 filter byte (0 = None) + size * 4 bytes RGBA per row
  const rowLen = 1 + size * 4;
  const rawData = Buffer.alloc(rowLen * size);

  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.44;
  const innerRadius = size * 0.22;

  let offset = 0;
  for (let y = 0; y < size; y++) {
    rawData[offset++] = 0; // Filter byte: None

    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      let r, g, b, a;

      if (dist <= innerRadius) {
        // Inner badge symbol: bright white/accent
        r = 255;
        g = 255;
        b = 255;
        a = 255;
      } else if (dist <= radius) {
        // Main rounded app container: theme color with subtle vertical gradient
        const t = y / size;
        r = Math.min(255, Math.round(theme.r * (1.1 - t * 0.3)));
        g = Math.min(255, Math.round(theme.g * (1.1 - t * 0.3)));
        b = Math.min(255, Math.round(theme.b * (1.1 - t * 0.3)));
        a = 255;
      } else if (dist <= radius + 1.5) {
        // Antialiased outer edge
        const edgeAlpha = Math.max(0, Math.min(1, radius + 1.5 - dist));
        r = theme.r;
        g = theme.g;
        b = theme.b;
        a = Math.round(edgeAlpha * 255);
      } else {
        // Outer background
        r = bg.r;
        g = bg.g;
        b = bg.b;
        a = 255;
      }

      rawData[offset++] = r;
      rawData[offset++] = g;
      rawData[offset++] = b;
      rawData[offset++] = a;
    }
  }

  // PNG Signature
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR chunk: width, height, bitDepth (8), colorType (6 = RGBA), comp (0), filter (0), interlace (0)
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // RGBA color
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method
  const ihdrChunk = createChunk('IHDR', ihdrData);

  // IDAT chunk: compressed scanline data
  const compressed = deflateSync(rawData, { level: 9 });
  const idatChunk = createChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * Generate a scalable SVG icon for the PWA.
 *
 * @param {Object} [options]
 * @param {string} [options.name='App']
 * @param {string} [options.themeColor='#0ea5e9']
 * @param {string} [options.bgColor='#0f172a']
 * @returns {string} SVG markup
 */
export function createSvgIcon(options = {}) {
  const theme = options.themeColor || '#0ea5e9';
  const bg = options.bgColor || '#0f172a';
  const letter = (options.shortName || options.name || 'P')[0].toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="nlpwa-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${theme}" />
      <stop offset="100%" stop-color="#0284c7" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="128" fill="${bg}" />
  <circle cx="256" cy="256" r="180" fill="url(#nlpwa-grad)" />
  <text x="256" y="325" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="200" font-weight="bold" fill="#ffffff" text-anchor="middle">${letter}</text>
</svg>
`;
}

/**
 * Generate a standard W3C Web App Manifest structure.
 *
 * @param {Object} [options]
 * @returns {Object} Manifest JSON object
 */
export function createManifest(options = {}) {
  const name = options.name || 'My Progressive Web App';
  const shortName = options.shortName || name.split(' ')[0] || 'App';
  const themeColor = options.themeColor || '#0ea5e9';
  const bgColor = options.bgColor || '#0f172a';
  const startUrl = options.startUrl || '/';

  const manifest = {
    name,
    short_name: shortName,
    description: options.description || 'Native-like Progressive Web App powered by NLPWA',
    start_url: startUrl,
    scope: options.scope || '/',
    display: options.display || 'standalone',
    background_color: bgColor,
    theme_color: themeColor,
    icons: options.icons || [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any maskable',
      },
    ],
    launch_handler: options.launchHandler || {
      client_mode: 'navigate-existing',
    },
    shortcuts: options.shortcuts || [
      {
        name: `Open ${shortName}`,
        short_name: shortName,
        url: startUrl,
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
      },
    ],
  };

  if (options.shareTarget) {
    manifest.share_target = options.shareTarget;
  }
  if (options.fileHandlers) {
    manifest.file_handlers = options.fileHandlers;
  }

  return manifest;
}
