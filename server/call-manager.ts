import { EventEmitter } from 'events';
import { SipAgent, type SipConfig, type SipCallInfo } from './sip-agent.js';
import { RtpSession, PAYLOAD_PCMA, PAYLOAD_PCMU, SAMPLES_PER_FRAME, FRAME_DURATION_MS } from './rtp-session.js';
import { GeminiClient, type GeminiSessionConfig } from './gemini-client.js';
import {
  alawToPcm, pcmToAlaw,
  ulawToPcm, pcmToUlaw,
  upsample8to16, downsample24to8,
} from './g711.js';

/** Таймаут (мс): если RTP не приходит дольше — считаем звонок мёртвым и завершаем. */
const NO_RTP_TIMEOUT_MS = (parseInt(process.env.NO_RTP_TIMEOUT_SEC || '60', 10) || 60) * 1000;

/** Диапазон RTP-портов (задаётся в .env: RTP_PORT_MIN / RTP_PORT_MAX). */
const RTP_PORT_MIN = parseInt(process.env.RTP_PORT_MIN || '10000', 10);
const RTP_PORT_MAX = parseInt(process.env.RTP_PORT_MAX || '10100', 10);
let _rtpNextPort = RTP_PORT_MIN;

/** Возвращает следующий доступный RTP-порт из заданного диапазона. */
function allocRtpPort(): number {
  const p = _rtpNextPort;
  _rtpNextPort = _rtpNextPort >= RTP_PORT_MAX ? RTP_PORT_MIN : _rtpNextPort + 1;
  return p;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Checklist {
  id: string;
  title: string;
  description: string;
  items: string[];
  voiceName?: string;
}

export interface CallLog {
  id: string;
  phoneNumber: string;
  customerName: string;
  status: 'completed' | 'failed' | 'in-progress';
  startTime: string;
  endTime?: string;
  transcript: { speaker: 'agent' | 'user'; text: string }[];
  summary?: string;
  checklistId?: string;
}

export interface ActiveCallState {
  callId: string;
  phoneNumber: string;
  customerName: string;
  status: 'initiating' | 'ringing' | 'connected' | 'ended';
  startTime: string;
  duration: number;
  transcript: { speaker: 'agent' | 'user'; text: string }[];
  checklistId?: string;
}

export declare interface CallManager {
  on(event: 'sipStatus', listener: (status: string) => void): this;
  on(event: 'callStateChanged', listener: (state: ActiveCallState) => void): this;
  on(event: 'callEnded', listener: (log: CallLog) => void): this;
  on(event: 'transcript', listener: (callId: string, speaker: 'agent' | 'user', text: string) => void): this;
  on(event: 'log', listener: (level: string, msg: string) => void): this;
}

// ─── Call Manager ────────────────────────────────────────────────────────────

export class CallManager extends EventEmitter {
  private sipAgent: SipAgent;
  private geminiApiKey: string;
  private callSessions = new Map<string, {
    rtp: RtpSession;
    gemini: GeminiClient;
    state: ActiveCallState;
    durationTimer?: NodeJS.Timeout;
    audioBuffer: Buffer[];
    sendTimer?: NodeJS.Timeout;
    lastRtpTime: number;
    /** Outgoing G.711 bytes queued for RTP transmission (drained by outgoingRtpTimer) */
    outgoingRtpBuf: Buffer;
    /** Single 20ms interval for paced RTP output — prevents overlapping sendAudio calls */
    outgoingRtpTimer?: NodeJS.Timeout;
  }>();
  private callHistory: CallLog[] = [];
  private checklists: Checklist[] = [];
  /** Чек-лист по умолчанию для входящих звонков (если не найден — берём первый). */
  private incomingDefaultChecklistId?: string;

  constructor(sipConfig: SipConfig, geminiApiKey: string) {
    super();
    this.geminiApiKey = geminiApiKey;
    this.sipAgent = new SipAgent(sipConfig);

    // Forward SIP logs
    this.sipAgent.on('log', (level, msg) => {
      this.emit('log', level, `[SIP] ${msg}`);
    });

    this.sipAgent.on('registered', () => {
      this.emit('sipStatus', 'registered');
      this.emit('log', 'info', 'Registered on PBX');
    });

    this.sipAgent.on('unregistered', () => {
      this.emit('sipStatus', 'unregistered');
    });

    this.sipAgent.on('registrationFailed', (reason) => {
      this.emit('sipStatus', 'error');
      this.emit('log', 'error', `Registration failed: ${reason}`);
    });

    this.sipAgent.on('error', (err) => {
      this.emit('log', 'error', `SIP error: ${err.message}`);
    });

    // Incoming calls
    this.sipAgent.on('invite', (callInfo) => {
      this.handleIncomingCall(callInfo);
    });

    // Remote hangup (BYE/CANCEL от АТС)
    this.sipAgent.on('callEnded', (callId) => {
      const resolved = this.resolveCallSessionId(callId);
      if (resolved) this.endCallSession(resolved, 'completed');
      else if (this.callSessions.size === 1) {
        const only = this.callSessions.keys().next().value;
        this.emit('log', 'info', `[callEnded] Call-ID mismatch, ending only active call: ${only}`);
        this.endCallSession(only, 'completed');
      } else this.emit('log', 'warn', `[callEnded] No session for call-id: ${callId}`);
    });
  }

  setChecklists(checklists: Checklist[]) {
    this.checklists = checklists;
  }

  /** Установить чек-лист по умолчанию для входящих вызовов. */
  setIncomingDefaultChecklist(id: string | undefined) {
    this.incomingDefaultChecklistId = id;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.sipAgent.start();
    await this.sipAgent.register();
  }

  async stop(): Promise<void> {
    // End all active calls
    for (const [callId] of this.callSessions) {
      this.endCallSession(callId, 'completed');
    }
    await this.sipAgent.stop();
  }

  // ─── Outbound call ─────────────────────────────────────────────────────────

  async makeCall(targetNumber: string, checklistId: string, customerName?: string, callMode: 'outgoing' | 'incoming' = 'outgoing'): Promise<string> {
    let checklist = this.checklists.find(c => c.id === checklistId);

    // Защита от расхождения фронта и сервера:
    // если нужный checklist не найден, но хоть какой‑то есть — берём первый.
    if (!checklist && this.checklists.length > 0) {
      checklist = this.checklists[0];
      this.emit('log', 'warn', `Checklist ${checklistId} not found on server, falling back to "${checklist.title}" (${checklist.id})`);
    }

    if (!checklist) {
      throw new Error('На сервере не настроены чек-листы. Открой вкладку "Чек-листы" и сохраните сценарии, чтобы начать звонок.');
    }

    this.emit('log', 'info', `Initiating call to ${targetNumber} with checklist "${checklist.title}" (mode: ${callMode})`);

    const systemInstruction = this.buildSystemInstruction(checklist, customerName || targetNumber, callMode);
    const gemini = new GeminiClient({
      apiKey: this.geminiApiKey,
      voiceName: checklist.voiceName,
      systemInstruction,
      ...(callMode === 'incoming' && { initialPrompt: 'Начни.' }),
    });
    const geminiPromise = gemini.connect();

    const rtpLocalPort = allocRtpPort();
    const rtp = new RtpSession({
      remoteHost: '0.0.0.0',
      remotePort: 0,
      payloadType: PAYLOAD_PCMA,
      localPort: rtpLocalPort,
    });
    const localRtpPort = await new Promise<number>((resolve) => {
      rtp.on('ready', (port) => resolve(port));
    });
    this.emit('log', 'info', `RTP session ready on port ${localRtpPort}`);

    const callPromise = this.sipAgent.makeCall(targetNumber, localRtpPort);

    let callInfo: SipCallInfo;
    const [callResult, geminiResult] = await Promise.allSettled([callPromise, geminiPromise]);
    if (callResult.status === 'rejected') {
      gemini.close();
      rtp.close();
      throw callResult.reason;
    }
    if (geminiResult.status === 'rejected') {
      this.sipAgent.hangup(callResult.value.callId);
      rtp.close();
      throw geminiResult.reason;
    }
    callInfo = callResult.value;

    // Update RTP with remote info from SDP
    (rtp as any).config.remoteHost = callInfo.remoteRtpHost;
    (rtp as any).config.remotePort = callInfo.remoteRtpPort;
    (rtp as any).config.payloadType = callInfo.codec === 'alaw' ? PAYLOAD_PCMA : PAYLOAD_PCMU;

    // Wire up the audio pipeline
    const state: ActiveCallState = {
      callId: callInfo.callId,
      phoneNumber: targetNumber,
      customerName: customerName || targetNumber,
      status: 'connected',
      startTime: new Date().toISOString(),
      duration: 0,
      transcript: [],
      checklistId,
    };

    const session = {
      rtp,
      gemini,
      state,
      audioBuffer: [] as Buffer[],
      durationTimer: setInterval(() => {
        state.duration++;
        this.emit('callStateChanged', { ...state });
      }, 1000),
      sendTimer: undefined as NodeJS.Timeout | undefined,
      lastRtpTime: Date.now(),
      outgoingRtpBuf: Buffer.alloc(0),
      outgoingRtpTimer: undefined as NodeJS.Timeout | undefined,
    };

    this.callSessions.set(callInfo.callId, session);
    this.wireAudioPipeline(callInfo.callId, callInfo.codec);
    if (callMode === 'incoming') gemini.sendInitialPrompt();

    this.emit('callStateChanged', { ...state });
    this.emit('log', 'info', `Call connected: ${callInfo.callId}`);

    return callInfo.callId;
  }

  // ─── Incoming call handler ─────────────────────────────────────────────────

  private async handleIncomingCall(callInfo: SipCallInfo): Promise<void> {
    this.emit('log', 'info', `Incoming call from ${callInfo.targetNumber}`);

    // Выбираем чек-лист по умолчанию для входящих:
    // 1) если задан incomingDefaultChecklistId — пытаемся найти его;
    // 2) иначе берём первый из списка;
    // 3) если чек-листов вообще нет — создаём "тихий" дефолтный сценарий.
    let checklist =
      (this.incomingDefaultChecklistId &&
        this.checklists.find((c) => c.id === this.incomingDefaultChecklistId)) ||
      this.checklists[0];
    if (!checklist) {
      this.emit('log', 'warn', 'No checklist available for incoming call, using implicit default.');
      checklist = {
        id: 'incoming-default',
        title: 'Incoming default',
        description: 'Автоматически созданный сценарий для входящих вызовов.',
        items: [],
      };
    }

    const systemInstruction = this.buildSystemInstruction(checklist, callInfo.targetNumber, 'incoming');
    const gemini = new GeminiClient({
      apiKey: this.geminiApiKey,
      voiceName: checklist.voiceName,
      systemInstruction,
      initialPrompt: 'Начни.',
    });
    const geminiPromise = gemini.connect();

    const rtp = new RtpSession({
      remoteHost: callInfo.remoteRtpHost,
      remotePort: callInfo.remoteRtpPort,
      payloadType: callInfo.codec === 'alaw' ? PAYLOAD_PCMA : PAYLOAD_PCMU,
      localPort: allocRtpPort(),
    });

    const localRtpPort = await new Promise<number>((resolve) => {
      rtp.on('ready', (port) => resolve(port));
    });

    callInfo.localRtpPort = localRtpPort;
    this.sipAgent.acceptCall(callInfo);

    await geminiPromise;

    const state: ActiveCallState = {
      callId: callInfo.callId,
      phoneNumber: callInfo.targetNumber,
      customerName: callInfo.targetNumber,
      status: 'connected',
      startTime: new Date().toISOString(),
      duration: 0,
      transcript: [],
      checklistId: checklist.id,
    };

    const session = {
      rtp,
      gemini,
      state,
      audioBuffer: [] as Buffer[],
      durationTimer: setInterval(() => {
        state.duration++;
        this.emit('callStateChanged', { ...state });
      }, 1000),
      sendTimer: undefined as NodeJS.Timeout | undefined,
      lastRtpTime: Date.now(),
      outgoingRtpBuf: Buffer.alloc(0),
      outgoingRtpTimer: undefined as NodeJS.Timeout | undefined,
    };

    this.callSessions.set(callInfo.callId, session);
    this.wireAudioPipeline(callInfo.callId, callInfo.codec);
    gemini.sendInitialPrompt();

    this.emit('callStateChanged', { ...state });
  }

  // ─── Audio pipeline: RTP ↔ G.711 ↔ PCM ↔ Gemini ──────────────────────────

  private wireAudioPipeline(callId: string, codec: 'alaw' | 'ulaw'): void {
    const session = this.callSessions.get(callId);
    if (!session) return;

    const { rtp, gemini } = session;
    const decode = codec === 'alaw' ? alawToPcm : ulawToPcm;
    const encode = codec === 'alaw' ? pcmToAlaw : pcmToUlaw;

    let rtpFrames = 0;
    let lastRtpLog = Date.now();

    // RTP → decode G.711 → upsample 8k→16k → buffer → send to Gemini every 40ms
    // Best practice: 20-40ms chunks для низкой задержки (Vertex AI docs)
    rtp.on('audio', (payload: Buffer) => {
      session.lastRtpTime = Date.now();
      const pcm8k = decode(payload);
      const pcm16k = upsample8to16(pcm8k);

      rtpFrames++;
      session.audioBuffer.push(Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength));
    });

    // Flush audio buffer to Gemini every 20ms (= 1 RTP frame — минимальная задержка буфера)
    session.sendTimer = setInterval(() => {
      const now = Date.now();
      // Таймаут: если RTP не приходит — считаем звонок мёртвым (пропущенный/сброшенный)
      if (now - session.lastRtpTime > NO_RTP_TIMEOUT_MS) {
        if (session.sendTimer) clearInterval(session.sendTimer);
        session.sendTimer = undefined;
        this.emit('log', 'info', `[RTP] call ${callId}: no RTP for ${NO_RTP_TIMEOUT_MS / 1000}s, ending call`);
        this.hangup(callId);
        return;
      }
      if (now - lastRtpLog >= 1000) {
        this.emit(
          'log',
          'info',
          `[RTP] call ${callId}: framesPerSec=${rtpFrames}, bufferedChunks=${session.audioBuffer.length}`,
        );
        rtpFrames = 0;
        lastRtpLog = now;
      }

      if (session.audioBuffer.length === 0) return;
      const combined = Buffer.concat(session.audioBuffer);
      session.audioBuffer = [];
      const pcm16k = new Int16Array(combined.buffer, combined.byteOffset, combined.byteLength / 2);
      gemini.sendAudio(pcm16k);
    }, 20);

    // Gemini → downsample 24k→8k → encode G.711 → outgoing queue
    // Единый drift-компенсирующий таймер (5ms poll) вместо setInterval(20ms):
    //   - process.hrtime.bigint() даёт наносекундную точность без дрифта
    //   - Короткие паузы между чанками (<150ms) не заполняются тишиной —
    //     телефон сам интерполирует (PLC), что звучит естественнее
    //   - Настоящие паузы (>150ms, бот молчит) заполняются тишиной для
    //     поддержания непрерывности RTP-потока в джиттер-буфере
    //   - Очередь НЕ обрезается — весь ответ бота воспроизводится полностью

    const silenceFrame = encode(new Int16Array(SAMPLES_PER_FRAME));
    const FRAME_NS = BigInt(FRAME_DURATION_MS) * 1_000_000n;
    let nextFrameAt = process.hrtime.bigint();
    // Счётчик для периодического (не частого) лога входящего аудио
    let audioChunkCount = 0;
    let lastAudioLogAt = Date.now();

    gemini.on('audio', (pcm24k: Int16Array) => {
      const pcm8k = downsample24to8(pcm24k);
      const g711 = encode(pcm8k);
      session.outgoingRtpBuf = Buffer.concat([session.outgoingRtpBuf, g711]);
      audioChunkCount++;
      // Логируем не чаще раза в секунду — частые логи блокируют event loop
      const now = Date.now();
      if (now - lastAudioLogAt >= 1000) {
        this.emit('log', 'info',
          `[Gemini] call ${callId}: ${audioChunkCount} audio chunks/s, queued=${session.outgoingRtpBuf.length}B`);
        audioChunkCount = 0;
        lastAudioLogAt = now;
      }
    });

    // Таймер опрашивает каждые 5ms: точнее setInterval(20) и компенсирует дрифт.
    // За один тик отправляет не более 3 просроченных фреймов (catch-up при задержке).
    // ВАЖНО: когда буфер пуст — ВСЕГДА посылаем тишину (не пропускаем пакеты).
    // Это гарантирует непрерывный RTP-поток и исключает PLC-артефакты (щелчки/рывки)
    // в паузах между словами, которые Gemini генерирует отдельными пачками.
    session.outgoingRtpTimer = setInterval(() => {
      const now = process.hrtime.bigint();

      // Если event loop был занят >5 фреймов (100ms) — сбрасываем timeline,
      // чтобы не посылать лавину фреймов сразу после паузы
      if (now > nextFrameAt + FRAME_NS * 5n) {
        nextFrameAt = now;
      }

      let sent = 0;
      while (now >= nextFrameAt && sent < 3) {
        if (session.outgoingRtpBuf.length >= SAMPLES_PER_FRAME) {
          const frame = session.outgoingRtpBuf.subarray(0, SAMPLES_PER_FRAME);
          rtp.sendFrame(frame);
          session.outgoingRtpBuf = session.outgoingRtpBuf.subarray(SAMPLES_PER_FRAME);
        } else {
          // Буфер пуст (бот молчит или пауза между словами) — тишина поддерживает
          // непрерывность RTP-потока; телефон не видит пропущенных пакетов
          rtp.sendFrame(silenceFrame);
        }
        nextFrameAt += FRAME_NS;
        sent++;
      }
    }, 5);

    // Transcriptions
    gemini.on('agentTranscript', (text: string) => {
      session.state.transcript.push({ speaker: 'agent', text });
       this.emit(
        'log',
        'info',
        `[Gemini][agent] call ${callId}: ${text.length > 300 ? text.slice(0, 300) + '…' : text}`,
      );
      this.emit('transcript', callId, 'agent', text);
      this.emit('callStateChanged', { ...session.state });
    });

    gemini.on('userTranscript', (text: string) => {
      session.state.transcript.push({ speaker: 'user', text });
      this.emit(
        'log',
        'info',
        `[Gemini][user] call ${callId}: ${text.length > 300 ? text.slice(0, 300) + '…' : text}`,
      );
      this.emit('transcript', callId, 'user', text);
      this.emit('callStateChanged', { ...session.state });
    });

    // Абонент заговорил поверх бота → Gemini шлёт interrupted:true и прекращает генерацию.
    // По официальному best practice Google: немедленно сбрасываем буфер, чтобы телефон
    // не «доигрывал» оставшиеся 2-4 секунды старого ответа — именно они создают паузу.
    gemini.on('interrupted', () => {
      const dropped = session.outgoingRtpBuf.length;
      session.outgoingRtpBuf = Buffer.alloc(0);
      if (dropped > 0) {
        this.emit('log', 'info',
          `[Gemini] call ${callId}: interrupted, dropped ${dropped}B of queued audio`);
      }
    });

    gemini.on('error', (err) => {
      this.emit('log', 'error', `[Gemini] ${err.message}`);
    });

    gemini.on('closed', () => {
      this.emit('log', 'error', `Gemini session closed for call ${callId} (call will continue on SIP side)`);
      // ВАЖНО: не завершаем звонок сразу.
      // Дальше звонок завершится либо по BYE/CANCEL от АТС,
      // либо по явному стопу из интерфейса (через hangup()).
    });

    rtp.on('error', (err) => {
      this.emit('log', 'error', `[RTP] ${err.message}`);
    });
  }

  // ─── Call termination ──────────────────────────────────────────────────────

  hangup(callId: string): void {
    this.sipAgent.hangup(callId);
    this.endCallSession(callId, 'completed');
  }

  /** Находит ключ сессии по callId (точное совпадение или по core до @). */
  private resolveCallSessionId(callId: string): string | undefined {
    if (this.callSessions.has(callId)) return callId;
    const core = (callId || '').split('@')[0]?.trim() || callId;
    for (const k of this.callSessions.keys()) {
      const kCore = k.split('@')[0]?.trim() || k;
      if (core === kCore || k === core) return k;
    }
    return undefined;
  }

  private endCallSession(callId: string, status: 'completed' | 'failed'): void {
    let session = this.callSessions.get(callId);
    if (!session) {
      // Fallback: АТС может слать Call-ID с @host, у нас — без. Ищем по core.
      const core = (callId || '').split('@')[0]?.trim() || callId;
      for (const [k, s] of this.callSessions) {
        const kCore = k.split('@')[0]?.trim() || k;
        if (core === kCore || k === core) {
          session = s;
          callId = k;
          break;
        }
      }
    }
    if (!session) return;

    if (session.durationTimer) clearInterval(session.durationTimer);
    if (session.sendTimer) clearInterval(session.sendTimer);
    if (session.outgoingRtpTimer) clearInterval(session.outgoingRtpTimer);
    session.outgoingRtpBuf = Buffer.alloc(0);

    session.gemini.close();
    session.rtp.close();

    session.state.status = 'ended';

    // Сообщаем фронтенду финальное состояние вызова (status = 'ended'),
    // чтобы UI мог корректно закрыть окно активного звонка по callState.
    this.emit('callStateChanged', { ...session.state });

    const log: CallLog = {
      id: callId,
      phoneNumber: session.state.phoneNumber,
      customerName: session.state.customerName,
      status,
      startTime: session.state.startTime,
      endTime: new Date().toISOString(),
      transcript: session.state.transcript,
      summary: this.generateSummary(session.state.transcript),
      checklistId: session.state.checklistId,
    };

    this.callHistory.push(log);
    this.callSessions.delete(callId);

    this.emit('callEnded', log);
    this.emit('log', 'info', `Call ended: ${callId} (${status})`);
  }

  private generateSummary(transcript: { speaker: string; text: string }[]): string {
    if (transcript.length === 0) return 'Нет данных.';
    const userLines = transcript.filter(t => t.speaker === 'user').length;
    const agentLines = transcript.filter(t => t.speaker === 'agent').length;
    return `Опрос завершен. Реплик агента: ${agentLines}, реплик клиента: ${userLines}.`;
  }

  private buildSystemInstruction(checklist: Checklist, customerName: string, callMode: 'outgoing' | 'incoming' = 'outgoing'): string {
    const firstPhrase =
      callMode === 'outgoing'
        ? 'ПЕРВАЯ ФРАЗА: дождись когда абонент скажет «Алло» или ответит. Услышав его — поприветствуй коротко: Алло, здравствуйте! Назови себя, компанию, опрос, спроси можно ли пару минут.'
        : 'ПЕРВАЯ ФРАЗА: сразу при подключении поприветствуй: Алло, здравствуйте! Назови себя, компанию, опрос, спроси можно ли пару минут. Не жди ответа — ты говоришь первым.';
    return `Ты — администратор. Обычный человек, который отвечает на звонки. Клиента зовут ${customerName}. Тема: "${checklist.title}".

${firstPhrase}

ИНТОНАЦИЯ И ФРАЗЫ (важно, чтобы не звучать как бот):
- Говори ЦЕЛЫМИ ФРАЗАМИ и мыслями, а не отдельными словами. Каждая твоя реплика должна быть законченной фразой с естественной интонацией (подъём/спад к концу), как у человека.
- НЕ произноси слово за словом с ровной интонацией — это выдаёт бота. Объединяй слова в смысловые группы: "Так, а как вас зовут?" — одна фраза с одной интонационной дугой, а не "Так. А. Как. Вас. Зовут."
- Паузы — только между фразами, не между словами внутри фразы.
- Пример правильной фразы: "Ммм, понял, сейчас посмотрю" (одна мысль, одна интонация). Пример неправильно: "Ммм. Понял. Сейчас. Посмотрю." (рубленые слова).

КОГДА ТЫ ЗВУЧИШЬ ПО-ЧЕЛОВЕЧЕСКИ:
- Не перебарщивай с энтузиазмом. Спокойная уверенность, не "радость 24/7".
- Используй разговорные слова: "ну", "так", "ага", "мм", "да", "это самое".
- Начинай фразы с "И", "Так", "Ну" — люди так делают.
- Делай паузы. Не тараторь. После "мм" или "так" — небольшая пауза перед продолжением.
- Реагируй на ответ клиента перед новым вопросом: "Понял", "Ага", "Записал".

ЧТО ГОВОРИТЬ / НЕ ГОВОРИТЬ:
Плохо (звучит как бот): "Я внимательно вас слушаю", "Отлично! С удовольствием помогу!", "Рад быть полезным!", "Безусловно!", "Несомненно!"
Хорошо: "Слушаю", "Да, понял", "Сейчас посмотрю", "Окей", "Сделаем".
Плохо: "Прекрасно! Как я могу к вам обращаться?"
Хорошо: "Так, а как вас зовут?" или "Ммм, как к вам обращаться?"
Плохо: ровный, грамотный, "написанный" текст.
Хорошо: живая разговорная речь, иногда неполные фразы, перебивание себя.

ЗАПРЕЩЕНО: "безусловно", "несомненно", "с удовольствием", "рад помочь", "чем могу быть полезен", "отличный день", "прекрасный", "замечательно" (слишком часто), восклицательные интонации в каждой фразе.

Твои задачи в этом разговоре:
${checklist.items.map((it) => `- ${it}`).join('\n')}

В конце попрощайся коротко и по-человечески: "Ну всё, удачи" или "Хорошего дня" — без пафоса.`;
  }

  // ─── Getters ───────────────────────────────────────────────────────────────

  get sipRegistered(): boolean {
    return this.sipAgent.isRegistered;
  }

  getActiveCalls(): ActiveCallState[] {
    return Array.from(this.callSessions.values()).map(s => ({ ...s.state }));
  }

  getCallHistory(): CallLog[] {
    return [...this.callHistory];
  }

  getCallState(callId: string): ActiveCallState | undefined {
    const session = this.callSessions.get(callId);
    return session ? { ...session.state } : undefined;
  }
}
