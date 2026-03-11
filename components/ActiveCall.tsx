
import React, { useState, useEffect, useRef } from 'react';
import { PhoneContact, Checklist, CallLog } from '../types';
import { apiPost, wsClient, type WsMessage } from '../utils/api';

interface ActiveCallProps {
  callId: string;
  contact: PhoneContact;
  checklist: Checklist;
  onFinished: (log: CallLog) => void;
  onClose: () => void;
}

const ActiveCall: React.FC<ActiveCallProps> = ({ callId, contact, checklist, onFinished, onClose }) => {
  const [status, setStatus] = useState<'initiating' | 'ringing' | 'connected' | 'ended'>('connected');
  const [duration, setDuration] = useState(0);
  const [transcription, setTranscription] = useState<{ speaker: 'agent' | 'user'; text: string }[]>([]);
  
  const timerRef = useRef<number | null>(null);
  const endedRef = useRef(false);

  // Duration timer
  useEffect(() => {
    if (status === 'connected') {
      timerRef.current = window.setInterval(() => {
        setDuration(prev => prev + 1);
      }, 1000);
    }
    return () => { 
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [status]);

  // WebSocket subscription for real-time call data
  useEffect(() => {
    return wsClient.subscribe((msg: WsMessage) => {
      if (msg.type === 'transcript' && msg.data.callId === callId) {
        setTranscription(prev => [...prev, { speaker: msg.data.speaker, text: msg.data.text }]);
      }
      if (msg.type === 'callState' && msg.data.callId === callId) {
        if (msg.data.status === 'ended' && !endedRef.current) {
          endedRef.current = true;
          setStatus('ended');
        }
      }
      if (msg.type === 'callEnded' && msg.data.id === callId) {
        if (!endedRef.current) {
          endedRef.current = true;
          setStatus('ended');
          onFinished(msg.data);
          // Для входящих вызовов, когда клиент кладёт трубку, автоматически
          // закрываем окно активного звонка, чтобы не "зависал" полноэкранный оверлей.
          onClose();
        }
      }
    });
  }, [callId, onFinished, onClose]);

  const stopCall = async () => {
    if (endedRef.current) return;
    endedRef.current = true;
    setStatus('ended');
    try {
      await apiPost('/api/call/stop', { callId });
    } catch {
      // Server might already have ended the call
    }
    onFinished({
      id: callId,
      phoneNumber: contact.number,
      customerName: contact.name,
      status: 'completed',
      startTime: new Date().toISOString(),
      transcript: transcription,
      summary: 'Опрос завершён через SIP-канал.'
    });
  };

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/95 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-white w-full max-w-4xl rounded-3xl overflow-hidden shadow-2xl flex flex-col md:flex-row h-[80vh] border border-white/10">
        
        {/* Call Visualizer Side */}
        <div className="flex-1 p-8 flex flex-col items-center justify-center text-white relative transition-colors duration-1000 bg-gradient-to-b from-indigo-600 to-indigo-900">
          <button 
            onClick={() => { stopCall(); onClose(); }}
            className="absolute top-6 left-6 text-white/50 hover:text-white transition-colors flex items-center gap-2"
          >
            <i className="fas fa-arrow-left"></i> Назад
          </button>

          <div className="absolute top-6 right-6">
            <span className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
              <i className="fas fa-server mr-1"></i>
              Server SIP Call
            </span>
          </div>

          <div className="relative mb-8">
            <div className={`w-32 h-32 rounded-full border-4 border-white/20 flex items-center justify-center text-4xl bg-white/10 ${
              status === 'connected' ? 'animate-pulse ring-8 ring-white/5' : ''
            }`}>
              <i className="fas fa-user"></i>
            </div>
            {status === 'connected' && (
              <div className="absolute -bottom-2 -right-2 w-8 h-8 rounded-full border-4 bg-emerald-500 border-indigo-700 flex items-center justify-center text-[10px]">
                <i className="fas fa-phone"></i>
              </div>
            )}
          </div>

          <h3 className="text-2xl font-bold">{contact.name}</h3>
          <p className="text-white/60 mt-1">{contact.number}</p>
          
          <div className="mt-8 text-center min-h-[100px] flex flex-col items-center justify-center">
            {status === 'initiating' && <p className="text-white/60 flex items-center gap-2"><i className="fas fa-spinner animate-spin"></i> Подготовка...</p>}
            {status === 'connected' && (
              <div className="space-y-6">
                <p className="text-emerald-300 font-mono text-3xl tracking-tighter">{formatTime(duration)}</p>
                <div className="flex gap-2 items-end h-16">
                  {[...Array(12)].map((_, i) => (
                    <div 
                      key={i} 
                      className="w-1.5 bg-white/30 rounded-full transition-all duration-150"
                      style={{ 
                        height: `${20 + Math.random() * 80}%`,
                        opacity: 0.3 + Math.random() * 0.7,
                        animation: `pulse ${0.5 + Math.random()}s infinite alternate`
                      }}
                    ></div>
                  ))}
                </div>
              </div>
            )}
            {status === 'ended' && (
              <p className="text-white/60">Звонок завершён</p>
            )}
          </div>

          <div className="mt-auto pt-8 flex gap-6">
            <button 
              onClick={stopCall}
              disabled={status === 'ended'}
              className="w-16 h-16 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center text-2xl text-white shadow-2xl shadow-red-500/40 transform active:scale-90 transition-all disabled:opacity-50"
            >
              <i className="fas fa-phone-slash"></i>
            </button>
          </div>
        </div>

        {/* Real-time Transcript Side */}
        <div className="w-full md:w-[400px] flex flex-col bg-slate-50">
          <div className="p-6 border-b border-slate-200 bg-white">
            <div className="flex items-center justify-between mb-1">
              <h4 className="font-bold text-slate-800 flex items-center gap-2 text-sm">
                <i className="fas fa-tasks text-indigo-500"></i>
                Сценарий
              </h4>
              <span className="text-[10px] text-emerald-500 font-bold uppercase tracking-widest animate-pulse">Live</span>
            </div>
            <p className="text-xs text-slate-500 font-medium truncate">{checklist.title}</p>
          </div>
          
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <section className="flex-1">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Диалог в реальном времени</p>
              <div className="space-y-4">
                {transcription.length === 0 && (
                  <div className="bg-slate-100/50 rounded-2xl p-8 border border-dashed border-slate-200 text-center">
                    <p className="text-[11px] text-slate-400 italic">Ожидание начала диалога...</p>
                  </div>
                )}
                {transcription.slice(-8).map((line, i) => (
                  <div key={i} className={`flex flex-col ${line.speaker === 'agent' ? 'items-end' : 'items-start'}`}>
                    <span className="text-[9px] font-bold text-slate-400 mb-1 px-1">
                      {line.speaker === 'agent' ? 'AI АГЕНТ' : 'КЛИЕНТ'}
                    </span>
                    <div className={`max-w-[90%] rounded-2xl px-4 py-2.5 text-xs shadow-sm transition-all duration-300 ${
                      line.speaker === 'agent' 
                        ? 'bg-indigo-600 text-white rounded-tr-none' 
                        : 'bg-white text-slate-700 rounded-tl-none border border-slate-200'
                    }`}>
                      {line.text}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="p-4 bg-white border-t border-slate-200">
             <p className="text-[10px] text-slate-400 text-center italic">Аудио обрабатывается на сервере через Gemini Live</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ActiveCall;
