import { loadManifest, loadSample, machine, makeFloppy, prepareEmulator, readQr, sha256 } from './runtime.js';

const byId = id => document.getElementById(id);
const media = byId('media');
const sample = byId('sample');
const preview = byId('preview');
const bootSample = byId('boot-sample');
const chooseImage = byId('choose-image');
const imageInput = byId('image');
const camera = byId('camera');
const status = byId('status');
const power = byId('power');
const powerOff = byId('power-off');
const idle = byId('screen-idle');
const guest = byId('guest');
const rows = {
  source: byId('verification-source'),
  payload: byId('verification-payload'),
  hash: byId('verification-hash'),
  status: byId('verification-status'),
};
const canvas = document.createElement('canvas');
const defaultStatus = status.textContent.trim();
const stillRunning = ' The previous virtual machine is still running.';

byId('verification-medium').textContent = machine.medium;
byId('verification-emulator').textContent = machine.emulator;

let manifest;
let launchEmulator;
let vm;
let scan;
let busy = false;

function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

// The verification rows always describe the most recent boot attempt only.
function showAttempt(state, { source = '—', payload, hash } = {}) {
  rows.status.textContent = state;
  rows.source.textContent = source;
  rows.payload.textContent = payload ? `${payload.length.toLocaleString('en-US')} bytes` : '—';
  if (!hash) {
    rows.hash.textContent = '—';
    return;
  }
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const full = document.createElement('code');
  summary.textContent = `${hash.slice(0, 12)}…`;
  full.textContent = hash;
  details.append(summary, full);
  rows.hash.replaceChildren(details);
}

function fail(message) {
  rows.status.textContent = 'Failed';
  setStatus(vm ? `${message}${stillRunning}` : message, true);
}

function updateControls() {
  bootSample.disabled = busy;
  chooseImage.disabled = busy;
  camera.disabled = busy;
  camera.textContent = scan ? 'Stop camera' : 'Use camera';
  camera.setAttribute('aria-pressed', String(Boolean(scan)));
  powerOff.disabled = busy || !vm;
}

function stopCamera() {
  if (!scan) return;
  clearTimeout(scan.timer);
  scan.stream?.getTracks().forEach(track => track.stop());
  scan = undefined;
  preview.srcObject = null;
  preview.hidden = true;
  sample.hidden = false;
  updateControls();
}

async function getManifest() {
  if (!manifest) {
    manifest = await loadManifest();
    byId('size').textContent = `${manifest.size.toLocaleString('en-US')} bytes`;
  }
  return manifest;
}

async function stopVm() {
  const previous = vm;
  vm = undefined;
  previous?.keyboard_set_enabled(false);
  guest.hidden = true;
  idle.hidden = false;
  power.textContent = 'Off';
  power.dataset.on = 'false';
  if (previous) await previous.destroy();
  guest.replaceChildren();
}

async function boot(source, readPayload) {
  if (busy) return;
  stopCamera();
  busy = true;
  updateControls();
  const attempt = { source };
  try {
    showAttempt('Reading', attempt);
    setStatus('Reading QR code…');
    const data = await readPayload();
    if (!data) throw new Error('No QR code found. Try a clearer image with the full border visible.');
    attempt.payload = data;
    attempt.hash = await sha256(data);
    showAttempt('Reading', attempt);
    const floppy = await makeFloppy(data, await getManifest());
    rows.status.textContent = 'Verified';
    setStatus('Booting the verified QR image…');
    launchEmulator ??= await prepareEmulator();
    await stopVm();
    const candidate = await launchEmulator(floppy, guest);
    await candidate.run();
    // v86 sets is_running() from its emulator-started event.
    if (!candidate.is_running()) {
      await candidate.destroy();
      throw new Error('The virtual machine did not start. Try booting again.');
    }
    vm = candidate;
    idle.hidden = true;
    guest.hidden = false;
    power.textContent = 'On';
    power.dataset.on = 'true';
    guest.tabIndex = 0;
    guest.focus({ preventScroll: true });
    rows.status.textContent = 'Running';
    setStatus(`Verified ${data.length.toLocaleString('en-US')} bytes. The virtual machine is running.`);
  } catch (error) {
    showAttempt('Failed', attempt);
    fail(error.message || 'The virtual machine could not start.');
  } finally {
    busy = false;
    updateControls();
  }
}

async function readImage(blob) {
  if (blob.size > 30 * 1024 * 1024) throw new Error('Choose an image smaller than 30 MB.');
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error('This file could not be opened as an image. Try a PNG or JPEG.');
    }
    return readQr(canvas, img, 2400);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function scanFrame(session) {
  if (scan !== session) return;
  try {
    if (preview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const data = readQr(canvas, preview, 1440);
      if (data) {
        void boot('Camera', () => data);
        return;
      }
    }
    session.timer = setTimeout(() => scanFrame(session), 175);
  } catch (error) {
    stopCamera();
    fail(error.message || 'The camera image could not be read. Try opening a QR image.');
  }
}

bootSample.addEventListener('click', () => void boot('Sample', async () => readImage(await loadSample())));
chooseImage.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', () => {
  const file = imageInput.files[0];
  imageInput.value = '';
  if (file) void boot('Image', () => readImage(file));
});

media.addEventListener('dragover', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
  if (!busy) media.dataset.dragging = 'true';
});
media.addEventListener('dragleave', event => {
  if (!media.contains(event.relatedTarget)) delete media.dataset.dragging;
});
media.addEventListener('drop', event => {
  delete media.dataset.dragging;
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  if (busy) return;
  const [file, additional] = event.dataTransfer.files;
  if (additional) void boot('Image', async () => { throw new Error('Drop one QR image at a time.'); });
  else if (file) void boot('Image', () => readImage(file));
});

camera.addEventListener('click', async () => {
  if (scan) {
    stopCamera();
    rows.status.textContent = 'Cancelled';
    setStatus(vm ? `Camera stopped.${stillRunning}` : defaultStatus);
    return;
  }
  showAttempt('Reading', { source: 'Camera' });
  if (!navigator.mediaDevices?.getUserMedia) {
    fail('Camera access requires HTTPS or localhost. You can still open an image.');
    return;
  }
  const session = {};
  scan = session;
  setStatus('Waiting for camera access…');
  updateControls();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
    if (scan !== session) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    session.stream = stream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (scan !== session) return;
        stopCamera();
        fail('Camera access ended. Use the camera again or open an image.');
      });
    }
    preview.dataset.mirrored = String(stream.getVideoTracks()[0].getSettings().facingMode !== 'environment');
    preview.srcObject = stream;
    preview.hidden = false;
    sample.hidden = true;
    await preview.play();
    if (scan !== session) return;
    setStatus('Hold the full QR code in view. Fill as much of the frame as you can.');
    scanFrame(session);
  } catch (error) {
    if (scan !== session) return;
    stopCamera();
    const message = error.name === 'NotAllowedError' ? 'Camera access was denied.' : 'The camera could not start.';
    fail(`${message} You can still open a QR image.`);
  }
});

powerOff.addEventListener('click', async () => {
  stopCamera();
  busy = true;
  updateControls();
  try {
    await stopVm();
    showAttempt('Idle');
    setStatus(defaultStatus);
  } catch {
    showAttempt('Failed');
    setStatus('The virtual machine could not close cleanly. Reload the page to start again.', true);
  } finally {
    busy = false;
    updateControls();
    bootSample.focus();
  }
});

guest.addEventListener('focus', () => vm?.keyboard_set_enabled(true));
guest.addEventListener('blur', () => vm?.keyboard_set_enabled(false));
guest.addEventListener('keydown', event => {
  if (event.key === 'Tab') event.stopPropagation();
});

window.addEventListener('pagehide', stopCamera);
getManifest().catch(error => {
  if (!busy) setStatus(error.message || 'The QRnel manifest could not load.', true);
});
