// Ligação Bluetooth ao micro:bit através do serviço UART (Web Bluetooth).

const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class MicrobitUart extends EventTarget {
  static get supported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  device = null;
  rx = null;          // característica onde a app escreve
  pending = null;     // só interessa o comando mais recente
  busy = false;
  buffer = '';
  wantConnected = false;

  get connected() {
    return Boolean(this.device?.gatt?.connected && this.rx);
  }

  get name() {
    return this.device?.name ?? '';
  }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [UART_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.#onDisconnected());
    this.wantConnected = true;
    await this.#openGatt();
  }

  async disconnect() {
    this.wantConnected = false;
    if (this.device?.gatt?.connected) {
      await this.#write('S').catch(() => {});
      this.device.gatt.disconnect();
    }
  }

  // Envia uma linha de texto; se já houver um envio em curso, fica só a última.
  send(line) {
    this.pending = line;
    this.#flush();
  }

  async #openGatt() {
    this.#emit('status', 'a ligar');
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(UART_SERVICE);
    const chars = await service.getCharacteristics();
    // No micro:bit os nomes RX/TX estão trocados em relação ao padrão da Nordic,
    // por isso escolhemos pelas propriedades em vez do UUID.
    this.rx = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
    const tx = chars.find((c) => c.properties.notify || c.properties.indicate);
    if (!this.rx) throw new Error('O micro:bit não tem o serviço UART ativo.');
    if (tx) {
      tx.addEventListener('characteristicvaluechanged', (e) => this.#onData(e.target.value));
      await tx.startNotifications();
    }
    this.#emit('status', 'ligado');
  }

  async #onDisconnected() {
    this.rx = null;
    this.busy = false;
    this.#emit('status', 'desligado');
    // Tenta voltar a ligar se a ligação caiu sem o utilizador pedir
    for (let attempt = 1; attempt <= 3 && this.wantConnected; attempt++) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      if (!this.wantConnected) return;
      try {
        await this.#openGatt();
        return;
      } catch {
        // tenta outra vez
      }
    }
    if (this.wantConnected) this.#emit('status', 'desligado');
  }

  #onData(view) {
    this.buffer += decoder.decode(view);
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith('D')) {
        const cm = Number.parseInt(line.slice(1), 10);
        if (Number.isFinite(cm)) this.#emit('distance', cm);
      }
    }
  }

  async #flush() {
    if (this.busy || !this.connected || this.pending === null) return;
    this.busy = true;
    const line = this.pending;
    this.pending = null;
    try {
      await this.#write(line);
    } catch (err) {
      console.warn('Falha ao enviar por Bluetooth:', err);
    } finally {
      this.busy = false;
      if (this.pending !== null) this.#flush();
    }
  }

  #write(line) {
    const data = encoder.encode(line + '\n');
    if (this.rx.properties.writeWithoutResponse) return this.rx.writeValueWithoutResponse(data);
    return this.rx.writeValueWithResponse(data);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
