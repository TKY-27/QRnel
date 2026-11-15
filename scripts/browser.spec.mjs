import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import QRCode from 'qrcode';
import pngjs from 'pngjs';

const release = new URL('../release/', import.meta.url);
const binary = new URL('qrnel.bin', release);
const image = new URL('qrnel.png', release);
const vector = new URL('qrnel.svg', release);
const screenshot = (testInfo, name) => testInfo.outputPath(`${name}.png`);
const bootTitle = 'QRnel / Rust';
const releaseBytes = await readFile(binary);
const releaseHash = createHash('sha256').update(releaseBytes).digest('hex');

async function verification(page, source, state, bytes = releaseBytes) {
  await expect(page.locator('#verification-source')).toHaveText(source);
  await expect(page.locator('#verification-status')).toHaveText(state);
  await expect(page.locator('#verification-payload')).toHaveText(`${bytes.length.toLocaleString('en-US')} bytes`);
  await expect(page.locator('#verification-hash code')).toHaveText(createHash('sha256').update(bytes).digest('hex'));
  await expect(page.locator('#verification-medium')).toHaveText('RAM-backed virtual floppy');
  await expect(page.locator('#verification-emulator')).toHaveText('v86 (x86)');
}

async function enter(guest, text) {
  await guest.press(text);
  await guest.press('Enter');
}

test('sample QR boots real x86 guest and accepts guest keyboard input', async ({ page, request, baseURL }, testInfo) => {
  const failures = [];
  const requests = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => requests.push(new URL(request.url())));
  await page.goto('./');
  await page.getByRole('button', { name: 'Boot this QR' }).click();
  const guest = page.locator('#guest');
  await expect(guest).toContainText(bootTitle);
  await expect(guest).toBeFocused();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await verification(page, 'Sample', 'Running');
  await enter(guest, 't');
  await expect(guest).toContainText(/ticks [1-9]\d*/);
  const firstTicks = (await guest.textContent()).match(/ticks [1-9]\d*/)[0];
  await enter(guest, 't');
  await expect.poll(async () => {
    return (await guest.textContent()).match(/ticks [1-9]\d*/g)?.at(-1);
  }).not.toBe(firstTicks);

  // The demo draws directly into VGA memory and Escape returns to the shell.
  await enter(guest, 'd');
  await expect(guest).toContainText('TRAIL / arrows steer / Esc shell');
  await expect(guest).toContainText('█');
  await page.screenshot({ path: screenshot(testInfo, 'trail') });
  await guest.press('Escape');
  await expect(guest).toContainText('h help');
  await expect(guest).not.toContainText('TRAIL / arrows steer / Esc shell');
  await guest.press('Tab');
  await expect(guest).not.toBeFocused();
  await page.getByRole('button', { name: 'Power off' }).click();
  await expect(guest).toBeHidden();
  await expect(page.locator('#verification-status')).toHaveText('Idle');
  await expect(page.locator('#verification-hash')).toHaveText('—');
  await expect(page.getByRole('button', { name: 'Boot this QR' })).toBeFocused();
  expect(failures).toEqual([]);
  expect(requests.filter(url => ['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(baseURL).origin)).toEqual([]);
  expect(requests.filter(url => url.pathname.endsWith('.bin')).map(url => url.pathname).sort())
    .toEqual(['vendor/seabios.bin', 'vendor/vgabios.bin'].map(path => new URL(path, baseURL).pathname));
  expect((await request.get('./qrnel.bin')).status()).toBe(404);
});

test('image import can recover from wrong and unreadable media', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  const input = page.locator('#image');
  const status = page.getByRole('status');
  const guest = page.locator('#guest');

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open image' }).click();
  await (await chooser).setFiles({ name: 'unreadable.png', mimeType: 'image/png', buffer: Buffer.from('invalid PNG') });
  await expect(status).toContainText('could not be opened as an image');
  await expect(page.locator('#verification-source')).toHaveText('Image');
  await expect(page.locator('#verification-status')).toHaveText('Failed');
  await expect(page.locator('#verification-payload')).toHaveText('—');
  await expect(page.locator('#verification-hash')).toHaveText('—');
  await expect(guest).toBeHidden();

  const blank = pngjs.PNG.sync.write(new pngjs.PNG({ width: 40, height: 40 }));
  await input.setInputFiles({ name: 'blank.png', mimeType: 'image/png', buffer: blank });
  await expect(status).toContainText('No QR code found');

  await input.setInputFiles(fileURLToPath(image));
  await expect(guest).toContainText(bootTitle);
  await verification(page, 'Image', 'Running');
  await guest.click();
  await enter(guest, 'm');
  await expect(guest).toContainText('free 4096');
  await page.screenshot({ path: screenshot(testInfo, 'mobile-guest'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  const edited = await readFile(binary);
  edited[300] ^= 1; // Keep the boot sector signature and length intact.
  const wrong = await QRCode.toBuffer([{ mode: 'byte', data: edited }], {
    errorCorrectionLevel: 'L', version: 40, scale: 4,
  });
  await input.setInputFiles({ name: 'wrong-release.png', mimeType: 'image/png', buffer: wrong });
  await expect(status).toContainText('does not match this QRnel release');
  await verification(page, 'Image', 'Failed', edited);
  await expect(status).toContainText('The previous virtual machine is still running');
  await expect(guest).toContainText('free 4096');
  await input.setInputFiles(fileURLToPath(image));
  await expect(status).toContainText('The virtual machine is running');
  await expect(guest).toContainText(bootTitle);
  await expect(guest).not.toContainText('free 4096');
});

test('a firmware download failure permits a fresh boot', async ({ page }) => {
  await page.route('**/vendor/seabios.bin', route => route.fulfill({ status: 503 }));
  await page.goto('./');
  const boot = page.getByRole('button', { name: 'Boot this QR' });
  await boot.click();
  await expect(page.getByRole('status')).toContainText('Could not load seabios.bin (503)');
  await expect(page.locator('#guest')).toBeHidden();
  await page.unroute('**/vendor/seabios.bin');
  await boot.click();
  await expect(page.locator('#guest')).toContainText(bootTitle);
});

test('the release SVG decodes exactly and boots through image import', async ({ page }) => {
  await page.goto('./');
  const svg = await readFile(vector, 'utf8');
  const decoded = await page.evaluate(async source => {
    const image = new Image();
    image.src = `data:image/svg+xml;base64,${btoa(source)}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1480;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 1480, 1480);
    return jsQR(context.getImageData(0, 0, 1480, 1480).data, 1480, 1480)?.binaryData;
  }, svg);
  expect(Buffer.from(decoded)).toEqual(releaseBytes);
  await page.locator('#image').setInputFiles(fileURLToPath(vector));
  await expect(page.locator('#guest')).toContainText(bootTitle);
  await verification(page, 'Image', 'Running');
});

test('denied camera access leaves image import available', async ({ page }) => {
  await page.addInitScript(() => {
    MediaDevices.prototype.getUserMedia = async () => {
      throw new DOMException('Camera permission denied', 'NotAllowedError');
    };
  });
  await page.goto('./');
  const camera = page.getByRole('button', { name: 'Use camera' });
  await camera.click();
  await expect(page.getByRole('status')).toContainText('Camera access was denied');
  await expect(page.locator('#verification-source')).toHaveText('Camera');
  await expect(page.locator('#verification-status')).toHaveText('Failed');
  await expect(page.locator('#verification-hash')).toHaveText('—');
  await expect(camera).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Open image' })).toBeEnabled();
});

test('power off cancels pending camera access and releases a late stream', async ({ page }) => {
  await page.addInitScript(() => {
    MediaDevices.prototype.getUserMedia = () => new Promise(resolve => {
      window.grantCamera = () => resolve({
        getTracks: () => [{ stop() { window.cameraStopped = true; } }],
      });
    });
  });
  await page.goto('./');
  await page.locator('#boot-sample').click();
  await expect(page.locator('#guest')).toContainText(bootTitle);
  const camera = page.locator('#camera');
  await camera.click();
  await expect(camera).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#verification-source')).toHaveText('Camera');
  await page.locator('#power-off').click();
  await expect(page.locator('#verification-status')).toHaveText('Idle');
  await page.evaluate(() => window.grantCamera());
  await expect.poll(() => page.evaluate(() => window.cameraStopped)).toBe(true);
  await expect(camera).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#verification-status')).toHaveText('Idle');
  await expect(page.locator('#guest')).toBeHidden();
  await expect(page.locator('#preview')).toBeHidden();
});

async function makeCameraFrame(path) {
  const png = pngjs.PNG.sync.read(await readFile(image));
  const side = 1110;
  const luma = Buffer.alloc(side * side);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const source = Math.floor(y * png.height / side) * png.width + Math.floor(x * png.width / side);
      luma[y * side + x] = png.data[source * 4] > 127 ? 235 : 16;
    }
  }
  // Chromium accepts a one-frame YUV4MPEG2 file as a looping video capture source.
  const header = Buffer.from(`YUV4MPEG2 W${side} H${side} F30:1 Ip A1:1 C420jpeg\nFRAME\n`);
  const chroma = Buffer.alloc(side * side / 2, 128);
  await writeFile(path, Buffer.concat([header, luma, chroma]));
}

test('camera frames boot the guest and release the stream', async ({ playwright, browserName, baseURL }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Chromium provides file-backed camera capture for this test');
  const y4m = testInfo.outputPath('qr-camera.y4m');
  await makeCameraFrame(y4m);
  const browser = await playwright.chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${y4m}`],
  });
  try {
    const page = await browser.newPage({ baseURL });
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      const held = new Promise(resolve => { window.showCamera = resolve; });
      HTMLMediaElement.prototype.play = async function () {
        await play.call(this);
        await held;
      };
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await original(constraints);
        window.testCameraStream = stream;
        return stream;
      };
    });
    await page.goto('./');
    await page.getByRole('button', { name: 'Use camera' }).click();
    const preview = page.locator('#preview');
    await expect(preview).toBeVisible();
    await expect(preview).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 0, 0)');
    await preview.evaluate(video => new Promise(resolve => video.requestVideoFrameCallback(resolve)));
    await page.screenshot({ path: screenshot(testInfo, 'camera-preview') });
    await page.evaluate(() => window.showCamera());
    await expect(page.locator('#guest')).toContainText(bootTitle);
    await expect(page.locator('#preview')).toBeHidden();
    await verification(page, 'Camera', 'Running');
    const states = await page.evaluate(() => window.testCameraStream.getTracks().map(track => track.readyState));
    expect(states).toEqual(['ended']);
  } finally {
    await browser.close();
  }
});

test('the full 80-by-25 guest page fits desktop and narrow viewports', async ({ page }) => {
  await page.goto('./');
  await page.locator('#boot-sample').click();
  await expect(page.locator('#guest')).toContainText(bootTitle);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 },
                          { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => {
      const guest = document.getElementById('guest');
      const bounds = guest.getBoundingClientRect();
      const rows = [...guest.querySelectorAll(':scope > div > div')];
      const rowBounds = rows.map(row => row.getBoundingClientRect());
      const controls = ['boot-sample', 'choose-image', 'camera', 'power-off'];
      return {
        pageWidth: document.documentElement.scrollWidth,
        rows: rows.length,
        columns: rows.map(row => row.textContent.length),
        // Real VGA rows must fit, not just the outer emulator frame.
        rowsFit: rowBounds.every(row => row.left >= bounds.left - 1 && row.right <= bounds.right + 1 &&
                                       row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1),
        screenBottom: bounds.bottom,
        controls: controls.map(id => {
          const rect = document.getElementById(id).getBoundingClientRect();
          return { id, left: rect.left, right: rect.right, bottom: rect.bottom };
        }),
      };
    });
    expect(layout.pageWidth).toBe(viewport.width);
    expect(layout.rows).toBe(25);
    expect(layout.columns).toEqual(Array(25).fill(80));
    expect(layout.rowsFit).toBe(true);
    for (const control of layout.controls) {
      expect(control.left, control.id).toBeGreaterThanOrEqual(0);
      expect(control.right, control.id).toBeLessThanOrEqual(viewport.width);
      if (viewport.width >= 1280) expect(control.bottom, control.id).toBeLessThanOrEqual(viewport.height);
    }
    if (viewport.width >= 1280) expect(layout.screenBottom).toBeLessThanOrEqual(viewport.height);
  }
});

async function snakeMarker(guest, marker) {
  const rows = await guest.locator(':scope > div > div').allTextContents();
  const y = rows.findIndex(row => row.includes(marker));
  return y < 0 ? null : [(rows[y].indexOf(marker) - 24) / 2, y - 5];
}

const snakeHead = guest => snakeMarker(guest, '@');

async function snakeMove(guest, key, destination) {
  if (key) await guest.press(key);
  await expect.poll(() => snakeHead(guest), { intervals: [10], timeout: 1000 }).toEqual(destination);
}

test('Snake plays through food, WASD, collision, restart and shell return', async ({ page }, testInfo) => {
  await page.goto('./');
  await page.locator('#boot-sample').click();
  const guest = page.locator('#guest');
  await expect(guest).toContainText(bootTitle);
  await enter(guest, 'a');
  await enter(guest, 's');
  await expect(guest).toContainText('SNAKE: WASD / R restart / Esc shell');
  await expect(guest).toContainText('score 0');
  expect(await snakeHead(guest)).toEqual([7, 6]);
  await snakeMove(guest, 'a', [8, 6]); // Reverse cannot turn the head into its neck.
  await snakeMove(guest, 'd', [9, 6]);
  await snakeMove(guest, null, [10, 6]);
  await snakeMove(guest, null, [11, 6]);
  await expect(guest).toContainText('score 1');
  const food = await snakeMarker(guest, '*');
  const row = food[1] === 5 && [10, 11].includes(food[0]) ? 7 : 5;
  // Avoid eating again in this square: tail entry is legal only when it vacates.
  await guest.press(row === 5 ? 'w' : 's');
  await snakeMove(guest, 'd', [11, row]); // Preserve the first accepted turn this tick.
  await snakeMove(guest, 'a', [10, row]);
  await snakeMove(guest, row === 5 ? 's' : 'w', [10, 6]);
  await expect(guest).not.toContainText('GAME OVER');
  await page.screenshot({ path: screenshot(testInfo, 'snake'), fullPage: true });
  await guest.press('r');
  await expect(guest).toContainText('score 0');
  expect(await snakeHead(guest)).toEqual([7, 6]);
  await expect(guest).toContainText('GAME OVER');
  expect(await snakeHead(guest)).toEqual([15, 6]);
  await guest.press('r');
  await expect(guest).not.toContainText('GAME OVER');
  await expect(guest).toContainText('score 0');
  await guest.press('Escape');
  await expect(guest).toContainText('h help');
  await enter(guest, 'm');
  await expect(guest).toContainText('free 3840');
  await enter(guest, 'd');
  await expect(guest).toContainText('TRAIL /');
  await guest.press('Escape');
  await expect(guest).toContainText('h help');
});


test('verification precedes actual start and exposes the full computed fingerprint', async ({ page }) => {
  // Hold the real response without network interception, which breaks WebKit Blob workers.
  await page.addInitScript(() => {
    const held = new Promise(resolve => { window.releaseFirmware = resolve; });
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (new URL(response.url).pathname.endsWith('/vendor/seabios.bin')) await held;
      return response;
    };
  });
  try {
    await page.goto('./');
    await expect(page.locator('#verification-status')).toHaveText('Idle');
    await expect(page.locator('#verification-hash')).toHaveText('—');
    await page.locator('#boot-sample').click();
    await verification(page, 'Sample', 'Verified');
    await expect(page.locator('#guest')).toBeHidden();
    await expect(page.locator('#power')).toHaveText('Off');
    await page.locator('#verification-hash summary').click();
    await expect(page.locator('#verification-hash code')).toBeVisible();
    await expect(page.locator('#verification-hash code')).toHaveText(releaseHash);
    await page.evaluate(() => window.releaseFirmware());
    await verification(page, 'Sample', 'Running');
    await expect(page.locator('#guest')).toContainText(bootTitle);
  } finally { await page.evaluate(() => window.releaseFirmware()); }
});
