import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import jsQR from 'jsqr';
import pngjs from 'pngjs';

// Decode the actual printed modules independently of the encoder's input.
export function verifyQr(bytes, file) {
  const png = pngjs.PNG.sync.read(file);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!decoded || decoded.version !== 40 || decoded.chunks.length !== 1 || decoded.chunks[0].type !== 'byte') {
    throw new Error('Expected QR version 40 with one binary byte-mode segment');
  }
  if (!bytes.equals(Buffer.from(decoded.binaryData))) throw new Error('Decoded QR payload differs from the binary');

  // Sample the top-left copy of the masked format bits using the QR quiet zone
  // and module grid. L is encoded as 01 in the top two unmasked bits.
  const scale = png.width / (177 + 8);
  if (!Number.isInteger(scale) || png.width !== png.height) throw new Error('Unexpected QR PNG dimensions');
  function moduleAt(x, y) {
    const column = Math.floor((x + 4.5) * scale);
    const row = Math.floor((y + 4.5) * scale);
    return Number(png.data[4 * (row * png.width + column)] < 128);
  }
  const format = [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
                  [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]];
  const masked = format.reduce((bits, [x, y]) => (bits << 1) | moduleAt(x, y), 0);
  if (((masked ^ 0x5412) >>> 13) !== 1) throw new Error('Expected error correction level L');
  return createHash('sha256').update(bytes).digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const binary = process.argv[2] || 'release/qrnel.bin';
  const image = process.argv[3] || join(dirname(binary), `${basename(binary, extname(binary))}.png`);
  const [bytes, file] = await Promise.all([readFile(binary), readFile(image)]);
  console.log(`Verified QR v40-L: ${bytes.length} bytes, SHA-256 ${verifyQr(bytes, file)}`);
}
