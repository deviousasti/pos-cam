// POS Cam - capture, atkinson dither, polaroid render
const elements = {
  video: document.getElementById('preview'),
  previewContainer: document.querySelector('.preview'),
  overlay: document.getElementById('videoOverlay'),
  capture: document.getElementById('captureButton'),
  fallbackButton: document.getElementById('androidFallbackButton'),
  fallbackInput: document.getElementById('androidFallbackInput'),
  status: document.getElementById('status'),
  locationStatus: document.getElementById('locationStatus'),
  exposureSlider: document.getElementById('exposureSlider'),
  exposureValue: document.getElementById('exposureValue'),
  contrastSlider: document.getElementById('contrastSlider'),
  contrastValue: document.getElementById('contrastValue'),
  output: document.getElementById('outputCanvas'),
  work: document.getElementById('workCanvas')
};

const frame = { padding: 12, bottom: 60 };
const typography = {
  captionFont: '14px "Press Start 2P", monospace',
  quoteFont: '18px "Press Start 2P", monospace',
  captionLineHeight: 24,
  quoteLineHeight: 22,
  quoteBlockPadding: { top: 10, bottom: 12 }
};
const measureCanvas = document.createElement('canvas');
const measureContext = measureCanvas.getContext('2d');

let stream = null;
let locationLabel = 'Location unavailable';
let exposureFactor = 1;
let contrastFactor = 1;
let videoDevices = [];
let currentDeviceIndex = 0;
let isCyclingCamera = false;
let quotes = [];
let lastQuote = '';
const log = (...args) => { 
    console.log('[POS Cam]', ...args);
    const logEntry = document.createElement('div');
    logEntry.textContent = `[POS Cam] ${args.join(' ')}`;
    document.getElementById('logs').appendChild(logEntry);
};

function stopCurrentStream() {
  if (!stream) return;
  stream.getTracks().forEach(track => track.stop());
}

async function refreshVideoDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    videoDevices = [];
    updatePreviewCycleState();
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter(device => device.kind === 'videoinput');
    log('Camera devices detected', videoDevices.map(device => device.label || device.deviceId));
  } catch (err) {
    log('enumerateDevices failed', err);
    videoDevices = [];
  }
  updatePreviewCycleState();
}

function updatePreviewCycleState() {
  if (!elements.previewContainer) return;
  const hasMultiple = videoDevices.length > 1;
  elements.previewContainer.classList.toggle('preview--cycle', hasMultiple);
  if (hasMultiple) {
    elements.previewContainer.setAttribute('title', 'Tap preview to switch cameras');
    elements.previewContainer.setAttribute('aria-label', 'Camera preview. Tap to switch cameras.');
    elements.previewContainer.tabIndex = 0;
  } else {
    elements.previewContainer.removeAttribute('title');
    elements.previewContainer.setAttribute('aria-label', 'Camera preview');
    elements.previewContainer.removeAttribute('tabindex');
  }
}

function extractDeviceId(mediaStream) {
  if (!mediaStream) return undefined;
  const [track] = mediaStream.getVideoTracks();
  if (!track || typeof track.getSettings !== 'function') return undefined;
  const settings = track.getSettings();
  return settings?.deviceId;
}

function syncCurrentDeviceIndex(activeDeviceId) {
  if (!activeDeviceId) return;
  const nextIndex = videoDevices.findIndex(device => device.deviceId === activeDeviceId);
  if (nextIndex >= 0) {
    currentDeviceIndex = nextIndex;
  }
}

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

async function loadQuotes() {
  try {
    const response = await fetch('fortunes.json', { cache: 'force-cache' });
    if (!response.ok) {
      throw new Error(`Quote request failed with ${response.status}`);
    }
    const data = await response.json();
    const incoming = Array.isArray(data?.quotes) ? data.quotes : [];
    quotes = incoming.filter(entry => typeof entry === 'string' && entry.trim().length);
    log('Quote list ready', quotes.length);
  } catch (err) {
    quotes = [];
    log('Quote load failed', err);
  }
}

function getRandomQuote() {
  if (!quotes.length) return '';
  if (quotes.length === 1) {
    lastQuote = quotes[0];
    return lastQuote;
  }
  let next = quotes[Math.floor(Math.random() * quotes.length)];
  if (next === lastQuote) {
    const idx = quotes.indexOf(next);
    next = quotes[(idx + 1) % quotes.length];
  }
  lastQuote = next;
  return next;
}

function getQuoteLines(text, font, maxWidth) {
  const content = typeof text === 'string' ? text.trim() : '';
  if (!content) return [];
  measureContext.font = font;
  const words = content.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureContext.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

function clamp(value) {
  return Math.max(0, Math.min(255, value));
}

function applyExposure(imageData, factor) {
  if (factor === 1) return;
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp(data[i] * factor);
    data[i + 1] = clamp(data[i + 1] * factor);
    data[i + 2] = clamp(data[i + 2] * factor);
  }
}

function applyContrast(imageData, factor) {
  if (factor === 1) return;
  const data = imageData.data;
  const midpoint = 128;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp((data[i] - midpoint) * factor + midpoint);
    data[i + 1] = clamp((data[i + 1] - midpoint) * factor + midpoint);
    data[i + 2] = clamp((data[i + 2] - midpoint) * factor + midpoint);
  }
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

async function initCamera(deviceId) {
  log('initCamera invoked', deviceId ? { deviceId } : undefined);
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Camera not supported in this browser. Use Android backup capture below.', 'warn');
    return false;
  }
  const videoConstraints = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' };
  try {
    const nextStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
    stopCurrentStream();
    stream = nextStream;
    log('Camera stream obtained', stream?.getVideoTracks()?.[0]?.label || 'unknown track');
    elements.video.srcObject = stream;
    elements.video.onloadedmetadata = () => {
      log('Video metadata loaded', { width: elements.video.videoWidth, height: elements.video.videoHeight });
      elements.video.play();
      elements.overlay.textContent = '';
      const readyMessage = videoDevices.length > 1 ? 'Tap to switch cameras.' : 'Camera ready.';
      setStatus(readyMessage);
      setTimeout(() => { setStatus(""); }, 1000);
    };
    const activeDeviceId = extractDeviceId(nextStream);
    await refreshVideoDevices();
    syncCurrentDeviceIndex(activeDeviceId);
    return true;
  } catch (err) {
    log('Camera init failed', err);
    setStatus('Camera access denied or unavailable. Use Android backup capture below.', 'error');
    return false;
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
  applyExposure(imgData, exposureFactor);
  applyContrast(imgData, contrastFactor);
  atkinsonDither(imgData, width, height);
  ctx.putImageData(imgData, 0, 0);
  return { canvas: elements.work, width, height };
}

function renderPolaroid(source, quoteText = '') {
  const photoWidth = 440;
  const photoHeight = Math.round((photoWidth / source.width) * source.height);
  const quoteLines = getQuoteLines(quoteText, typography.quoteFont, photoWidth - 24);
  const quotePadding = quoteLines.length
    ? typography.quoteLineHeight * quoteLines.length + typography.quoteBlockPadding.top + typography.quoteBlockPadding.bottom
    : 0;

  const canvasWidth = photoWidth + frame.padding * 2;
  const canvasHeight = photoHeight + frame.padding * 2 + frame.bottom + quotePadding;

  log('Rendering polaroid', {
    sourceWidth: source.width,
    sourceHeight: source.height,
    canvasWidth,
    canvasHeight,
    quoteLines: quoteLines.length
  });

  elements.output.width = canvasWidth;
  elements.output.height = canvasHeight;
  const ctx = elements.output.getContext('2d');

  ctx.fillStyle = '#fdfdf8';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  ctx.drawImage(source.canvas, frame.padding, frame.padding, photoWidth, photoHeight);

  ctx.fillStyle = '#111';
  ctx.font = '16px "Press Start 2P", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const centerX = canvasWidth / 2;
  let textY = photoHeight + frame.padding + 18;

  ctx.font = typography.captionFont;
  ctx.fillText(formatDate(), centerX, textY);
  textY += typography.captionLineHeight;
  ctx.fillText(locationLabel, centerX, textY);

  ctx.font = '10px "Press Start 2P", monospace';
  if (quoteLines.length) {
    ctx.font = typography.quoteFont;
    const quoteAreaTop = canvasHeight - quotePadding + typography.quoteBlockPadding.top;
    textY = Math.max(textY + 10, quoteAreaTop);
    quoteLines.forEach(line => {
      ctx.fillText(line, centerX, textY);
      textY += typography.quoteLineHeight;
    });
  }
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
  renderPolaroid(source, getRandomQuote());
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
    renderPolaroid(source, getRandomQuote());
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

function updateExposureDisplay(value) {
  if (!elements.exposureValue) return;
  elements.exposureValue.textContent = `${value.toFixed(1)}x`;
}

function handleExposureChange(event) {
  const value = parseFloat(event.target.value);
  if (Number.isNaN(value)) return;
  exposureFactor = value;
  updateExposureDisplay(value);
  log('Exposure adjusted', value);
}

function updateContrastDisplay(value) {
  if (!elements.contrastValue) return;
  elements.contrastValue.textContent = `${value.toFixed(1)}x`;
}

function handleContrastChange(event) {
  const value = parseFloat(event.target.value);
  if (Number.isNaN(value)) return;
  contrastFactor = value;
  updateContrastDisplay(value);
  log('Contrast adjusted', value);
}

function handlePreviewClick(event) {
  if (event) {
    event.preventDefault();
  }
  cycleCamera();
}

function handlePreviewKeydown(event) {
  if (!event) return;
  const activateKeys = ['Enter', ' ', 'Spacebar'];
  if (!activateKeys.includes(event.key)) return;
  event.preventDefault();
  cycleCamera();
}

async function cycleCamera() {
  if (isCyclingCamera) {
    log('Camera cycle ignored; already switching');
    return;
  }
  if (!stream) {
    log('Camera cycle skipped; stream not initialized');
    return;
  }
  if (videoDevices.length <= 1) {
    log('Camera cycle skipped; insufficient devices');
    if (!videoDevices.length) {
      setStatus('Multiple cameras not detected on this device.', 'warn');
    }
    return;
  }
  isCyclingCamera = true;
  const nextIndex = (currentDeviceIndex + 1) % videoDevices.length;
  const nextDevice = videoDevices[nextIndex];
  const label = nextDevice?.label || `Camera ${nextIndex + 1}`;
  setStatus(`Switching to ${label}…`);
  const switched = await initCamera(nextDevice.deviceId);
  if (switched) {
    setStatus(`Using ${label}. Tap preview to switch.`);
  } else {
    setStatus('Unable to switch camera.', 'error');
  }
  isCyclingCamera = false;
}

function bindControls() {
  log('Binding controls');
  updatePreviewCycleState();
  if (elements.previewContainer) {
    elements.previewContainer.addEventListener('click', handlePreviewClick);
    elements.previewContainer.addEventListener('keydown', handlePreviewKeydown);
  }
  elements.capture.addEventListener('click', handleCapture);
  if (elements.fallbackButton && elements.fallbackInput) {
    elements.fallbackButton.addEventListener('click', () => {
      log('Fallback button clicked');
      elements.fallbackInput.click();
    });
    elements.fallbackInput.addEventListener('change', handleFallbackSelection);
  }
  if (elements.exposureSlider) {
    const initial = parseFloat(elements.exposureSlider.value) || 1;
    exposureFactor = initial;
    updateExposureDisplay(initial);
    elements.exposureSlider.addEventListener('input', handleExposureChange);
  }
  if (elements.contrastSlider) {
    const initialContrast = parseFloat(elements.contrastSlider.value) || 1;
    contrastFactor = initialContrast;
    updateContrastDisplay(initialContrast);
    elements.contrastSlider.addEventListener('input', handleContrastChange);
  }
}

async function bootstrap() {
  log('Bootstrap starting');
  bindControls();
  await Promise.all([initCamera(), locateUser(), loadQuotes()]);
  log('Bootstrap complete');
}

document.addEventListener('DOMContentLoaded', bootstrap);
