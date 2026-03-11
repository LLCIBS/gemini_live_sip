import {
  GoogleGenAI,
  Modality,
  EndSensitivity,
  StartSensitivity,
  TurnCoverage,
  type LiveServerMessage,
  type Session,
} from '@google/genai';
import { EventEmitter } from 'events';
import { pcmToBase64, base64ToPcm } from './g711.js';

export interface GeminiSessionConfig {
  apiKey: string;
  voiceName?: string;
  systemInstruction: string;
  /** Если задано — отправить сразу при открытии сессии (минимальная задержка до первого ответа) */
  initialPrompt?: string;
}

export declare interface GeminiClient {
  on(event: 'audio', listener: (pcm16k: Int16Array) => void): this;
  on(event: 'agentTranscript', listener: (text: string) => void): this;
  on(event: 'userTranscript', listener: (text: string) => void): this;
  on(event: 'interrupted', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'closed', listener: () => void): this;
}

/**
 * Server-side wrapper around Gemini Live API.
 * Receives PCM 16-bit 16kHz input, emits PCM 16-bit 24kHz output.
 */
export class GeminiClient extends EventEmitter {
  private session: Session | null = null;
  private config: GeminiSessionConfig;
  private _closed = false;

  constructor(config: GeminiSessionConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    console.log('[Gemini] Opening Live session...');

    const ai = new GoogleGenAI({ apiKey: this.config.apiKey });

    this.session = await ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          languageCode: 'ru-RU',
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this.config.voiceName || 'Kore',
            },
          },
        },
        systemInstruction: this.config.systemInstruction,
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        // thinkingBudget: 0 — отключает «размышления» модели. По бенчмаркам даёт ~73% ускорение TTFT
        // (1879ms → 503ms для Flash; native-audio может выиграть аналогично)
        thinkingConfig: { thinkingBudget: 0 },
        // VAD: быстрое определение конца речи → меньше пауза перед ответом бота
        // silence_duration_ms = 300мс — Gemini начинает отвечать через 300мс тишины
        //   (было 500; ниже 250 риск обрезать паузы внутри фразы)
        // END_SENSITIVITY_HIGH — агрессивнее засекает конец реплики абонента
        // START_SENSITIVITY_HIGH — быстрее замечает начало речи
        // TURN_INCLUDES_ONLY_ACTIVITY — в контекст идёт только активная речь, не тишина
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
            prefixPaddingMs: 50,
            silenceDurationMs: 300,
          },
          turnCoverage: TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY,
        },
      },
      callbacks: {
        onopen: () => {
          console.log('[Gemini] Live session opened');
        },
        onmessage: (message: LiveServerMessage) => {
          this.handleMessage(message);
        },
        onerror: (e: any) => {
          // Выведем подробности в stdout, чтобы видеть коды/причины.
          console.error('[Gemini] Live onerror:', e);
          if (!this._closed) {
            this.emit('error', new Error(`Gemini Live error: ${e?.message || e}`));
          }
        },
        onclose: (e: any) => {
          // Логируем код/причину закрытия WebSocket, если есть.
          const code = e?.code;
          const reason = e?.reason;
          const wasClean = e?.wasClean;
          console.log('[Gemini] Live session closed', { code, reason, wasClean });
          this._closed = true;
          this.emit('closed');
        },
      },
    });
  }

  /**
   * Отправить стартовый триггер (после того как wireAudioPipeline привязал on('audio')).
   * Вызывать только когда слушатель аудио уже подключён — иначе первые чанки потеряются.
   */
  sendInitialPrompt(): void {
    const prompt = this.config.initialPrompt || 'Начни.';
    if (this._closed || !this.session) return;
    try {
      this.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: prompt }] }],
        turnComplete: true,
      });
    } catch (err) {
      this.emit('error', new Error(`Failed to send initial prompt: ${(err as Error).message}`));
    }
  }

  private handleMessage(message: LiveServerMessage): void {
    // Audio data from model — перебираем все parts (модель может прислать несколько чанков в одном turn)
    const parts = message.serverContent?.modelTurn?.parts ?? [];
    for (const part of parts) {
      const audioData = part?.inlineData?.data;
      if (audioData) {
        try {
          const pcm24k = base64ToPcm(audioData);
          this.emit('audio', pcm24k);
        } catch (err) {
          this.emit('error', new Error(`Failed to decode Gemini audio: ${err}`));
        }
      }
    }

    // Output transcription (what the AI said)
    if (message.serverContent?.outputTranscription?.text) {
      this.emit('agentTranscript', message.serverContent.outputTranscription.text);
    }

    // Input transcription (what the user/caller said)
    if (message.serverContent?.inputTranscription?.text) {
      this.emit('userTranscript', message.serverContent.inputTranscription.text);
    }

    // Interrupted (caller spoke over the AI)
    if (message.serverContent?.interrupted) {
      this.emit('interrupted');
    }
  }

  /**
   * Send PCM 16-bit 16kHz audio to Gemini.
   */
  sendAudio(pcm16k: Int16Array): void {
    if (this._closed || !this.session) return;
    try {
      const b64 = pcmToBase64(pcm16k);
      this.session.sendRealtimeInput({
        media: {
          data: b64,
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    } catch (err) {
      this.emit('error', new Error(`Failed to send audio to Gemini: ${err}`));
    }
  }

  /**
   * Send a text message to trigger Gemini to speak first (initial greeting).
   */
  sendText(text: string): void {
    if (this._closed || !this.session) return;
    try {
      this.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      });
    } catch (err) {
      this.emit('error', new Error(`Failed to send text to Gemini: ${err}`));
    }
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this.session?.close();
    } catch {
      // ignore
    }
    this.session = null;
    this.removeAllListeners();
  }

  get closed(): boolean {
    return this._closed;
  }
}
