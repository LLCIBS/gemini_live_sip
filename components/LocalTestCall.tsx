import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { PhoneContact, Checklist, CallLog } from '../types';
import { encode, decode, decodeAudioData } from '../utils/audio-utils';

interface LocalTestCallProps {
  contact: PhoneContact;
  checklist: Checklist;
  onFinished: (log: CallLog) => void;
  onClose: () => void;
}

const LocalTestCall: React.FC<LocalTestCallProps> = ({ contact, checklist, onFinished, onClose }) => {
  const [status, setStatus] = useState<'initiating' | 'connected' | 'ended'>('initiating');
  const [duration, setDuration] = useState(0);
  const [transcription, setTranscription] = useState<{ speaker: 'agent' | 'user'; text: string }[]>([]);
  const [isMuted, setIsMuted] = useState(false);

  const timerRef = useRef<number | null>(null);
  const sessionRef = useRef<any>(null);
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const statusRef = useRef<'initiating' | 'connected' | 'ended'>('initiating');
  const transcriptionRef = useRef<{ speaker: 'agent' | 'user'; text: string }[]>([]);
  const hasConnectedRef = useRef(false);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    transcriptionRef.current = transcription;
  }, [transcription]);

  const systemInstruction = `Ты — профессиональный и вежливый голосовой ассистент службы поддержки.
Твоя задача — провести тестовый опрос клиента по имени ${contact.name}.
Это тестовый режим через браузер, без реального звонка.
Тема опроса: ${checklist.title}.
Твои шаги (чек-лист):
${checklist.items.map((it, i) => `${i + 1}. ${it}`).join('\n')}

ПРАВИЛА:
1. Говори только на русском языке.
2. Используй естественный, дружелюбный, человекоподобный голос.
3. Дождись ответа на каждый пункт чек-листа перед тем, как переходить к следующему.
4. В конце обязательно поблагодари за уделенное время.
5. Не используй текстовую разметку (Markdown), только чистую речь.`;

  useEffect(() => {
    const fastConnect = setTimeout(() => {
      handleConnect();
    }, 1000);
    return () => {
      clearTimeout(fastConnect);
      stopCall();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status === 'connected') {
      timerRef.current = window.setInterval(() => {
        setDuration(prev => prev + 1);
      }, 1000);
    } else if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status]);

  const handleConnect = async () => {
    try {
      hasConnectedRef.current = true;
      setStatus('connected');
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: checklist.voiceName || 'Kore' } },
          },
          systemInstruction,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            if (!audioContextInRef.current) return;

            const source = audioContextInRef.current.createMediaStreamSource(stream);
            const scriptProcessor = audioContextInRef.current.createScriptProcessor(4096, 1, 1);

            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };

              sessionPromise.then(session => {
                if (session && !isMuted && audioContextInRef.current?.state === 'running') {
                  session.sendRealtimeInput({ media: pcmBlob });
                }
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && audioContextOutRef.current && audioContextOutRef.current.state !== 'closed') {
              const ctx = audioContextOutRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
            }

            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              setTranscription(prev => [...prev, { speaker: 'agent', text }]);
            } else if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              setTranscription(prev => [...prev, { speaker: 'user', text }]);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => {
                try { s.stop(); } catch (e) { /* ignore */ }
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => console.error('Gemini Live Error:', e),
          onclose: () => console.log('Gemini Live Session Closed'),
        },
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error('Connection failed', err);
      setStatus('ended');
    }
  };

  const stopCall = () => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) { /* ignore */ }
      sessionRef.current = null;
    }

    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch (e) { /* ignore */ }
    });
    sourcesRef.current.clear();

    if (audioContextInRef.current && audioContextInRef.current.state !== 'closed') {
      try { audioContextInRef.current.close(); } catch (e) { /* ignore */ }
    }
    audioContextInRef.current = null;

    if (audioContextOutRef.current && audioContextOutRef.current.state !== 'closed') {
      try { audioContextOutRef.current.close(); } catch (e) { /* ignore */ }
    }
    audioContextOutRef.current = null;

    if (statusRef.current !== 'ended') {
      statusRef.current = 'ended';
      setStatus('ended');

      if (hasConnectedRef.current) {
        const finalLog: CallLog = {
          id: Date.now().toString(),
          phoneNumber: contact.number,
          customerName: contact.name,
          status: 'completed',
          startTime: new Date().toISOString(),
          transcript: transcriptionRef.current,
          summary: 'Локальное тестирование завершено.',
          checklistId: checklist.id,
        };
        onFinished(finalLog);
      }
    }
  };

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/95 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-white w-full max-w-4xl rounded-3xl overflow-hidden shadow-2xl flex flex-col md:flex-row h-[80vh] border border-white/10">
        <div className="flex-1 p-8 flex flex-col items-center justify-center text-white relative transition-colors duration-1000 bg-gradient-to-b from-slate-700 to-slate-900">
          <button
            onClick={onClose}
            className="absolute top-6 left-6 text-white/50 hover:text-white transition-colors flex items-center gap-2"
          >
            <i className="fas fa-arrow-left" /> Завершить тест
          </button>

          <div className="absolute top-6 right-6">
            <span className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-400 border border-amber-500/30">
              <i className="fas fa-laptop mr-1" />
              Local Simulation
            </span>
          </div>

          <div className="relative mb-8">
            <div className={`w-32 h-32 rounded-full border-4 border-white/20 flex items-center justify-center text-4xl bg-white/10 ${
              status === 'connected' ? 'animate-pulse ring-8 ring-white/5' : ''
            }`}
            >
              <i className="fas fa-robot" />
            </div>
            {status === 'connected' && (
              <div className="absolute -bottom-2 -right-2 w-8 h-8 rounded-full border-4 bg-amber-500 border-slate-800 flex items-center justify-center text-[10px]">
                <i className="fas fa-microphone" />
              </div>
            )}
          </div>

          <h3 className="text-2xl font-bold">{contact.name}</h3>
          <p className="text-white/60 mt-1">Браузерная отладка</p>

          <div className="mt-8 text-center min-h-[100px] flex flex-col items-center justify-center">
            {status === 'initiating' && (
              <p className="text-white/60 flex items-center gap-2">
                <i className="fas fa-spinner animate-spin" /> Подготовка сессии...
              </p>
            )}
            {status === 'connected' && (
              <div className="space-y-6">
                <p className="text-emerald-300 font-mono text-3xl tracking-tighter">{formatTime(duration)}</p>
                <div className="flex gap-2 items-end h-16">
                  {[...Array(12)].map((_, i) => (
                    <div
                      // eslint-disable-next-line react/no-array-index-key
                      key={i}
                      className="w-1.5 bg-white/30 rounded-full transition-all duration-150"
                      style={{
                        height: `${20 + Math.random() * 80}%`,
                        opacity: 0.3 + Math.random() * 0.7,
                        animation: `pulse ${0.5 + Math.random()}s infinite alternate`,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="mt-auto pt-8 flex gap-6">
            <button
              onClick={() => setIsMuted(!isMuted)}
              className={`w-14 h-14 rounded-full flex items-center justify-center text-xl shadow-lg transition-all transform active:scale-95 ${
                isMuted ? 'bg-amber-500 text-white rotate-12' : 'bg-white/10 hover:bg-white/20 text-white'
              }`}
            >
              <i className={`fas ${isMuted ? 'fa-microphone-slash' : 'fa-microphone'}`} />
            </button>
            <button
              onClick={stopCall}
              className="w-16 h-16 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center text-2xl text-white shadow-2xl shadow-red-500/40 transform active:scale-90 transition-all"
            >
              <i className="fas fa-phone-slash" />
            </button>
          </div>
        </div>

        <div className="w-full md:w-[400px] flex flex-col bg-slate-50">
          <div className="p-6 border-b border-slate-200 bg-white">
            <div className="flex items-center justify-between mb-1">
              <h4 className="font-bold text-slate-800 flex items-center gap-2 text-sm">
                <i className="fas fa-tasks text-indigo-500" />
                Сценарий опроса
              </h4>
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Active</span>
            </div>
            <p className="text-xs text-slate-500 font-medium truncate">{checklist.title}</p>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <section>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Состояние чек-листа</p>
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-3">
                {checklist.items.map((item, i) => (
                  <div key={item + i} className="flex items-start gap-3 group">
                    <div className="mt-0.5 w-4 h-4 rounded-full border-2 border-slate-100 flex items-center justify-center group-hover:border-indigo-200 transition-colors">
                      <div className="w-1.5 h-1.5 rounded-full bg-slate-100 group-hover:bg-indigo-200 transition-colors" />
                    </div>
                    <span className="text-[11px] leading-relaxed text-slate-600">{item}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="flex-1">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Живой диалог</p>
              <div className="space-y-4">
                {transcription.length === 0 && (
                  <div className="bg-slate-100/50 rounded-2xl p-8 border border-dashed border-slate-200 text-center">
                    <p className="text-[11px] text-slate-400 italic">Слушаю эфир...</p>
                  </div>
                )}
                {transcription.slice(-6).map((line, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <div key={i} className={`flex flex-col ${line.speaker === 'agent' ? 'items-end' : 'items-start'}`}>
                    <span className="text-[9px] font-bold text-slate-400 mb-1 px-1">
                      {line.speaker === 'agent' ? 'ASSISTANT' : 'CUSTOMER'}
                    </span>
                    <div
                      className={`max-w-[90%] rounded-2xl px-4 py-2.5 text-xs shadow-sm transition-all duration-300 animate-in fade-in slide-in-from-bottom-2 ${
                        line.speaker === 'agent'
                          ? 'bg-indigo-600 text-white rounded-tr-none'
                          : 'bg-white text-slate-700 rounded-tl-none border border-slate-200'
                      }`}
                    >
                      {line.text}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="p-4 bg-white border-t border-slate-200">
            <div className="flex items-center gap-3 text-slate-400">
              <div className="flex-1 h-1 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 w-[15%] transition-all duration-500" />
              </div>
              <span className="text-[10px] font-bold">Голос: {checklist.voiceName || 'Kore'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LocalTestCall;

