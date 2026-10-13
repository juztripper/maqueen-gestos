/**
 * Carrinho micro:Maqueen controlado por gestos (app no telemóvel).
 *
 * A app liga-se por Bluetooth (serviço UART) e envia linhas de texto:
 *   M<esq>,<dir>\n   velocidade de cada roda, de -255 (trás) a 255 (frente)
 *   S\n              parar
 *
 * Segurança:
 *   - se não chegar nenhum comando em TIMEOUT_MS, os motores param
 *   - se houver um obstáculo a menos de OBSTACLE_CM, não deixa andar para a frente
 *
 * O micro:bit V1 tem pouca memória e o Bluetooth gasta quase toda (erro 020),
 * por isso há um único ciclo `forever` que faz tudo.
 */

const MOTOR_ADDR = 0x10      // driver de motores do Maqueen (I2C)
const MOTOR_LEFT = 0x00
const MOTOR_RIGHT = 0x02
const TIMEOUT_MS = 600
const OBSTACLE_CM = 10
const SONAR_EVERY_MS = 100

// Estados mostrados no ecrã de LEDs
const SHOW_NONE = 0
const SHOW_STOP = 1
const SHOW_FWD = 2
const SHOW_FWD_LEFT = 3
const SHOW_FWD_RIGHT = 4
const SHOW_BACK = 5
const SHOW_SPIN_LEFT = 6
const SHOW_SPIN_RIGHT = 7

let targetLeft = 0
let targetRight = 0
let appliedLeft = 0
let appliedRight = 0
let lastCommandAt = 0
let connected = false
let distance = 0
let nextSonarAt = 0
let shown = SHOW_NONE

function setMotor(motor: number, speed: number) {
    const buf = pins.createBuffer(3)
    buf[0] = motor
    buf[1] = speed >= 0 ? 0 : 1   // 0 = frente, 1 = trás
    buf[2] = Math.min(Math.abs(speed), 255)
    pins.i2cWriteBuffer(MOTOR_ADDR, buf)
}

function drive(left: number, right: number) {
    setMotor(MOTOR_LEFT, left)
    setMotor(MOTOR_RIGHT, right)
    appliedLeft = left
    appliedRight = right
}

function readDistanceCm(): number {
    // Sensor ultrassónico: trig no P1, echo no P2 (espera no máximo ~2 m)
    pins.setPull(DigitalPin.P1, PinPullMode.PullNone)
    pins.digitalWritePin(DigitalPin.P1, 0)
    control.waitMicros(2)
    pins.digitalWritePin(DigitalPin.P1, 1)
    control.waitMicros(10)
    pins.digitalWritePin(DigitalPin.P1, 0)
    const pulse = pins.pulseIn(DigitalPin.P2, PulseValue.High, 12000)
    return Math.idiv(pulse, 58)   // 0 = sem leitura (nada à frente)
}

function parseSpeed(text: string): number {
    const value = parseInt(text)
    // NaN falha as duas comparações, por isso também é rejeitado
    if (value >= -255 && value <= 255) return value
    return 0
}

// Mostra a direção no ecrã de LEDs e acende os LEDs da frente (P8 esq, P12 dir)
function showDirection(left: number, right: number) {
    const sum = left + right
    const diff = left - right
    let state = SHOW_FWD
    if (left == 0 && right == 0) state = SHOW_STOP
    else if (sum < 0) state = SHOW_BACK
    else if (Math.abs(sum) < 20) state = diff > 0 ? SHOW_SPIN_RIGHT : SHOW_SPIN_LEFT
    else if (diff > 40) state = SHOW_FWD_RIGHT
    else if (diff < -40) state = SHOW_FWD_LEFT
    if (state == shown) return
    shown = state

    if (state == SHOW_STOP) basic.showIcon(IconNames.SmallSquare, 0)
    else if (state == SHOW_BACK) basic.showArrow(ArrowNames.South, 0)
    else if (state == SHOW_SPIN_RIGHT) basic.showArrow(ArrowNames.East, 0)
    else if (state == SHOW_SPIN_LEFT) basic.showArrow(ArrowNames.West, 0)
    else if (state == SHOW_FWD_RIGHT) basic.showArrow(ArrowNames.NorthEast, 0)
    else if (state == SHOW_FWD_LEFT) basic.showArrow(ArrowNames.NorthWest, 0)
    else basic.showArrow(ArrowNames.North, 0)

    const turningLeft = state == SHOW_SPIN_LEFT || state == SHOW_FWD_LEFT || state == SHOW_BACK
    const turningRight = state == SHOW_SPIN_RIGHT || state == SHOW_FWD_RIGHT || state == SHOW_BACK
    pins.digitalWritePin(DigitalPin.P8, turningLeft ? 1 : 0)
    pins.digitalWritePin(DigitalPin.P12, turningRight ? 1 : 0)
}

bluetooth.onBluetoothConnected(function () {
    connected = true
    shown = SHOW_STOP   // o ✓ fica visível até o carro se mexer
    basic.showIcon(IconNames.Yes, 0)
})

bluetooth.onBluetoothDisconnected(function () {
    connected = false
    targetLeft = 0
    targetRight = 0
    drive(0, 0)
    shown = SHOW_NONE
    pins.digitalWritePin(DigitalPin.P8, 0)
    pins.digitalWritePin(DigitalPin.P12, 0)
    basic.showIcon(IconNames.No, 0)
})

bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    const line = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))
    if (line.length == 0) return
    const kind = line.charAt(0)
    if (kind == "M") {
        const comma = line.indexOf(",")
        if (comma < 0) return
        targetLeft = parseSpeed(line.substr(1, comma - 1))
        targetRight = parseSpeed(line.substr(comma + 1))
        lastCommandAt = input.runningTime()
    } else if (kind == "S") {
        targetLeft = 0
        targetRight = 0
        lastCommandAt = input.runningTime()
    }
})

bluetooth.startUartService()
drive(0, 0)
basic.showIcon(IconNames.Square, 0)

// Ciclo único: sensor de distância, segurança e motores
basic.forever(function () {
    const now = input.runningTime()
    if (now >= nextSonarAt) {
        distance = readDistanceCm()
        nextSonarAt = now + SONAR_EVERY_MS
    }

    let left = targetLeft
    let right = targetRight
    if (!connected || now - lastCommandAt > TIMEOUT_MS) {
        left = 0
        right = 0
    }
    if (distance > 0 && distance < OBSTACLE_CM && left + right > 0) {
        left = 0
        right = 0
    }
    if (left != appliedLeft || right != appliedRight) drive(left, right)
    if (connected) showDirection(left, right)
    basic.pause(20)
})
