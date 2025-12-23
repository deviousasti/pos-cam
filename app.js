// POS Cam - capture, atkinson dither, polaroid render
const elements = {
  video: document.getElementById('preview'),
  overlay: document.getElementById('videoOverlay'),
  capture: document.getElementById('captureButton'),
  fallbackButton: document.getElementById('androidFallbackButton'),
  fallbackInput: document.getElementById('androidFallbackInput'),
  status: document.getElementById('status'),
  locationStatus: document.getElementById('locationStatus'),
  output: document.getElementById('outputCanvas'),
  work: document.getElementById('workCanvas')
};

const frame = { padding: 12, bottom: 60 };

let stream = null;
let locationLabel = 'Location unavailable';
const log = (...args) => { 
    console.log('[POS Cam]', ...args);
    const logEntry = document.createElement('div');
    logEntry.textContent = `[POS Cam] ${args.join(' ')}`;
    document.getElementById('logs').appendChild(logEntry);
};

function setStatus(message, tone = 'info') {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
  log('Status update', { tone, message });
}

function setLocationStatus(message, tone = 'info') {
  if (!elements.locationStatus) return;
  elements.locationStatus.textContent = message;
  elements.locationStatus.dataset.tone = tone;
  log('Location status update', { tone, message });
}

function clamp(value) {
  return Math.max(0, Math.min(255, value));
}

function atkinsonDither(imageData, width, height) {
  const data = imageData.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const avg = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      const newVal = avg <= 128 ? 0 : 255;
      const error = avg - newVal;

      data[idx] = data[idx + 1] = data[idx + 2] = newVal;
      data[idx + 3] = 255;

      const diff = error / 8;
      // Distribute the error to neighbors
      distribute(x + 1, y, diff);
      distribute(x + 2, y, diff);
      distribute(x - 1, y + 1, diff);
      distribute(x, y + 1, diff);
      distribute(x + 1, y + 1, diff);
      distribute(x, y + 2, diff);
    }
  }

  function distribute(nx, ny, value) {
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
    const nIdx = (ny * width + nx) * 4;
    data[nIdx] = clamp(data[nIdx] + value);
    data[nIdx + 1] = clamp(data[nIdx + 1] + value);
    data[nIdx + 2] = clamp(data[nIdx + 2] + value);
  }
}

function formatDate() {
  const now = new Date();
  return now.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatLocation(position) {
  if (!position) return 'Location unavailable';
  const { latitude, longitude } = position.coords;
  return `Lat ${latitude.toFixed(4)}  Lon ${longitude.toFixed(4)}`;
}

async function locateUser() {
  log('locateUser invoked');
  if (!navigator.geolocation) {
    setLocationStatus('Geolocation unsupported; location will be empty.', 'warn');
    setStatus('Geolocation unsupported; location will be empty.', 'warn');
    return;
  }
  setLocationStatus('Requesting location…');
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => {
        locationLabel = formatLocation(pos);
        log('Location acquired', locationLabel);
        setLocationStatus(`Location tagged: ${locationLabel}`);
        resolve();
      },
      err => {
        log('Location error', err);
        const message = `Location unavailable (${err.code})`;
        setLocationStatus(message, 'warn');
        setStatus(message, 'warn');
        resolve();
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

async function initCamera() {
  log('initCamera invoked');
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Camera not supported in this browser. Use Android backup capture below.', 'warn');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    log('Camera stream obtained', stream?.getVideoTracks()?.[0]?.label || 'unknown track');
    elements.video.srcObject = stream;
    elements.video.onloadedmetadata = () => {
      log('Video metadata loaded', { width: elements.video.videoWidth, height: elements.video.videoHeight });
      elements.video.play();
      elements.overlay.textContent = '';
      setStatus('Camera ready.');
    };
  } catch (err) {
    log('Camera init failed', err);
    setStatus('Camera access denied or unavailable. Use Android backup capture below.', 'error');
  }
}

function captureFrame() {
  if (!elements.video.videoWidth) {
    setStatus('Camera not ready yet.', 'warn');
    return null;
  }
  const { videoWidth: w, videoHeight: h } = elements.video;
  log('Capturing frame', { width: w, height: h });
  return processDrawable(elements.video, w, h);
}

function processDrawable(drawable, width, height) {
  log('Processing drawable', { width, height, tag: drawable.tagName || 'media' });
  elements.work.width = width;
  elements.work.height = height;
  const ctx = elements.work.getContext('2d');
  ctx.drawImage(drawable, 0, 0, width, height);
  const imgData = ctx.getImageData(0, 0, width, height);
  atkinsonDither(imgData, width, height);
  ctx.putImageData(imgData, 0, 0);
  return { canvas: elements.work, width, height };
}

function renderPolaroid(source) {
  const photoWidth = 440;
  const photoHeight = Math.round((photoWidth / source.width) * source.height);

  const canvasWidth = photoWidth + frame.padding * 2;
  const canvasHeight = photoHeight + frame.padding * 2 + frame.bottom;

  log('Rendering polaroid', { sourceWidth: source.width, sourceHeight: source.height, canvasWidth, canvasHeight });

  elements.output.width = canvasWidth;
  elements.output.height = canvasHeight;
  const ctx = elements.output.getContext('2d');

  ctx.fillStyle = '#fdfdf8';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  ctx.drawImage(source.canvas, frame.padding, frame.padding, photoWidth, photoHeight);

  ctx.fillStyle = '#111';
  ctx.font = '12px "Press Start 2P", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const centerX = canvasWidth / 2;
  const textY = photoHeight + frame.padding + 18;
  ctx.fillText(formatDate(), centerX, textY);
  ctx.fillText(locationLabel, centerX, textY + 20);
}

function downloadPolaroid() {
  if (!elements.output.width || !elements.output.height) return;
  try {
    log('Preparing download', { width: elements.output.width, height: elements.output.height });
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = elements.output.toDataURL('image/png');
    link.download = `pos-cam-${timestamp}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (err) {
    log('Download failed', err);
    setStatus('Unable to download image.', 'warn');
  }
}

function handleCapture() {
  log('handleCapture triggered');
  const source = captureFrame();
  if (!source) return;
  renderPolaroid(source);
  downloadPolaroid();
  setStatus('Captured. Downloading image.');
}

async function handleFallbackSelection(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  log('Fallback file selected', { name: file.name, type: file.type, size: file.size });
  setStatus('Processing uploaded capture…');
  try {
    const source = await prepareSourceFromFile(file);
    renderPolaroid(source);
    downloadPolaroid();
    setStatus('Uploaded capture processed.');
    log('Fallback capture processed');
  } catch (err) {
    log('Fallback processing failed', err);
    const message = err?.message || 'Unable to process selected file.';
    setStatus(message, 'error');
  }
}

function prepareSourceFromFile(file) {
  log('prepareSourceFromFile', file.type);
  if (file.type.startsWith('image/')) {
    return processImageFile(file);
  }
  if (file.type.startsWith('video/')) {
    return processVideoFile(file);
  }
  log('prepareSourceFromFile unsupported type', file.type);
  return Promise.reject(new Error('Unsupported file type.'));
}

function processImageFile(file) {
  return new Promise((resolve, reject) => {
    log('processImageFile started', file.name);
    const reader = new FileReader();
    reader.onerror = () => {
      log('processImageFile read error');
      reject(new Error('Unable to read image.'));
    };
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        log('processImageFile loaded', { width: img.naturalWidth, height: img.naturalHeight });
        resolve(processDrawable(img, img.naturalWidth, img.naturalHeight));
      };
      img.onerror = () => {
        log('processImageFile load error');
        reject(new Error('Image load failed.'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function processVideoFile(file) {
  return new Promise((resolve, reject) => {
    log('processVideoFile started', file.name);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const cleanup = () => {
      if (video.src) URL.revokeObjectURL(video.src);
    };

    video.onloadeddata = () => {
      if (!video.videoWidth || !video.videoHeight) {
        cleanup();
        reject(new Error('Video has no visual data.'));
        return;
      }
      log('processVideoFile loaded', { width: video.videoWidth, height: video.videoHeight });
      resolve(processDrawable(video, video.videoWidth, video.videoHeight));
      cleanup();
    };

    video.onerror = () => {
      log('processVideoFile load error');
      cleanup();
      reject(new Error('Video load failed.'));
    };

    video.src = URL.createObjectURL(file);
  });
}

function bindControls() {
  log('Binding controls');
  elements.capture.addEventListener('click', handleCapture);
  if (elements.fallbackButton && elements.fallbackInput) {
    elements.fallbackButton.addEventListener('click', () => {
      log('Fallback button clicked');
      elements.fallbackInput.click();
    });
    elements.fallbackInput.addEventListener('change', handleFallbackSelection);
  }
}

async function bootstrap() {
  log('Bootstrap starting');
  bindControls();
  await Promise.all([initCamera(), locateUser()]);
  log('Bootstrap complete');
}

document.addEventListener('DOMContentLoaded', bootstrap);
