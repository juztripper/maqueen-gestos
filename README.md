# Maqueen Gestos

Conduz um **micro:Maqueen V4** (com micro:bit) com gestos das mãos, usando a câmara do telemóvel.
A app vê as tuas mãos com o MediaPipe Hands e envia os comandos ao carrinho por Bluetooth.

Seguras um **volante imaginário** com as duas mãos:

| Gesto | O carro… |
|---|---|
| **Rodar o volante** (a mão esquerda sobe e a direita desce, ou o contrário) | vira para esse lado |
| **Mãos abertas** | anda para a frente |
| **Mãos fechadas** (basta uma) | trava |
| **Baixar o volante** abaixo da linha laranja tracejada, com as mãos abertas | anda para trás |

Quando levantas as mãos, segura o volante quieto meio segundo: essa é a **altura normal**.
Sempre que travas, a altura onde estás passa a ser a normal. Se uma das mãos sair da imagem, o carro pára.

## 1. Preparar o micro:bit

1. Liga o micro:bit ao computador por USB.
2. Arrasta o ficheiro [`microbit/maqueen-gestos.hex`](microbit/maqueen-gestos.hex) para a drive **MICROBIT**.
   Funciona no micro:bit V1 e V2.
3. Quando acabar, aparece um quadrado no ecrã de LEDs: está à espera da app.

Para mudar o código: em [makecode.microbit.org](https://makecode.microbit.org) faz **Importar → Importar ficheiro**
e escolhe o `.hex`. O código está em [`microbit/main.ts`](microbit/main.ts).
Se criares um projeto novo, junta a extensão **bluetooth** e, nas definições do projeto,
escolhe **No Pairing Required** (a app não funciona com emparelhamento).

## 2. Abrir a app

A câmara e o Bluetooth só funcionam em páginas `https://` (ou em `localhost`).

**No telemóvel (Android + Chrome):** publica a pasta `app/` num site com https:

- **GitHub Pages:** cria um repositório, faz push deste projeto e, no GitHub, vai a
  *Settings → Pages → Source: GitHub Actions*. O workflow em `.github/workflows/pages.yml`
  publica a app automaticamente.
- **Netlify Drop:** arrasta a pasta `app/` para [app.netlify.com/drop](https://app.netlify.com/drop).

No Chrome do Android podes depois fazer *⋮ → Adicionar ao ecrã principal* para ficar como uma app.

**iPhone:** o Safari não suporta Web Bluetooth. Usa um browser que suporte, como o **Bluefy**.

**No Mac, para testar:** abre um terminal nesta pasta e corre

```bash
npm start
```

e abre <http://localhost:8000> no **Chrome** (a webcam e o Bluetooth do Mac funcionam).
As setas do teclado também conduzem o carro, e a barra de espaço pára/retoma.

## 3. Conduzir

1. Liga o interruptor do Maqueen.
2. Na app, carrega em **Ligar carrinho** e escolhe `BBC micro:bit [...]`. Aparece um ✓ no micro:bit.
3. Carrega em **Iniciar câmara**, põe o telemóvel de pé com a câmara virada para ti
   e levanta as duas mãos. A mão direita aparece a verde e a esquerda a azul.
4. **PARAR** pára tudo de imediato.

Na roda dentada há definições: velocidade máxima, sensibilidade dos gestos,
trocar as mãos (para canhotos), câmara traseira, etc.

## Segurança

- O micro:bit pára os motores se não receber nenhum comando durante 0,6 s
  (ligação perdida, app fechada, ecrã bloqueado).
- O sensor ultrassónico impede-o de andar para a frente se houver um obstáculo a menos de 10 cm.
- Os LEDs vermelhos da frente funcionam como piscas, e o ecrã de LEDs mostra uma seta com a direção.

## Como funciona

```
telemóvel                                          micro:bit + Maqueen
câmara → MediaPipe Hands → gestures.js → bluetooth.js ──BLE UART──▶ main.ts → motores (I2C 0x10)
                                                                   sonar (P1/P2) ──┘
```

- [`app/gestures.js`](app/gestures.js): transforma as posições das mãos em velocidade das rodas.
  - *Volante*: ângulo da linha entre os centros das duas palmas. Perto do centro a resposta
    é mais suave, para ser fácil andar a direito.
  - *Mãos abertas/fechadas*: quanto os dedos estão esticados, a partir das coordenadas 3D do MediaPipe.
  - *Marcha-atrás*: o centro do volante desce mais do que *Quanto baixar para a marcha-atrás*
    em relação à altura normal.
- [`app/bluetooth.js`](app/bluetooth.js): ligação Web Bluetooth ao serviço UART do micro:bit.
- [`app/main.js`](app/main.js): câmara, desenho das mãos, painel e envio dos comandos.
- [`microbit/main.ts`](microbit/main.ts): recebe os comandos e controla os motores.
  No micro:bit V1 a memória é muito pouca com o Bluetooth ligado (erro **020**),
  por isso o programa tem um único ciclo `forever`. Evita juntar mais ciclos ou extensões.

Protocolo (texto, uma linha por mensagem):

| Mensagem | Sentido | Significado |
|---|---|---|
| `M<esq>,<dir>` | app → micro:bit | velocidade de cada roda, de -255 a 255 (ex.: `M160,-160`) |
| `S` | app → micro:bit | parar |

## Testes

A lógica dos gestos tem testes com mãos simuladas:

```bash
npm test
```

## Problemas comuns

- **O micro:bit não aparece na lista:** confirma que tem o `.hex` desta pasta (quadrado no ecrã)
  e que nenhuma outra app está ligada a ele. No Android, o Bluetooth e a localização têm de estar ligados.
- **Vira demasiado depressa:** baixa *Força da curva* ou aumenta *Rotação para virar ao máximo*.
- **Entra em marcha-atrás sem querer:** aumenta *Quanto baixar para a marcha-atrás*, ou trava e volta a abrir as mãos para marcar a altura normal.
- **Não anda para a frente, mas anda para trás:** há um obstáculo a menos de 10 cm do sensor ultrassónico.
- **O carro não anda mas a app mostra as setas:** liga o interruptor do Maqueen e verifica as pilhas.
