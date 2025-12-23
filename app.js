// POS Cam - capture, atkinson dither, polaroid render
const elements = {
  video: document.getElementById('preview'),
  overlay: document.getElementById('videoOverlay'),
  capture: document.getElementById('captureButton'),
  fallbackButton: document.getElementById('androidFallbackButton'),
  fallbackInput: document.getElementById('androidFallbackInput'),
  status: document.getElementById('status'),
  output: document.getElementById('outputCanvas'),
  work: document.getElementById('workCanvas')
};

const frame = { padding: 12, bottom: 60 };

let stream = null;
let locationLabel = 'Location unavailable';

function setStatus(message, tone = 'info') {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
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
  if (!navigator.geolocation) {
    setStatus('Geolocation unsupported; location will be empty.', 'warn');
    return;
  }
  setStatus('Requesting location…');
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => {
        locationLabel = formatLocation(pos);
        setStatus('Location locked.');
        resolve();
      },
      err => {
        setStatus(`Location unavailable (${err.code})`, 'warn');
        resolve();
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

async function initCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('Camera not supported in this browser. Use Android backup capture below.', 'warn');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    elements.video.srcObject = stream;
    elements.video.onloadedmetadata = () => {
      elements.video.play();
      elements.overlay.textContent = '';
      setStatus('Camera ready.');
    };
  } catch (err) {
    setStatus('Camera access denied or unavailable. Use Android backup capture below.', 'error');
  }
}

function captureFrame() {
  if (!elements.video.videoWidth) {
    setStatus('Camera not ready yet.', 'warn');
    return null;
  }
  const { videoWidth: w, videoHeight: h } = elements.video;
  return processDrawable(elements.video, w, h);
}

function processDrawable(drawable, width, height) {
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
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = elements.output.toDataURL('image/png');
    link.download = `pos-cam-${timestamp}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (err) {
    setStatus('Unable to download image.', 'warn');
  }
}

function handleCapture() {
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
  setStatus('Processing uploaded capture…');
  try {
    const source = await prepareSourceFromFile(file);
    renderPolaroid(source);
    downloadPolaroid();
    setStatus('Uploaded capture processed.');
  } catch (err) {
    const message = err?.message || 'Unable to process selected file.';
    setStatus(message, 'error');
  }
}

function prepareSourceFromFile(file) {
  if (file.type.startsWith('image/')) {
    return processImageFile(file);
  }
  if (file.type.startsWith('video/')) {
    return processVideoFile(file);
  }
  return Promise.reject(new Error('Unsupported file type.'));
}

function processImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read image.'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(processDrawable(img, img.naturalWidth, img.naturalHeight));
      img.onerror = () => reject(new Error('Image load failed.'));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function processVideoFile(file) {
  return new Promise((resolve, reject) => {
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
      resolve(processDrawable(video, video.videoWidth, video.videoHeight));
      cleanup();
    };

    video.onerror = () => {
      cleanup();
      reject(new Error('Video load failed.'));
    };

    video.src = URL.createObjectURL(file);
  });
}

function bindControls() {
  elements.capture.addEventListener('click', handleCapture);
  if (elements.fallbackButton && elements.fallbackInput) {
    elements.fallbackButton.addEventListener('click', () => elements.fallbackInput.click());
    elements.fallbackInput.addEventListener('change', handleFallbackSelection);
  }
}

async function bootstrap() {
  bindControls();
  await Promise.all([initCamera(), locateUser()]);
}

document.addEventListener('DOMContentLoaded', bootstrap);
