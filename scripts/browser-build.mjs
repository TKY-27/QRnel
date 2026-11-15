import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { verifyQr } from './qr-verify.mjs';

const root = new URL('../', import.meta.url);
const output = new URL('build/web/', root);
const cache = new URL('build/browser-cache/', root);
const v86Revision = '315b2b0b758703ef0e6cc7b4088d6068f83f3c20';
const firmware = `https://raw.githubusercontent.com/copy/v86/${v86Revision}/bios/`;
const rust = 'https://raw.githubusercontent.com/rust-lang/rust/58cf8f9c35b355199727627d07ae34a4e2846d67';

const downloads = [
  ['Rust-LICENSE-MIT.txt', `${rust}/LICENSE-MIT`, 'b71bd43a069ca0641a9ecfe585ca7b3c53b5cc1608f8b68321168698e28b5ea1'],
  ['Rust-Unicode-LICENSE.txt', `${rust}/LICENSES/Unicode-3.0.txt`, 'f5062c9a188d81dfe66b56db4182dcf9e4b17c0d9b0d311a8e20b3a1b075c443'],
  ['Rust-libm-LICENSE.txt', `${rust}/library/compiler-builtins/libm/LICENSE.txt`, '3823dda7cf046602f4b4e77ec8e227863dc4736037cc85bb33d9f19febe16bb7'],
  ['Rust-builtins-LICENSE.txt', `${rust}/library/compiler-builtins/LICENSE.txt`, 'ab6eec6caf0fa5775e411c7a8bc6a45c4ef2956b0980b157ab74fc5cd62a928b'],
  ['Rust-dlmalloc-LICENSE.txt', 'https://raw.githubusercontent.com/alexcrichton/dlmalloc-rs/f2c9f2b0c356e173b34c902f74641b8b3aeffb22/LICENSE-MIT', '378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397'],
  ['Rust-hashbrown-LICENSE.txt', 'https://raw.githubusercontent.com/rust-lang/hashbrown/c62a63a61b7caf2de8f9ecb7b06a66b0ab6bdf3d/LICENSE-MIT', 'ff8f68cb076caf8cefe7a6430d4ac086ce6af2ca8ce2c4e5a2004d4552ef52a2'],
  ['v86-FDC-LICENSE.txt', `https://raw.githubusercontent.com/copy/v86/${v86Revision}/LICENSE.MIT`, 'be2a564f95c110b381fde87ea17b24adb50a5cd4c279ecb7991dee7821041069'],
  ['jor1k-LICENSE.txt', 'https://raw.githubusercontent.com/s-macke/jor1k/3c7103badda04aa899df779a258b7f2c22f04b95/LICENSE.md', '8185caf6a813485e47419f9210524b6af669709a76ad81c0b5ee63f16e1d1ade'],
  ['SoftFloat-LICENSE.txt', 'https://raw.githubusercontent.com/ucb-bar/berkeley-softfloat-3/07ebd29db0cfb55723a79fbbffe99103ef38e305/COPYING.txt', '145ea96b4a4a04a1a7738d2a2bf9e830f861971e69606187b018d9e8fc0b95c7'],
  ['Zstandard-LICENSE.txt', 'https://raw.githubusercontent.com/facebook/zstd/v1.4.5/LICENSE', '2c1a7fa704df8f3a606f6fc010b8b5aaebf403f3aeec339a12048f1ba7331a0b'],
  ['seabios.bin', `${firmware}seabios.bin`, '73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98'],
  ['vgabios.bin', `${firmware}vgabios.bin`, 'a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880'],
  ['seabios.config', `${firmware}seabios.config`, '7d1337b30591277356ca1b1bf1a192c2c1f17e15ec9e5740befcc57bb000339d'],
  ['fetch-and-build-seabios.sh', `${firmware}fetch-and-build-seabios.sh`, '057856a817ae3dc85b18dc00f19274f6e877e6f28a36dce1afc5be751739e24a'],
  ['SeaBIOS-COPYING.LESSER', `${firmware}COPYING.LESSER`, 'a853c2ffec17057872340eee242ae4d96cbf2b520ae27d903e1b2fef1a5f9d1c'],
  ['SeaBIOS-COPYING', 'https://raw.githubusercontent.com/coreboot/seabios/rel-1.16.2/COPYING', '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'],
  ['seabios-rel-1.16.2.tar.gz', 'https://codeload.github.com/coreboot/seabios/tar.gz/refs/tags/rel-1.16.2', 'fcb12b790971dd9918b1c631b34677f996bd283f0f8ee5c57aa98ab90645f5c0'],
];

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function fetchPinned([filename, url, digest]) {
  const cached = new URL(filename, cache);
  try {
    if (sha256(await readFile(cached)) === digest) return cached;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Could not download ${filename} (${response.status})`);
  const data = Buffer.from(await response.arrayBuffer());
  if (sha256(data) !== digest) throw new Error(`${filename} SHA-256 mismatch`);
  await writeFile(cached, data);
  return cached;
}

const published = ['qrnel.png', 'manifest.json'];
const [image, manifest, binary] = await Promise.all([...published, 'qrnel.bin'].map(async file => {
  try {
    return await readFile(new URL(`release/${file}`, root));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`Missing release/${file}. Build the boot image and generate its QR before building the demo.`);
  }
}));
const digest = verifyQr(binary, image);
const { size, sha256: expected } = JSON.parse(manifest);
if (size !== binary.length || expected !== digest) throw new Error('Release manifest does not match the boot image');

await mkdir(cache, { recursive: true });
const firmwareFiles = await Promise.all(downloads.map(fetchPinned));
await rm(output, { recursive: true, force: true });
const vendorOutput = new URL('vendor/', output);
await cp(new URL('web/', root), output, { recursive: true });
await mkdir(vendorOutput);
const modules = new URL('node_modules/', root);
const assets = {
  'libv86.mjs': 'v86/build/libv86.mjs',
  'v86.wasm': 'v86/build/v86.wasm',
  'v86-fallback.wasm': 'v86/build/v86-fallback.wasm',
  'v86-LICENSE.txt': 'v86/LICENSE',
  'jsQR.js': 'jsqr/dist/jsQR.js',
  'jsQR-LICENSE.txt': 'jsqr/LICENSE',
};
await Promise.all([
  writeFile(new URL(published[0], output), image),
  writeFile(new URL(published[1], output), manifest),
  ...firmwareFiles.map((file, index) => cp(file, new URL(downloads[index][0], vendorOutput))),
  ...Object.entries(assets).map(([file, source]) => cp(new URL(source, modules), new URL(file, vendorOutput))),
]);
console.log('Static demo created in build/web/');
