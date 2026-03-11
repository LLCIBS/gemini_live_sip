
import React, { useState, useRef } from 'react';
import { Checklist } from '../types';
import { GoogleGenAI, Modality } from "@google/genai";
import { decode, decodeAudioData } from '../utils/audio-utils';

interface ChecklistsManagerProps {
  checklists: Checklist[];
  setChecklists: React.Dispatch<React.SetStateAction<Checklist[]>>;
}

const VOICES = [
  { id: 'Zephyr', label: 'Zephyr', desc: 'Дружелюбный' },
  { id: 'Kore', label: 'Kore', desc: 'Деловой' },
  { id: 'Puck', label: 'Puck', desc: 'Энергичный' },
  { id: 'Charon', label: 'Charon', desc: 'Спокойный' },
  { id: 'Fenrir', label: 'Fenrir', desc: 'Глубокий' }
] as const;

const ChecklistsManager: React.FC<ChecklistsManagerProps> = ({ checklists, setChecklists }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const handleAdd = () => {
    const fresh: Checklist = {
      id: Date.now().toString(),
      title: 'Новый чек-лист',
      description: 'Описание сценария',
      items: ['Первый вопрос', 'Второй вопрос'],
      voiceName: 'Kore'
    };
    setChecklists([...checklists, fresh]);
    setEditingId(fresh.id);
  };

  const handleSave = (id: string) => {
    setEditingId(null);
  };

  const handleDelete = (id: string) => {
    setChecklists(checklists.filter(c => c.id !== id));
  };

  const updateField = (id: string, field: keyof Checklist, value: any) => {
    setChecklists(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
  };

  const playVoicePreview = async (voiceName: string) => {
    if (previewingId) return;
    setPreviewingId(voiceName);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Скажи приветливо на русском: Привет! Я ${voiceName}. Я буду проводить ваш опрос этим голосом.` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        if (!audioContextRef.current) {
          audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        }
        const ctx = audioContextRef.current;
        const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        source.onended = () => setPreviewingId(null);
        source.start();
      } else {
        setPreviewingId(null);
      }
    } catch (error) {
      console.error("TTS Preview failed", error);
      setPreviewingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-3xl font-bold text-slate-800">Сценарии опросов</h2>
          <p className="text-slate-500 mt-1">Определите темы и вопросы, которые AI будет задавать клиентам.</p>
        </div>
        <button 
          onClick={handleAdd}
          className="bg-indigo-600 text-white px-4 py-2 rounded-xl font-medium shadow-sm hover:bg-indigo-700 transition-all flex items-center gap-2"
        >
          <i className="fas fa-plus"></i> Создать новый
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {checklists.map(checklist => (
          <div key={checklist.id} className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm flex flex-col">
            {editingId === checklist.id ? (
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Название сценария</label>
                  <input 
                    className="w-full text-lg font-bold p-2 border-b focus:outline-none focus:border-indigo-500"
                    value={checklist.title}
                    onChange={(e) => updateField(checklist.id, 'title', e.target.value)}
                  />
                </div>
                
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Голос ассистента</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {VOICES.map(voice => (
                      <div 
                        key={voice.id}
                        className={`group relative flex items-center p-2 rounded-lg border transition-all ${
                          checklist.voiceName === voice.id 
                            ? 'border-indigo-500 bg-indigo-50' 
                            : 'border-slate-100 hover:border-slate-200 bg-slate-50'
                        }`}
                      >
                        <button
                          onClick={() => updateField(checklist.id, 'voiceName', voice.id)}
                          className="flex-1 text-left outline-none"
                        >
                          <p className={`text-[11px] font-bold ${checklist.voiceName === voice.id ? 'text-indigo-600' : 'text-slate-700'}`}>{voice.label}</p>
                          <p className="text-[9px] text-slate-400">{voice.desc}</p>
                        </button>
                        <button 
                          onClick={(e) => { e.stopPropagation(); playVoicePreview(voice.id); }}
                          disabled={previewingId === voice.id}
                          className={`ml-2 w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                            previewingId === voice.id 
                              ? 'bg-indigo-600 text-white animate-pulse' 
                              : 'bg-white text-indigo-600 border border-indigo-100 hover:bg-indigo-50 shadow-sm'
                          }`}
                          title="Прослушать голос"
                        >
                          <i className={`fas ${previewingId === voice.id ? 'fa-spinner fa-spin' : 'fa-play text-[10px]'}`}></i>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Вопросы (один на строку)</label>
                  <textarea 
                    className="w-full text-sm p-3 bg-slate-50 border border-slate-100 rounded-lg min-h-[120px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    placeholder="Введите вопросы..."
                    value={checklist.items.join('\n')}
                    onChange={(e) => updateField(checklist.id, 'items', e.target.value.split('\n'))}
                  />
                </div>
                
                <button 
                  onClick={() => handleSave(checklist.id)}
                  className="w-full bg-emerald-600 text-white py-3 rounded-xl font-bold shadow-md shadow-emerald-100 transition-transform active:scale-95"
                >
                  Сохранить изменения
                </button>
              </div>
            ) : (
              <>
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-bold text-xl text-slate-800">{checklist.title}</h3>
                      <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1">
                        <i className="fas fa-volume-up text-[8px]"></i>
                        {checklist.voiceName || 'Kore'}
                      </span>
                    </div>
                    <p className="text-sm text-slate-500">{checklist.description}</p>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => setEditingId(checklist.id)} className="text-slate-400 hover:text-indigo-600 p-2 transition-colors"><i className="fas fa-edit"></i></button>
                    <button onClick={() => handleDelete(checklist.id)} className="text-slate-400 hover:text-red-600 p-2 transition-colors"><i className="fas fa-trash"></i></button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto max-h-[150px] pr-2 custom-scrollbar">
                  <ul className="space-y-2">
                    {checklist.items.map((item, idx) => (
                      <li key={idx} className="text-sm text-slate-600 flex items-start gap-3 p-2 bg-slate-50/50 rounded-lg border border-transparent hover:border-slate-100">
                        <span className="mt-0.5 w-4 h-4 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center text-[9px] font-bold shrink-0">{idx + 1}</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default ChecklistsManager;
