import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import QRCode from 'qrcode';

const input = process.argv[2] || 'release/qrnel.bin';
const output = process.argv[3] || join(dirname(input), `${basename(input, extname(input))}.png`);
const bytes = await readFile(input);
if (bytes.length < 512 || bytes.length > 2953 || bytes[510] !== 0x55 || bytes[511] !== 0xaa) {
  throw new Error('Expected a boot image with a 0xAA55 signature and 512 to 2953 bytes');
}

await QRCode.toFile(output, [{ mode: 'byte', data: bytes }], {
  version: 40,
  errorCorrectionLevel: 'L',
  scale: 8,
  width: 1480,
  margin: 4,
});
console.log(`${output}: ${bytes.length} bytes in one QR v40-L byte segment`);
