# VoiceAgent AI — Gemini Live + SIP

Голосовой AI‑ассистент для автоматизации телефонных опросов.  
Подключается к АТС через SIP/UDP, ведёт разговор через Gemini Live API (Live Audio), работает на сервере и не зависит от открытого браузера.

## Архитектура

- **Серверный SIP‑агент** (`server/sip-agent.ts`) — регистрируется на АТС по UDP, исходящие/входящие звонки, Digest‑авторизация.
- **RTP‑модуль** (`server/rtp-session.ts`) — приём/отправка RTP‑пакетов, кодеки G.711 A‑law/μ‑law, `ptime=20`.
- **G.711 + ресемплинг** (`server/g711.ts`) — конвертация G.711 8 kHz ↔ PCM16 16 kHz ↔ PCM16 24 kHz.
- **Клиент Gemini Live** (`server/gemini-client.ts`) — WebSocket‑сессия с моделью `gemini-2.5-flash-native-audio-preview-12-2025`, потоковый ввод/вывод аудио и транскрипции.
- **Оркестратор звонков** (`server/call-manager.ts`) — стыкует SIP ↔ RTP ↔ Gemini, управляет жизненным циклом звонка и логами.
- **Web UI (React + Vite)** — SPA для чек‑листов, контактов, запуска звонков и просмотра результатов.

## Настройка окружения

Файл `.env` в корне:

```env
GEMINI_API_KEY=your_gemini_api_key

SIP_HOST=176.67.241.251
SIP_PORT=5060
SIP_USERNAME=4998
SIP_PASSWORD=your_sip_password
SIP_DOMAIN=bestway
SIP_DISPLAY_NAME=Gemini Bot
```

> **Важно:** доступ к Gemini Live API ограничен по странам.  
> Если в логах появляется `User location is not supported for the API use.`,  
> это ограничение на стороне Google, а не ошибка проекта.

## Прокси для Gemini

Проект ожидает, что у вас есть HTTP(S)‑прокси на `http://localhost:1080`, через который разрешён доступ к `generativelanguage.googleapis.com`.

Скрипт `npm run dev` уже автоматически выставляет:

```bash
NODE_USE_ENV_PROXY=1
HTTPS_PROXY=http://localhost:1080
```

поэтому все HTTP(S)/WebSocket‑запросы Node будут идти через локальный прокси.

## Быстрый старт

1. Установите зависимости:

   ```bash
   npm install
   ```

2. Убедитесь, что:
   - в `.env` прописан рабочий `GEMINI_API_KEY` и SIP‑настройки;
   - запущен локальный прокси на `http://localhost:1080`.

3. Запустите сервер и фронтенд:

   ```bash
   npm run dev
   ```

4. Откройте в браузере:

   ```text
   http://localhost:3000
   ```

Сервер автоматически зарегистрируется на АТС при старте (если пароль указан в `.env`).

## Скрипты

- `npm run dev` — сервер Node + Vite dev (фронтенд с HMR) с включённым прокси для Gemini;
- `npm run build` — сборка фронтенда (`dist/`);
- `npm run server` — только сервер (`server/index.ts`) без Vite.

## HTTP/WS API

- `GET /api/sip/status` — статус SIP‑регистрации и текущая конфигурация;
- `POST /api/sip/connect` — подключиться к АТС, можно передать новые SIP‑параметры в теле;
- `POST /api/sip/disconnect` — отключить SIP‑агента;
- `POST /api/checklists/sync` — синхронизировать чек‑листы с фронтенда;
- `GET /api/checklists` — получить чек‑листы;
- `POST /api/call/start` — начать звонок: `{ number, checklistId, customerName? }`;
- `POST /api/call/stop` — завершить звонок: `{ callId }`;
- `GET /api/calls/active` — активные звонки;
- `GET /api/calls/history` — история звонков;
- `WS /ws` — WebSocket‑канал: статусы SIP, состояние звонков, транскрипции, серверные логи.
