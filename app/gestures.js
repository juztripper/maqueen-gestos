// Lógica dos gestos — sem dependências do browser, para poder ser testada com `node --test`.
//
// Volante com as duas mãos:
//   AGARRAR   levantar as duas mãos à frente da câmara; ficar quieto meio segundo
//             marca a altura normal do volante
//   RODAR     rodar o volante imaginário (o ângulo entre as mãos) -> virar
//   ABRIR     mãos abertas                                       -> andar para a frente
//   FECHAR    mãos fechadas                                      -> travar (e a altura
//                                                                   atual passa a ser a normal)
//   BAIXAR    volante abaixo da linha de marcha-atrás, mãos abertas -> andar para trás

export const DEFAULTS = {
  maxSpeed: 160,        // 0–255, velocidade máxima dos motores
  reverseSpeed: 0.6,    // velocidade em marcha-atrás (fração da máxima)
  turnStrength: 0.55,   // 0–1, quanto o carro vira com o volante todo rodado
  wheelDeadzone: 6,     // graus de rotação ignorados
  wheelMax: 45,         // graus para virar ao máximo
  reverseDrop: 0.15,    // quanto baixar o volante para a marcha-atrás (fração da altura da imagem)
};

const MIN_PWM = 30;               // abaixo disto os motores do Maqueen não chegam a rodar
const CALIBRATE_MS = 400;         // tempo com o volante quieto para marcar a altura normal
const CALIBRATE_STILL = 0.04;     // "quieto" = o centro não mexe mais do que isto
const FIST_CLOSE = 0.3;           // abertura abaixo disto = mão fechada
const FIST_OPEN = 0.45;           // e acima disto volta a estar aberta
const REVERSE_HYSTERESIS = 0.02;  // evita ligar/desligar a marcha-atrás na fronteira
const LOST_MS = 400;              // depois disto sem ver as duas mãos, volta a calibrar

const PALM = [0, 5, 9, 13, 17];   // pulso + bases dos dedos
const FINGERS = [[5, 8], [9, 12], [13, 16], [17, 20]];  // [base, ponta] indicador..mindinho

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothing = (dtMs, tauMs) => 1 - Math.exp(-dtMs / tauMs);

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

// Centro da palma em coordenadas normalizadas da imagem (sem espelhar).
export function palmCenter(lm) {
  let x = 0, y = 0;
  for (const i of PALM) { x += lm[i].x; y += lm[i].y; }
  return { x: x / PALM.length, y: y / PALM.length };
}

// Abertura de cada dedo (0 = dobrado, 1 = esticado), usando as coordenadas 3D
// da mão para não depender da rotação.
export function fingerOpenness(world) {
  return FINGERS.map(([base, tip]) => {
    const ratio = dist3(world[0], world[tip]) / dist3(world[0], world[base]);
    return clamp((ratio - 1.0) / 0.8, 0, 1);
  });
}

function opennessOf(hand) {
  const open = fingerOpenness(hand.worldLandmarks ?? hand.landmarks);
  return open.reduce((a, b) => a + b, 0) / open.length;
}

// Com a câmara virada para o utilizador, a mão direita aparece do lado esquerdo
// da imagem (a imagem não está espelhada). Com duas mãos decide-se pela posição.
export function assignHands(hands) {
  if (hands.length < 2) return { left: null, right: null };
  const [a, b] = [...hands].sort((h1, h2) => palmCenter(h1.landmarks).x - palmCenter(h2.landmarks).x);
  return { left: b, right: a };
}

// Ângulo do volante em graus, do ponto de vista do utilizador:
// 0 = mãos à mesma altura, positivo = rodado para a direita (mão direita mais baixa).
export function wheelAngle(left, right, aspect = 1) {
  const l = palmCenter(left.landmarks);
  const r = palmCenter(right.landmarks);
  const dx = (l.x - r.x) * aspect;   // espelhado: a mão direita tem x menor na imagem
  const dy = r.y - l.y;
  return clamp(Math.atan2(dy, Math.max(dx, 1e-6)) * 180 / Math.PI, -90, 90);
}

// Converte acelerador (-1..1) e direção (-1..1) em velocidade das rodas (-1..1).
export function mix(throttle, steer, { spinInPlace = false, turnStrength = DEFAULTS.turnStrength } = {}) {
  const turn = steer * turnStrength;
  if (Math.abs(throttle) < 0.05) {
    if (spinInPlace && Math.abs(steer) > 0.25) {
      const spin = turn * 0.8;
      return { left: spin, right: -spin };
    }
    return { left: 0, right: 0 };
  }
  // A roda de fora vai à velocidade do acelerador, a de dentro abranda.
  const k = 1 + Math.abs(turn);
  return { left: throttle * (1 + turn) / k, right: throttle * (1 - turn) / k };
}

// Velocidade das rodas (-1..1) -> valores para os motores (-255..255).
// Qualquer valor diferente de zero começa em MIN_PWM, para o motor rodar mesmo devagar.
export function toMotors(wheels, maxSpeed) {
  const pwm = (v) => {
    if (Math.abs(v) < 0.02) return 0;
    const min = Math.min(MIN_PWM, maxSpeed);
    return Math.sign(v) * Math.round(min + Math.abs(v) * (maxSpeed - min));
  };
  return { left: pwm(wheels.left), right: pwm(wheels.right) };
}

export class WheelController {
  constructor(settings = {}) {
    this.settings = { ...DEFAULTS, ...settings };
    this.reset();
  }

  reset() {
    this.throttle = 0;
    this.lastT = null;
    this.seenAt = -Infinity;
    this.angle = 0;
    this.centerY = 0;
    this.openL = 1;
    this.openR = 1;
    this.braking = false;
    this.reversing = false;
    this.restY = null;      // altura normal do volante
    this.calibStart = 0;
    this.calibRef = 0;
  }

  // hands: [{ landmarks, worldLandmarks }] — t em ms — aspect = largura/altura do vídeo
  update(hands, t, aspect = 1) {
    const s = this.settings;
    const { left, right } = assignHands(hands);
    const dt = this.lastT === null ? 0 : Math.min(200, t - this.lastT);
    this.lastT = t;

    let gesture = 'none';
    let target = 0;
    let wheel = null;

    if (left && right) {
      const angle = wheelAngle(left, right, aspect);
      const l = palmCenter(left.landmarks);
      const r = palmCenter(right.landmarks);
      const centerY = (l.y + r.y) / 2;
      const openL = opennessOf(left);
      const openR = opennessOf(right);

      if (t - this.seenAt > LOST_MS) {
        // As mãos acabaram de aparecer: começa do zero
        this.angle = angle;
        this.centerY = centerY;
        this.openL = openL;
        this.openR = openR;
        this.braking = false;
        this.reversing = false;
        this.restY = null;
        this.calibStart = t;
        this.calibRef = centerY;
      } else {
        this.angle += smoothing(Math.max(1, dt), 70) * (angle - this.angle);
        this.centerY += smoothing(Math.max(1, dt), 70) * (centerY - this.centerY);
        this.openL += smoothing(Math.max(1, dt), 60) * (openL - this.openL);
        this.openR += smoothing(Math.max(1, dt), 60) * (openR - this.openR);
      }
      this.seenAt = t;

      // Travão: basta uma mão fechada; para soltar, as duas têm de abrir
      const fist = Math.min(this.openL, this.openR);
      this.braking = this.braking ? fist < FIST_OPEN : fist < FIST_CLOSE;

      if (this.braking) {
        this.restY = this.centerY;   // ao travar, a altura atual passa a ser a normal
        this.reversing = false;
        gesture = 'brake';
      } else if (this.restY === null) {
        if (Math.abs(this.centerY - this.calibRef) > CALIBRATE_STILL) {
          this.calibStart = t;
          this.calibRef = this.centerY;
        }
        if (t - this.calibStart >= CALIBRATE_MS) this.restY = this.centerY;
        gesture = 'calibrating';
      }

      if (!this.braking && this.restY !== null) {
        const drop = this.centerY - this.restY;
        this.reversing = this.reversing
          ? drop > s.reverseDrop - REVERSE_HYSTERESIS
          : drop > s.reverseDrop;
        gesture = this.reversing ? 'reverse' : 'forward';
        target = this.reversing ? -s.reverseSpeed : 1;
      }

      const amount = clamp((Math.abs(this.angle) - s.wheelDeadzone) / Math.max(1, s.wheelMax - s.wheelDeadzone), 0, 1);
      wheel = {
        angle: this.angle,
        steer: Math.sign(this.angle) * amount ** 1.5,   // curva suave perto do centro
        left: l,
        right: r,
        restY: this.restY,
        reverseY: this.restY === null ? null : this.restY + s.reverseDrop,
      };
    } else if (hands.length === 1) {
      gesture = 'one-hand';
    }

    // Acelera e trava de forma suave (trava mais depressa do que acelera)
    const rate = Math.abs(target) > Math.abs(this.throttle) && Math.sign(target) !== -Math.sign(this.throttle) ? 2.5 : 6;
    this.throttle += clamp(target - this.throttle, -rate * dt / 1000, rate * dt / 1000);
    if (Math.abs(this.throttle) < 0.01 && target === 0) this.throttle = 0;

    const steer = wheel ? wheel.steer : 0;
    return {
      gesture,
      wheel,
      throttle: this.throttle,
      steer,
      motors: toMotors(mix(this.throttle, steer, s), s.maxSpeed),
      hands: { left, right },
    };
  }
}
