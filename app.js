// POS Cam - capture, atkinson dither, polaroid render
const elements = {
  video: document.getElementById('preview'),
  overlay: document.getElementById('videoOverlay'),
  capture: document.getElementById('captureButton'),
  retake: document.getElementById('retakeButton'),
  status: document.getElementById('status'),
  output: document.getElementById('outputCanvas'),
  work: document.getElementById('workCanvas')
};

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
    setStatus('Camera not supported in this browser.', 'warn');
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
    setStatus('Camera access denied or unavailable.', 'error');
  }
}

function captureFrame() {
  if (!elements.video.videoWidth) {
    setStatus('Camera not ready yet.', 'warn');
    return null;
  }
  const { videoWidth: w, videoHeight: h } = elements.video;
  elements.work.width = w;
  elements.work.height = h;
  const ctx = elements.work.getContext('2d');
  ctx.drawImage(elements.video, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  atkinsonDither(imgData, w, h);
  ctx.putImageData(imgData, 0, 0);
  return { canvas: elements.work, width: w, height: h };
}

function renderPolaroid(source) {
  const photoWidth = 440;
  const photoHeight = Math.round((photoWidth / source.width) * source.height);
  const frame = { padding: 24, bottom: 120 };
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

function clearOutput() {
  elements.output.getContext('2d').clearRect(0, 0, elements.output.width, elements.output.height);
}

async function handleCapture() {
  const source = captureFrame();
  if (!source) return;
  renderPolaroid(source);
  elements.retake.disabled = false;
  setStatus('Captured. You can retake.');
}

function handleRetake() {
  clearOutput();
  elements.retake.disabled = true;
  setStatus('Ready for another capture.');
}

function bindControls() {
  elements.capture.addEventListener('click', handleCapture);
  elements.retake.addEventListener('click', handleRetake);
}

async function bootstrap() {
  bindControls();
  await Promise.all([initCamera(), locateUser()]);
}

document.addEventListener('DOMContentLoaded', bootstrap);
