
import React, { useState } from 'react';
import { CallLog } from '../types';

interface ResultsHistoryProps {
  callLogs: CallLog[];
}

const ResultsHistory: React.FC<ResultsHistoryProps> = ({ callLogs }) => {
  const [selectedLog, setSelectedLog] = useState<CallLog | null>(null);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-slate-800">История опросов</h2>
        <p className="text-slate-500 mt-1">Просматривайте результаты и слушайте записи завершенных звонков.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-4">
          {callLogs.length === 0 ? (
            <div className="bg-white border-2 border-dashed border-slate-200 rounded-2xl p-12 text-center text-slate-400">
              <i className="fas fa-box-open text-4xl mb-4"></i>
              <p>Здесь пока нет завершенных опросов.</p>
            </div>
          ) : (
            callLogs.map(log => (
              <div 
                key={log.id} 
                onClick={() => setSelectedLog(log)}
                className={`bg-white p-5 rounded-2xl border transition-all cursor-pointer ${
                  selectedLog?.id === log.id ? 'border-indigo-500 shadow-md ring-1 ring-indigo-500/20' : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="flex justify-between items-start">
                  <div className="flex gap-4 items-center">
                    <div className="w-10 h-10 rounded-full bg-slate-50 flex items-center justify-center text-slate-400">
                      <i className="fas fa-file-invoice"></i>
                    </div>
                    <div>
                      <h4 className="font-bold text-slate-800">{log.customerName}</h4>
                      <p className="text-xs text-slate-500">{log.phoneNumber} • {new Date(log.startTime).toLocaleString('ru-RU')}</p>
                    </div>
                  </div>
                  <span className="px-3 py-1 bg-emerald-50 text-emerald-600 rounded-full text-[10px] font-bold uppercase tracking-wider">
                    Успешно
                  </span>
                </div>
                {log.summary && (
                  <p className="mt-4 text-sm text-slate-600 bg-slate-50 p-3 rounded-lg border border-slate-100">
                    <i className="fas fa-magic text-indigo-400 mr-2"></i>
                    {log.summary}
                  </p>
                )}
              </div>
            ))
          )}
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200 p-6 sticky top-8 shadow-sm h-fit">
            <h3 className="font-bold text-lg mb-6 flex items-center gap-2">
              <i className="fas fa-microscope text-indigo-500"></i>
              Детализация
            </h3>
            
            {selectedLog ? (
              <div className="space-y-6">
                <div>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Транскрипция разговора</p>
                  <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2">
                    {selectedLog.transcript.length === 0 && <p className="text-xs text-slate-400">Нет данных транскрипции.</p>}
                    {selectedLog.transcript.map((t, idx) => (
                      <div key={idx} className="space-y-1">
                        <p className={`text-[10px] font-bold uppercase ${t.speaker === 'agent' ? 'text-indigo-500' : 'text-slate-400'}`}>
                          {t.speaker === 'agent' ? 'Ассистент' : 'Клиент'}
                        </p>
                        <p className="text-xs text-slate-700 bg-slate-50 p-2 rounded-lg leading-relaxed">
                          {t.text}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
                
                <div className="pt-4 border-t border-slate-100">
                   <button className="w-full bg-slate-800 text-white py-3 rounded-xl font-medium text-sm flex items-center justify-center gap-2">
                     <i className="fas fa-download"></i> Экспорт PDF
                   </button>
                </div>
              </div>
            ) : (
              <div className="py-20 text-center text-slate-400">
                <p className="text-sm italic">Выберите звонок для просмотра подробностей.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ResultsHistory;
