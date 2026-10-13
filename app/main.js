import {
  FilesetResolver,
  HandLandmarker,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs';
import { DEFAULTS, WheelController, mix, toMotors } from './gestures.js';
import { MicrobitUart } from './bluetooth.js';

const MEDIAPIPE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const SEND_EVERY_MS = 60;     // ritmo de verificação do envio
const HEARTBEAT_MS = 200;     // reenvia o comando mesmo sem mudanças (o micro:bit pára ao fim de 600 ms)
const STALE_MS = 350;         // sem imagens novas há este tempo = parar
const ZERO = Object.freeze({ left: 0, right: 0 });

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'),
  overlay: $('overlay'),
  intro: $('intro'),
  warning: $('warning'),
  start: $('startButton'),
  introBt: $('introBtButton'),
  bt: $('btButton'),
  btLabel: $('btLabel'),
  distance: $('distance'),
  settingsButton: $('settingsButton'),
  settings: $('settings'),
  resetSettings: $('resetSettings'),
  steerCard: $('steerCard'),
  wheel: $('wheel'),
  steerText: $('steerText'),
  throttleCard: $('throttleCard'),
  gestureArrow: $('gestureArrow'),
  gestureText: $('gestureText'),
  barLeft: $('barLeft'),
  barRight: $('barRight'),
  stop: $('stopButton'),
  toast: $('toast'),
};

// ---------- Definições (guardadas no browser) ----------

const UI_DEFAULTS = { ...DEFAULTS, backCamera: false, showSkeleton: true };
const STORAGE_KEY = 'maqueen-gestos:settings:v3';

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const valid = Object.fromEntries(Object.entries(saved).filter(([k]) => k in UI_DEFAULTS));
    return { ...UI_DEFAULTS, ...valid };
  } catch {
    return { ...UI_DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // modo privado: as definições só duram esta sessão
  }
}

const controller = new WheelController(loadSettings());
const settings = controller.settings;  // o mesmo objeto: mudar aqui muda os gestos

const FORMAT = {
  maxSpeed: (v) => `${v}`,
  reverseSpeed: (v) => `${Math.round(v * 100)}%`,
  turnStrength: (v) => `${Math.round(v * 100)}%`,
  wheelDeadzone: (v) => `${v}°`,
  wheelMax: (v) => `${v}°`,
  reverseDrop: (v) => `${Math.round(v * 100)}%`,
};

function renderSettings() {
  for (const input of els.settings.querySelectorAll('input')) {
    if (input.type === 'checkbox') input.checked = Boolean(settings[input.name]);
    else input.value = settings[input.name];
  }
  for (const out of els.settings.querySelectorAll('output')) {
    out.textContent = FORMAT[out.dataset.for](settings[out.dataset.for]);
  }
}

for (const input of els.settings.querySelectorAll('input')) {
  input.addEventListener('input', () => {
    settings[input.name] = input.type === 'checkbox' ? input.checked : Number(input.value);
    renderSettings();
    saveSettings();
    if (input.name === 'backCamera' && running) startCamera().catch(showError);
  });
}

els.settingsButton.addEventListener('click', () => {
  renderSettings();
  els.settings.showModal();
});

els.resetSettings.addEventListener('click', () => {
  const cameraChanged = settings.backCamera !== UI_DEFAULTS.backCamera;
  Object.assign(settings, UI_DEFAULTS);
  renderSettings();
  saveSettings();
  if (cameraChanged && running) startCamera().catch(showError);
});

// ---------- Mensagens ----------

let toastTimer = 0;
function toast(message, ms = 4000) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function describeError(err) {
  if (!window.isSecureContext) {
    return 'Abre a app com https:// (ou em localhost): a câmara e o Bluetooth não funcionam de outra forma.';
  }
  switch (err?.name) {
    case 'NotAllowedError': return 'Não foi dada autorização. Permite o acesso nas definições do browser e tenta outra vez.';
    case 'NotFoundError': return 'Não foi encontrada nenhuma câmara.';
    case 'NotReadableError': return 'A câmara está a ser usada por outra app.';
    case 'NetworkError': return 'Falhou a ligação Bluetooth. Aproxima o carrinho e tenta outra vez.';
    default: return err?.message || String(err);
  }
}

function showError(err) {
  console.error(err);
  const message = describeError(err);
  if (els.intro.hidden) toast(message, 6000);
  else {
    els.warning.textContent = message;
    els.warning.hidden = false;
  }
}

if (!window.isSecureContext) {
  els.warning.textContent = describeError();
  els.warning.hidden = false;
} else if (!MicrobitUart.supported) {
  els.warning.textContent =
    'Este browser não tem Web Bluetooth. No Android usa o Chrome; no iPhone instala a app Bluefy. ' +
    'Podes experimentar os gestos na mesma.';
  els.warning.hidden = false;
}

// ---------- Câmara e deteção das mãos ----------

let landmarkerPromise = null;
let landmarker = null;
let stream = null;
let running = false;
let lastVideoTime = -1;
let lastFrameAt = 0;
let state = null;

function loadLandmarker() {
  landmarkerPromise ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: HAND_MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    try {
      return await HandLandmarker.createFromOptions(fileset, options('GPU'));
    } catch (err) {
      console.warn('GPU indisponível, a usar o CPU:', err);
      return HandLandmarker.createFromOptions(fileset, options('CPU'));
    }
  })().catch((err) => {
    landmarkerPromise = null;  // permite tentar outra vez
    throw err;
  });
  return landmarkerPromise;
}

async function startCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: settings.backCamera ? 'environment' : 'user',
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
  });
  els.video.srcObject = stream;
  els.video.classList.toggle('mirror', !settings.backCamera);
  await els.video.play();
}

els.start.addEventListener('click', async () => {
  els.start.disabled = true;
  els.warning.hidden = true;
  try {
    if (!window.isSecureContext) throw new Error('insecure');
    els.start.textContent = 'A ligar a câmara…';
    await startCamera();
    els.start.textContent = 'A carregar o modelo das mãos…';
    landmarker = await loadLandmarker();
    els.intro.hidden = true;
    running = true;
    requestWakeLock();
    requestAnimationFrame(loop);
  } catch (err) {
    showError(err);
    els.start.textContent = 'Tentar outra vez';
  } finally {
    els.start.disabled = false;
  }
});

function loop() {
  if (!running) return;
  const video = els.video;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const now = performance.now();
    const result = landmarker.detectForVideo(video, now);
    const hands = result.landmarks.map((landmarks, i) => ({
      landmarks,
      worldLandmarks: result.worldLandmarks[i],
      label: result.handedness[i]?.[0]?.categoryName,
    }));
    state = controller.update(hands, now, video.videoWidth / video.videoHeight);
    lastFrameAt = now;
    draw();
  }
  renderHud();
  requestAnimationFrame(loop);
}

// ---------- Desenho do esqueleto das mãos ----------

function draw() {
  const canvas = els.overlay;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!state) return;

  // O vídeo usa object-fit: cover, por isso é preciso a mesma escala e corte
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const scale = Math.max(w / vw, h / vh);
  const ox = (w - vw * scale) / 2;
  const oy = (h - vh * scale) / 2;
  const mirror = !settings.backCamera;
  const toScreen = (p) => [ox + (mirror ? 1 - p.x : p.x) * vw * scale, oy + p.y * vh * scale];

  if (settings.showSkeleton) {
    drawHand(ctx, state.hands.right, 'rgba(255, 255, 255, 0.7)', toScreen);
    drawHand(ctx, state.hands.left, 'rgba(255, 255, 255, 0.7)', toScreen);
  }
  drawWheel(ctx, state, toScreen, w);
}

const WHEEL_COLORS = {
  forward: '#34d399', reverse: '#f59e0b', brake: '#ef4444', calibrating: '#9aa6b2',
};

function drawWheel(ctx, state, toScreen, width) {
  const wheel = state.wheel;
  if (!wheel) return;
  const color = WHEEL_COLORS[state.gesture] ?? '#9aa6b2';

  // Linha de marcha-atrás: baixar o volante abaixo dela anda para trás
  if (wheel.reverseY !== null) {
    const [, y] = toScreen({ x: 0, y: wheel.reverseY });
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = state.gesture === 'reverse' ? '#f59e0b' : 'rgba(245, 158, 11, 0.55)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.restore();
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f59e0b';
    ctx.fillText('▼ marcha-atrás abaixo desta linha', 16, y - 8);
  }

  // O volante: um aro entre as duas mãos, com a barra que as une
  const [lx, ly] = toScreen(wheel.left);
  const [rx, ry] = toScreen(wheel.right);
  const cx = (lx + rx) / 2;
  const cy = (ly + ry) / 2;
  const radius = Math.hypot(rx - lx, ry - ly) / 2;
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(lx, ly);
  ctx.lineTo(rx, ry);
  // Raio de baixo, perpendicular à barra: roda com o volante
  const len = Math.max(1, 2 * radius) * Math.sign(rx - lx || 1);
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx - ((ry - ly) / len) * radius, cy + ((rx - lx) / len) * radius);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, 12, 0, Math.PI * 2);
  ctx.fill();
}

function drawHand(ctx, hand, color, toScreen) {
  if (!hand) return;
  const pts = hand.landmarks.map(toScreen);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(...pts[a]);
    ctx.lineTo(...pts[b]);
  }
  ctx.stroke();
  for (const [x, y] of pts) {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- Painel ----------

function setBar(el, value) {
  const pct = Math.min(50, (Math.abs(value) / 255) * 50);
  el.style.height = `${pct}%`;
  el.style.top = value >= 0 ? `${50 - pct}%` : '50%';
  el.style.background = value >= 0 ? 'var(--fwd)' : 'var(--back)';
}

function steerLabel({ steer, angle }) {
  if (steer > 0.02) return `direita ${Math.round(angle)}°`;
  if (steer < -0.02) return `esquerda ${Math.round(-angle)}°`;
  return 'em frente';
}

function renderHud() {
  const now = performance.now();
  const motors = currentMotors(now);
  setBar(els.barLeft, motors.left);
  setBar(els.barRight, motors.right);

  const fresh = state && now - lastFrameAt < STALE_MS ? state : null;
  const wheel = fresh?.wheel;
  els.steerCard.classList.toggle('active', Boolean(wheel));
  els.wheel.style.transform = `rotate(${wheel ? wheel.angle : 0}deg)`;
  els.steerText.textContent = wheel ? steerLabel(wheel) : 'sem volante';

  const gesture = paused ? 'paused' : fresh?.gesture ?? 'none';
  const [arrow, cls, text] = GESTURE_DISPLAY[gesture];
  els.throttleCard.classList.toggle('active', gesture !== 'none' && gesture !== 'paused');
  els.gestureArrow.textContent = arrow;
  els.gestureArrow.className = `gesture-arrow${cls ? ` ${cls}` : ''}`;
  els.gestureText.textContent = text;
}

const GESTURE_DISPLAY = {
  paused: ['■', 'halt', 'em pausa'],
  none: ['•', '', 'mostra as duas mãos'],
  'one-hand': ['•', '', 'falta uma mão'],
  calibrating: ['•', '', 'segura o volante…'],
  brake: ['■', 'halt', 'travão'],
  forward: ['▲', 'fwd', 'frente'],
  reverse: ['▼', 'back', 'marcha-atrás'],
};

// ---------- Comandos para o carrinho ----------

let paused = false;
const keys = new Set();

function keyboardMotors() {
  const throttle = (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0);
  const steer = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
  if (!throttle && !steer) return null;
  return toMotors(mix(throttle, steer, { ...settings, spinInPlace: true }), settings.maxSpeed);
}

function currentMotors(now) {
  if (paused) return ZERO;
  const fromKeys = keyboardMotors();
  if (fromKeys) return fromKeys;
  if (!running || !state || now - lastFrameAt > STALE_MS) return ZERO;
  return state.motors;
}

const uart = new MicrobitUart();
let sent = { left: null, right: null, at: 0 };

setInterval(() => {
  if (!uart.connected) return;
  const now = performance.now();
  const { left, right } = currentMotors(now);
  if (left === sent.left && right === sent.right && now - sent.at < HEARTBEAT_MS) return;
  uart.send(left === 0 && right === 0 ? 'S' : `M${left},${right}`);
  sent = { left, right, at: now };
}, SEND_EVERY_MS);

function setPaused(value) {
  paused = value;
  els.stop.textContent = paused ? 'RETOMAR' : 'PARAR';
  els.stop.classList.toggle('paused', paused);
  if (paused) {
    controller.reset();
    if (uart.connected) uart.send('S');
  }
}

els.stop.addEventListener('click', () => setPaused(!paused));

window.addEventListener('keydown', (e) => {
  if (els.settings.open) return;
  if (e.key.startsWith('Arrow')) {
    keys.add(e.key);
    e.preventDefault();
  } else if (e.key === ' ') {
    setPaused(!paused);
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key));
window.addEventListener('blur', () => keys.clear());

// ---------- Bluetooth ----------

async function toggleBluetooth() {
  if (!MicrobitUart.supported) {
    showError(new Error('Este browser não tem Web Bluetooth. No Android usa o Chrome; no iPhone usa a app Bluefy.'));
    return;
  }
  if (uart.connected) {
    await uart.disconnect();
    return;
  }
  try {
    await uart.connect();
  } catch (err) {
    if (err.name !== 'NotFoundError') showError(err);  // NotFoundError = janela fechada sem escolher
    renderBluetooth('desligado');
  }
}

function renderBluetooth(status) {
  const connected = status === 'ligado';
  els.bt.classList.toggle('connected', connected);
  els.bt.classList.toggle('busy', status === 'a ligar');
  els.btLabel.textContent = connected ? (uart.name || 'Ligado')
    : status === 'a ligar' ? 'A ligar…'
    : 'Ligar carrinho';
  els.introBt.textContent = connected ? `Ligado a ${uart.name || 'micro:bit'}` : 'Ligar carrinho';
  if (!connected) els.distance.hidden = true;
  if (connected) toast('Carrinho ligado!', 2000);
}

function renderDistance(cm) {
  els.distance.hidden = false;
  els.distance.textContent = cm > 0 ? `${cm} cm` : '— cm';
  els.distance.classList.toggle('near', cm > 0 && cm < 10);
}

els.bt.addEventListener('click', toggleBluetooth);
els.introBt.addEventListener('click', toggleBluetooth);
uart.addEventListener('status', (e) => renderBluetooth(e.detail));
uart.addEventListener('distance', (e) => renderDistance(e.detail));

// ---------- Ecrã sempre ligado e segurança ----------

let wakeLock = null;
async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // não é essencial
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (uart.connected) uart.send('S');
  } else if (running) {
    requestWakeLock();
  }
});

// Começa já a descarregar o modelo para estar pronto quando se carregar no botão
if (window.isSecureContext) loadLandmarker().catch((err) => console.warn('Modelo ainda não carregou:', err));
renderSettings();
