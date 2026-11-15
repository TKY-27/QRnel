const MAX_QR_BYTES = 2953;
const FLOPPY_BYTES = 1440 * 1024;
const ASSET_TIMEOUT = 15000;

// Describes the machine prepareEmulator() builds: v86 with the payload in an in-memory fda buffer.
export const machine = {
  medium: 'RAM-backed virtual floppy',
  emulator: 'v86 (x86)',
};

async function loadAsset(path) {
  const response = await fetch(new URL(path, import.meta.url), {
    signal: AbortSignal.timeout(ASSET_TIMEOUT),
  });
  if (!response.ok) throw new Error(`Could not load ${path.split('/').at(-1)} (${response.status}).`);
  return response;
}

export async function loadManifest() {
  const manifest = await (await loadAsset('./manifest.json')).json();
  if (!manifest || !Number.isInteger(manifest.size) || manifest.size < 512 || manifest.size > MAX_QR_BYTES ||
      typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
    throw new Error('The QRnel manifest is invalid.');
  }
  return manifest;
}

export async function loadSample() {
  return (await loadAsset('./qrnel.png')).blob();
}

export function readQr(canvas, source, longestSide) {
  if (typeof globalThis.jsQR !== 'function') throw new Error('The QR decoder could not load.');
  const width = source.videoWidth || source.naturalWidth;
  const height = source.videoHeight || source.naturalHeight;
  if (!width || !height) return null;
  const scale = Math.min(1, longestSide / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser could not open the image decoder.');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const code = globalThis.jsQR(pixels.data, pixels.width, pixels.height);
  return code ? Uint8Array.from(code.binaryData) : null;
}

export async function sha256(payload) {
  if (!crypto.subtle) throw new Error('Use HTTPS or localhost to verify the boot image.');
  const fingerprint = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
  return Array.from(fingerprint, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function makeFloppy(payload, manifest) {
  if (payload.length < 512 || payload.length > MAX_QR_BYTES ||
      payload[510] !== 0x55 || payload[511] !== 0xaa) {
    throw new Error('This QR does not contain a valid boot image. Use the QRnel image.');
  }
  const digest = await sha256(payload);
  if (payload.length !== manifest.size || digest !== manifest.sha256.toLowerCase()) {
    throw new Error('The boot image does not match this QRnel release. Use the matching QR image.');
  }

  const floppy = new Uint8Array(FLOPPY_BYTES);
  floppy.set(payload);
  return floppy.buffer;
}

async function loadWasm() {
  const response = await loadAsset('./vendor/v86.wasm');
  try {
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (error) {
    if (!(error instanceof WebAssembly.CompileError)) throw error;
    const fallback = await loadAsset('./vendor/v86-fallback.wasm');
    return WebAssembly.compile(await fallback.arrayBuffer());
  }
}

export async function prepareEmulator() {
  const [{ V86 }, bios, vgaBios, compiled] = await Promise.all([
    import('./vendor/libv86.mjs'),
    loadAsset('./vendor/seabios.bin').then(response => response.arrayBuffer()),
    loadAsset('./vendor/vgabios.bin').then(response => response.arrayBuffer()),
    loadWasm(),
  ]);

  return async (floppy, screen) => {
    const vm = new V86({
      wasm_fn: imports => Promise.resolve(new WebAssembly.Instance(compiled, imports).exports),
      memory_size: 16 * 1024 * 1024,
      vga_memory_size: 256 * 1024,
      bios: { buffer: bios },
      vga_bios: { buffer: vgaBios },
      fda: { buffer: floppy },
      screen: { container: screen },
      disable_speaker: true,
      disable_mouse: true,
    });
    return new Promise((resolve, reject) => {
      const ready = () => {
        clearTimeout(timeout);
        vm.remove_listener('emulator-ready', ready);
        vm.keyboard_set_enabled(false);
        resolve(vm);
      };
      const timeout = setTimeout(() => {
        vm.remove_listener('emulator-ready', ready);
        void vm.destroy().catch(error => console.error('v86 cleanup failed', error));
        reject(new Error('The virtual machine did not start. Try booting again.'));
      }, ASSET_TIMEOUT);
      vm.add_listener('emulator-ready', ready);
    });
  };
}
