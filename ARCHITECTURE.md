# Схема звонка с ботом (VoiceAgent AI — Gemini Live + SIP)

Документ описывает текущую реализацию цепочки: пользователь → АТС → сервер → Gemini Live → обратно в телефон.

---

## 1. Общая архитектура

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Браузер (Web UI)                                     │
│  • Обзор / Чек-листы / Телефония / Результаты                                     │
│  • Кнопка «Звонок» → POST /api/call/start                                         │
│  • Кнопка «Тест с микрофона» → локальный WebSocket к Gemini (без SIP)             │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        │ HTTP/WS
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         Node.js сервер (Express + Vite)                           │
│  • server/index.ts — HTTP API, WebSocket /ws, статика                             │
│  • CallManager — оркестрация SIP + RTP + Gemini на один звонок                    │
└─────────────────────────────────────────────────────────────────────────────────┘
         │                                    │
         │ SIP (UDP)                          │ WebSocket (через прокси)
         ▼                                    ▼
┌──────────────────────┐            ┌──────────────────────────────────────────┐
│  АТС (PBX)            │            │  Google Gemini Live API                   │
│  176.67.241.251:5060  │            │  wss://generativelanguage.googleapis.com  │
│  • REGISTER, INVITE,  │            │  • Аудио 16 kHz PCM → ответ 24 kHz PCM     │
│    ACK, BYE            │            │  • Транскрипции (user/agent)                │
│  • RTP: голос абонента │            │  • Модель: gemini-2.5-flash-native-audio  │
│    G.711 8 kHz         │            └──────────────────────────────────────────┘
└──────────────────────┘
         │
         │ RTP (UDP) — голос туда/обратно
         ▼
┌──────────────────────┐
│  Телефон абонента     │
│  (куда звонит бот)    │
└──────────────────────┘
```

---

## 2. Компоненты сервера

| Компонент | Файл | Назначение |
|-----------|------|------------|
| **SipAgent** | `server/sip-agent.ts` | SIP-стек: REGISTER на АТС, исходящий INVITE с SDP, приём 200 OK, ACK, BYE. В заголовках и SDP используется IP из `SIP_LOCAL_IP` или автоопределение. |
| **RtpSession** | `server/rtp-session.ts` | Приём/отправка RTP (UDP). Парсинг RTP-заголовка, payload — G.711 (PCMA/PCMU), 20 ms фреймы (160 байт). |
| **G.711 + ресемплинг** | `server/g711.ts` | A-law/μ-law ↔ PCM 8 kHz; ресемплинг 8↔16 kHz и 24→8 kHz для Gemini. |
| **GeminiClient** | `server/gemini-client.ts` | WebSocket-сессия к Gemini Live: отправка PCM 16 kHz, приём PCM 24 kHz и транскрипций. Подключение через прокси (ws-proxy-patch + https-proxy-agent). |
| **CallManager** | `server/call-manager.ts` | Связывает один звонок: создаёт RTP и Gemini, прокидывает аудио RTP ↔ Gemini, хранит состояние и транскрипции, завершает звонок. |

---

## 3. Последовательность исходящего звонка

```mermaid
sequenceDiagram
    participant UI as Web UI
    participant Server as Node Server
    participant CallMgr as CallManager
    participant SIP as SipAgent
    participant RTP as RtpSession
    participant ATS as АТС (PBX)
    participant Phone as Телефон
    participant Gemini as Gemini Live API

    UI->>Server: POST /api/call/start { number, checklistId }
    Server->>CallMgr: makeCall(number, checklistId)

    Note over CallMgr,RTP: 1. Подготовка RTP
    CallMgr->>RTP: new RtpSession(), bind(0)
    RTP-->>CallMgr: ready(localRtpPort)

    Note over CallMgr,SIP: 2. SIP INVITE с SDP
    CallMgr->>SIP: makeCall(number, localRtpPort)
    SIP->>ATS: INVITE (SDP: c=IP, m=audio localRtpPort)
    ATS->>SIP: 407 / 200 OK (SDP от АТС: RTP абонента)
    SIP->>ATS: ACK
    SIP-->>CallMgr: callInfo (remoteRtpHost, remoteRtpPort, codec)

    Note over CallMgr,Gemini: 3. Сессия Gemini
    CallMgr->>Gemini: connect() [WebSocket через прокси]
    Gemini-->>CallMgr: setupComplete

    Note over CallMgr: 4. Связка аудио: wireAudioPipeline()
    CallMgr->>Server: callStateChanged → WS → UI
    CallMgr->>Server: Call connected

    Note over RTP,Phone: Медиа: АТС шлёт RTP на наш IP:localRtpPort
    Phone<->>ATS: голос
    ATS->>RTP: RTP (G.711) → decode → PCM 16k → Gemini
    Gemini->>CallMgr: audio (PCM 24k) → downsample → G.711 → RTP
    CallMgr->>RTP: sendAudio(g711)
    RTP->>ATS: RTP к remoteRtpHost:remoteRtpPort
    ATS->>Phone: голос бота
```

---

## 4. Аудио-конвейер (один звонок)

```
  АТС (или телефон)                Node-сервер                          Gemini Live
  ─────────────────               ──────────                          ───────────

  RTP (UDP)                         RtpSession
  G.711 8 kHz   ───────────────►    parse RTP → payload (Buffer)
  20 ms фреймы                     alawToPcm / ulawToPcm → PCM 8 kHz
                                   upsample8to16 → PCM 16 kHz
                                   буфер, каждые 100 ms ──────────────►  sendRealtimeInput
                                                                         audio/pcm;rate=16000

  RTP (UDP)                         RtpSession
  G.711 8 kHz   ◄───────────────    sendAudio(g711)
  20 ms фреймы                     ◄── downsample24to8
                                   ◄── pcmToAlaw/pcmToUlaw
                                   ◄── GeminiClient.on('audio')  ◄──────  modelTurn (PCM 24 kHz)
```

- **Вход (голос абонента):** RTP → G.711 → PCM 8 kHz → ресемплинг до 16 kHz → отправка в Gemini раз в 100 ms.
- **Выход (голос бота):** ответ Gemini PCM 24 kHz → ресемплинг до 8 kHz → G.711 → RTP фреймы по 20 ms на АТС.

---

## 5. Важные моменты для работы голоса

1. **IP в SDP**  
   В INVITE и в 200 OK от нас в SDP должны быть `c=IN IP4 <SIP_LOCAL_IP>`. Этот IP должен быть тем, на который АТС реально шлёт RTP. Задаётся в `.env`: `SIP_LOCAL_IP=...`.

2. **RTP должен доходить до сервера**  
   АТС шлёт RTP на `SIP_LOCAL_IP:localRtpPort` (порт из SDP). Если пакеты не доходят (NAT, firewall, direct media), в логах будет `framesPerSec=0` и тишина.

3. **Gemini через прокси**  
   WebSocket к Gemini идёт через `HTTPS_PROXY`; для WebSocket используется патч `ws-proxy-patch.ts` (https-proxy-agent), иначе в регионах без доступа к API будет ошибка по локации.

4. **Локальный тест с микрофона**  
   Кнопка «Тест с микрофона» не использует SIP: браузер сам открывает WebSocket к Gemini и шлёт аудио с микрофона. Для этого в Vite задаётся `process.env.API_KEY` (ключ Gemini).

5. **Синхронизация завершения звонка**  
   Состояние звонка в приложении синхронизировано с SIP:
   - **BYE/CANCEL от АТС** — при получении сессия Gemini и окно звонка закрываются автоматически.
   - **Нормализация Call-ID** — Call-ID может приходить как `<id@host>` или `id`; используется единый нормализованный ключ при хранении и поиске.
   - **Таймаут по отсутствию RTP** — если RTP не приходит дольше `NO_RTP_TIMEOUT_SEC` (по умолчанию 60 с), звонок считается мёртвым (пропущенный/сброшенный) и завершается автоматически. Настраивается через `.env`: `NO_RTP_TIMEOUT_SEC=60`.

---

## 6. Файлы и потоки данных

```
server/
├── index.ts          # Точка входа, API, WS, загрузка sipConfig (в т.ч. SIP_LOCAL_IP)
├── ws-proxy-patch.ts # Патч https.request для WebSocket к Gemini через прокси
├── sip-agent.ts      # SIP: REGISTER, INVITE, ACK, BYE; SDP с localIp
├── rtp-session.ts    # RTP UDP: приём/отправка G.711 фреймов
├── g711.ts           # Кодеки и ресемплинг 8↔16↔24 kHz
├── gemini-client.ts  # WebSocket к Gemini Live, sendAudio / on('audio')
└── call-manager.ts   # makeCall, handleIncomingCall, wireAudioPipeline
```
