// Testes da lógica dos gestos com mãos sintéticas: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WheelController, assignHands, fingerOpenness, mix, palmCenter, toMotors, wheelAngle,
} from '../app/gestures.js';

const FPS = 30;
const DT = 1000 / FPS;
const ASPECT = 4 / 3;

// Mão em coordenadas "canónicas": pulso na origem, dedos para cima (-y).
// Para a mão direita com a palma virada para a câmara, o polegar fica à direita da imagem.
const BASES = { 1: [0.35, -0.15], 5: [0.25, -0.8], 9: [0, -0.85], 13: [-0.2, -0.8], 17: [-0.4, -0.7] };
const LENGTHS = { 1: 0.6, 5: 0.9, 9: 1.0, 13: 0.9, 17: 0.7 };

function canonicalHand(openness) {
  const pts = [{ x: 0, y: 0, z: 0 }];
  for (const [base, [bx, by]] of Object.entries(BASES)) {
    const b = Number(base);
    const finger = b === 1 ? 0 : [5, 9, 13, 17].indexOf(b);
    const open = b === 1 ? 1 : openness[finger];
    const curl = (1 - open) * Math.PI * 0.85;
    const len = LENGTHS[b];
    pts[b] = { x: bx, y: by, z: 0 };
    for (let j = 1; j <= 3; j++) {
      const a = (curl * j) / 3;
      pts[b + j] = { x: bx, y: by - (len * j / 3) * Math.cos(a), z: -(len * j / 3) * Math.sin(a) };
    }
  }
  return pts;
}

// side: 'right' | 'left' (mão do utilizador). (cx, cy) é a posição do pulso.
function makeHand({ side = 'right', cx = 0.3, cy = 0.5, scale = 0.12, open = 1 } = {}) {
  const openness = Array.isArray(open) ? open : [open, open, open, open];
  const canon = canonicalHand(openness);
  const mirror = side === 'left' ? -1 : 1;
  const landmarks = canon.map(({ x, y, z }) => ({ x: cx + x * mirror * scale / ASPECT, y: cy + y * scale, z: z * scale }));
  const worldLandmarks = canon.map(({ x, y, z }) => ({ x: x * mirror * 0.08, y: y * 0.08, z: z * 0.08 }));
  return { landmarks, worldLandmarks };
}

// Volante: duas mãos à volta de (0.5, cy), rodado `angle` graus (positivo = para a direita)
function wheel({ angle = 0, cy = 0.55, open = 1, openLeft = open, openRight = open, jitter = 0 } = {}) {
  const r = 0.2;
  const a = angle * Math.PI / 180;
  const j = () => (Math.random() - 0.5) * jitter;
  // No referencial do utilizador a mão direita está em +x; na imagem fica à esquerda (x menor)
  const right = makeHand({ side: 'right', cx: 0.5 - (r * Math.cos(a)) / ASPECT + j(), cy: cy + r * Math.sin(a) + j(), open: openRight });
  const left = makeHand({ side: 'left', cx: 0.5 + (r * Math.cos(a)) / ASPECT + j(), cy: cy - r * Math.sin(a) + j(), open: openLeft });
  return [left, right];
}

function run(ctrl, frames, frame, t0 = 0) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    const t = t0 + i * DT;
    out.push({ t, ...ctrl.update(frame(i, t), t, ASPECT) });
  }
  return out;
}

// Volante quieto 0.6 s (marca a altura normal) e depois segue `after(i)`
const calibrated = (after) => (i, t) => (i < 18 ? wheel() : after(i - 18, t));
const stopped = (o) => o.motors.left === 0 && o.motors.right === 0;

test('fingerOpenness distingue mão aberta de punho', () => {
  const open = fingerOpenness(makeHand({ open: 1 }).worldLandmarks);
  const fist = fingerOpenness(makeHand({ open: 0 }).worldLandmarks);
  open.forEach((v) => assert.ok(v > 0.8, `aberta: ${v}`));
  fist.forEach((v) => assert.ok(v < 0.2, `punho: ${v}`));
});

test('assignHands decide pela posição; com uma só mão não há volante', () => {
  const [l, r] = wheel();
  assert.deepEqual(assignHands([l, r]), { left: l, right: r });
  assert.deepEqual(assignHands([r, l]), { left: l, right: r });
  assert.deepEqual(assignHands([r]), { left: null, right: null });
});

test('wheelAngle mede a rotação do volante', () => {
  for (const angle of [0, 20, -35]) {
    const [l, r] = wheel({ angle });
    assert.ok(Math.abs(wheelAngle(l, r, ASPECT) - angle) < 2, `${angle}: ${wheelAngle(l, r, ASPECT)}`);
  }
  assert.ok(palmCenter(wheel()[1].landmarks).x < 0.5, 'a mão direita aparece à esquerda da imagem');
});

test('toMotors: velocidade mínima para o motor rodar', () => {
  assert.deepEqual(toMotors({ left: 0, right: 0 }, 160), { left: 0, right: 0 });
  assert.deepEqual(toMotors({ left: 1, right: -1 }, 160), { left: 160, right: -160 });
  const slow = toMotors({ left: 0.1, right: -0.1 }, 160);
  assert.ok(slow.left >= 30 && slow.right <= -30);
});

test('mix: frente, curva e rodar no sítio', () => {
  assert.deepEqual(mix(1, 0), { left: 1, right: 1 });
  const curve = mix(1, 1, { turnStrength: 0.5 });
  assert.equal(curve.left, 1);
  assert.ok(Math.abs(curve.right - 1 / 3) < 1e-9);
  assert.equal(mix(1, 1, { turnStrength: 1 }).right, 0);
  assert.deepEqual(mix(0, 1), { left: 0, right: 0 });
  const spin = mix(0, 1, { spinInPlace: true });
  assert.ok(spin.left > 0 && spin.right < 0);
});

test('agarrar o volante: primeiro calibra, depois anda para a frente com as mãos abertas', () => {
  const ctrl = new WheelController();
  const out = run(ctrl, 60, () => wheel());
  assert.equal(out[3].gesture, 'calibrating');
  assert.ok(stopped(out[3]));
  assert.equal(out.at(-1).gesture, 'forward');
  assert.deepEqual(out.at(-1).motors, { left: 160, right: 160 });
});

test('mãos fechadas travam', () => {
  const ctrl = new WheelController();
  const out = run(ctrl, 90, calibrated((i) => wheel({ open: i < 30 ? 1 : 0 })));
  assert.ok(out[18 + 25].motors.left > 100, 'andava');
  assert.equal(out.at(-1).gesture, 'brake');
  assert.ok(stopped(out.at(-1)));
});

test('basta uma mão fechada para travar', () => {
  const ctrl = new WheelController();
  const out = run(ctrl, 60, calibrated(() => wheel({ openLeft: 0 })));
  assert.ok(stopped(out.at(-1)));
});

test('rodar o volante para a direita vira à direita, de forma suave', () => {
  const ctrl = new WheelController();
  const out = run(ctrl, 70, calibrated(() => wheel({ angle: 45 })));
  const { motors, steer } = out.at(-1);
  assert.ok(steer > 0.9, `steer ${steer}`);
  assert.ok(motors.left > motors.right, 'roda esquerda mais rápida = vira à direita');
  assert.ok(motors.right > 0, 'a roda de dentro continua a andar');
});

test('rodar para a esquerda vira à esquerda; pouco rodado anda a direito', () => {
  const ctrl = new WheelController();
  const out = run(ctrl, 70, calibrated(() => wheel({ angle: -30 })));
  assert.ok(out.at(-1).motors.right > out.at(-1).motors.left);
  const ctrl2 = new WheelController();
  const straight = run(ctrl2, 70, calibrated(() => wheel({ angle: 4 })));
  assert.equal(straight.at(-1).motors.left, straight.at(-1).motors.right);
});

test('baixar o volante com as mãos abertas anda para trás', () => {
  const ctrl = new WheelController();
  const out = run(ctrl, 90, calibrated((i) => wheel({ cy: 0.55 + 0.22 * Math.min(1, i / 9) })));
  assert.equal(out.at(-1).gesture, 'reverse');
  assert.ok(out.at(-1).motors.left < -60 && out.at(-1).motors.right < -60);
});

test('rodar o volante não liga a marcha-atrás', () => {
  const ctrl = new WheelController();
  const out = run(ctrl, 90, calibrated((i) => wheel({ angle: 50 * Math.sin(i / 8) })));
  assert.ok(out.slice(18).every((o) => o.gesture === 'forward'));
});

test('travar num sítio mais baixo muda a altura normal: ao abrir, anda para a frente', () => {
  const ctrl = new WheelController();
  const out = run(ctrl, 120, calibrated((i) => {
    if (i < 30) return wheel({ cy: 0.8, open: 0 });   // trava com o volante mais baixo
    return wheel({ cy: 0.8 });                        // abre as mãos no mesmo sítio
  }));
  assert.equal(out.at(-1).gesture, 'forward');
  assert.ok(out.at(-1).motors.left > 0);
});

test('com ruído nas mãos continua a andar a direito, sem marcha-atrás', () => {
  const ctrl = new WheelController();
  const out = run(ctrl, 150, calibrated(() => wheel({ jitter: 0.01 })));
  assert.ok(out.slice(40).every((o) => o.gesture === 'forward' && o.motors.left > 0));
});

test('só uma mão ou nenhuma: o carro pára', () => {
  const ctrl = new WheelController();
  const out = run(ctrl, 80, calibrated((i) => (i < 20 ? wheel() : [wheel()[1]])));
  assert.equal(out.at(-1).gesture, 'one-hand');
  assert.ok(stopped(out.at(-1)));
  const none = run(new WheelController(), 5, () => []);
  assert.ok(stopped(none.at(-1)));
});
