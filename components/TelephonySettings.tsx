
import React, { useState, useEffect } from 'react';
import { PhoneContact, SipConfig, Checklist } from '../types';
import { apiPost, apiGet, wsClient, type WsMessage } from '../utils/api';

interface TelephonySettingsProps {
  contacts: PhoneContact[];
  setContacts: React.Dispatch<React.SetStateAction<PhoneContact[]>>;
  checklists: Checklist[];
  callMode: 'outgoing' | 'incoming';
  onCallModeChange: (mode: 'outgoing' | 'incoming') => void;
  onCallStarted?: (callId: string, contact: PhoneContact, checklist: Checklist) => void;
}

const TelephonySettings: React.FC<TelephonySettingsProps> = ({ contacts, setContacts, checklists, callMode, onCallModeChange, onCallStarted }) => {
  const [sipStatus, setSipStatus] = useState<'registered' | 'offline' | 'connecting' | 'error'>('offline');
  const [newName, setNewName] = useState('');
  const [newNumber, setNewNumber] = useState('');
  const [logs, setLogs] = useState<{time: string, level: string, msg: string}[]>([]);
  const [selectedChecklistId, setSelectedChecklistId] = useState(checklists[0]?.id || '');
  const [callingNumber, setCallingNumber] = useState<string | null>(null);
  
  const [sipConfig, setSipConfig] = useState<SipConfig>({
    host: '176.67.241.251',
    port: 5060,
    domain: 'bestway',
    username: '4998',
    password: '',
    displayName: 'Gemini Bot'
  });

  // Fetch initial SIP status
  useEffect(() => {
    apiGet('/api/sip/status').then((data) => {
      if (data.registered) setSipStatus('registered');
      if (data.config) {
        setSipConfig(prev => ({ ...prev, ...data.config }));
      }
    }).catch(() => {});
  }, []);

  // Fetch initial incoming-call checklist selection
  useEffect(() => {
    apiGet('/api/incoming/checklist')
      .then((data) => {
        if (data.checklistId) {
          setSelectedChecklistId(data.checklistId);
        }
      })
      .catch(() => {});
  }, []);

  // Subscribe to WebSocket events
  useEffect(() => {
    return wsClient.subscribe((msg: WsMessage) => {
      if (msg.type === 'sipStatus') {
        if (msg.data === 'registered') setSipStatus('registered');
        else if (msg.data === 'disconnected' || msg.data === 'unregistered') setSipStatus('offline');
        else if (msg.data === 'error') setSipStatus('error');
      }
      if (msg.type === 'log') {
        setLogs(prev => [{
          time: new Date(msg.data.time).toLocaleTimeString(),
          level: msg.data.level,
          msg: msg.data.msg
        }, ...prev].slice(0, 50));
      }
    });
  }, []);

  const handleConnect = async () => {
    if (sipStatus === 'registered') {
      setSipStatus('connecting');
      try {
        await apiPost('/api/sip/disconnect');
        setSipStatus('offline');
      } catch {
        setSipStatus('error');
      }
    } else {
      setSipStatus('connecting');
      try {
        await apiPost('/api/sip/connect', sipConfig);
      } catch (e: any) {
        setSipStatus('error');
        setLogs(prev => [{ time: new Date().toLocaleTimeString(), level: 'error', msg: e.message }, ...prev]);
      }
    }
  };

  const handleCall = async (contact: PhoneContact) => {
    try {
      setCallingNumber(contact.number);
      const checklist = checklists.find(c => c.id === selectedChecklistId) || checklists[0];
      const res = await apiPost('/api/call/start', {
        number: contact.number,
        checklistId: checklist?.id || checklists[0]?.id,
        customerName: contact.name || contact.number,
        callMode,
      });
      if (res.callId && onCallStarted && checklist) {
        onCallStarted(res.callId, contact, checklist);
      }
    } catch (e: any) {
      alert(`Ошибка звонка: ${e.message}`);
    } finally {
      setCallingNumber(null);
    }
  };

  const addContact = () => {
    if (!newName || !newNumber) return;
    setContacts([...contacts, { id: Date.now().toString(), name: newName, number: newNumber }]);
    setNewName('');
    setNewNumber('');
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-slate-800">Телефония и SIP</h2>
        <p className="text-slate-500 mt-1">Подключение к АТС через серверный SIP-агент (UDP).</p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-8 shadow-sm">
        <h3 className="font-bold text-lg mb-6 flex items-center gap-2">
          <i className="fas fa-server text-indigo-500"></i>
          Настройки SIP (UDP)
        </h3>
        <div className="flex flex-col md:flex-row gap-8 items-start">
          <div className="flex-1 space-y-4 w-full">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">SIP Сервер (IP)</label>
                <input 
                    className="w-full p-2 bg-slate-50 border rounded-lg text-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none" 
                    value={sipConfig.host}
                    onChange={e => setSipConfig({...sipConfig, host: e.target.value})}
                    placeholder="176.67.241.251"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Порт</label>
                <input 
                    type="number"
                    className="w-full p-2 bg-slate-50 border rounded-lg text-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none" 
                    value={sipConfig.port}
                    onChange={e => setSipConfig({...sipConfig, port: parseInt(e.target.value) || 5060})}
                    placeholder="5060"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">SIP Домен</label>
                <input 
                    className="w-full p-2 bg-slate-50 border rounded-lg text-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none" 
                    value={sipConfig.domain}
                    onChange={e => setSipConfig({...sipConfig, domain: e.target.value})}
                    placeholder="bestway"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Пользователь</label>
                <input 
                    className="w-full p-2 bg-slate-50 border rounded-lg text-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none" 
                    value={sipConfig.username}
                    onChange={e => setSipConfig({...sipConfig, username: e.target.value})}
                    placeholder="4998"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Пароль</label>
                <input 
                    type="password"
                    className="w-full p-2 bg-slate-50 border rounded-lg text-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none" 
                    value={sipConfig.password || ''}
                    onChange={e => setSipConfig({...sipConfig, password: e.target.value})}
                    placeholder="••••••••"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Имя отображения</label>
                <input 
                    className="w-full p-2 bg-slate-50 border rounded-lg text-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none" 
                    value={sipConfig.displayName || ''}
                    onChange={e => setSipConfig({...sipConfig, displayName: e.target.value})}
                    placeholder="Gemini Bot"
                />
              </div>
            </div>
            
            <div className="flex items-center justify-between pt-4">
              <div className={`px-4 py-2 rounded-full text-sm font-bold flex items-center gap-2 transition-colors ${
                sipStatus === 'registered' ? 'bg-emerald-50 text-emerald-600' : 
                sipStatus === 'connecting' ? 'bg-amber-50 text-amber-600' :
                sipStatus === 'error' ? 'bg-red-50 text-red-600' :
                'bg-slate-100 text-slate-500'
              }`}>
                <span className={`w-2 h-2 rounded-full ${
                    sipStatus === 'registered' ? 'bg-emerald-500' : 
                    sipStatus === 'connecting' ? 'bg-amber-500 animate-pulse' :
                    sipStatus === 'error' ? 'bg-red-500' :
                    'bg-slate-400'
                }`}></span>
                {sipStatus === 'registered' ? 'Зарегистрирован на АТС' : 
                 sipStatus === 'connecting' ? 'Подключение...' : 
                 sipStatus === 'error' ? 'Ошибка подключения' :
                 'Отключено'}
              </div>
              
              <button 
                onClick={handleConnect}
                disabled={sipStatus === 'connecting'}
                className={`px-6 py-2 rounded-lg text-sm font-bold text-white transition-all ${
                    sipStatus === 'registered' 
                    ? 'bg-red-500 hover:bg-red-600 shadow-red-500/30' 
                    : sipStatus === 'connecting' 
                    ? 'bg-slate-400 cursor-wait'
                    : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-500/30'
                } shadow-lg`}
              >
                {sipStatus === 'registered' ? 'Отключить' : sipStatus === 'connecting' ? 'Подключение...' : 'Подключить SIP'}
              </button>
            </div>
          </div>
          
          <div className="w-full md:w-64 bg-emerald-50 rounded-xl p-4 text-sm text-emerald-800 border border-emerald-100">
            <div className="mb-2 font-bold text-emerald-900 flex items-center gap-2">
              <i className="fas fa-check-circle"></i> Серверный режим
            </div>
            SIP-подключение работает на сервере через <strong>UDP</strong>. Браузер не требует WSS или сертификатов.
            <br/><br/>
            <strong>Кодеки:</strong> G.711 A-law / μ-law (автовыбор)
            <br/><br/>
            Звонки продолжают работать даже при закрытом браузере.
          </div>
        </div>

        {/* Debug Logs */}
        <div className="mt-8 bg-slate-900 rounded-xl p-4 font-mono text-xs text-slate-300 h-48 overflow-y-auto">
            <div className="flex justify-between items-center mb-2 border-b border-slate-700 pb-2">
                <span className="font-bold text-slate-100">Server Logs</span>
                <button onClick={() => setLogs([])} className="text-slate-500 hover:text-white">Clear</button>
            </div>
            <div className="space-y-1">
                {logs.length === 0 && <span className="text-slate-600 italic">Connecting to server...</span>}
                {logs.map((log, i) => (
                    <div key={i} className="flex gap-2">
                        <span className="text-slate-500">[{log.time}]</span>
                        <span className={`font-bold ${
                            log.level === 'error' ? 'text-red-400' : 
                            log.level === 'warn' ? 'text-amber-400' : 
                            'text-blue-400'
                        }`}>{log.level.toUpperCase()}:</span>
                        <span>{log.msg}</span>
                    </div>
                ))}
            </div>
        </div>
      </div>

      {/* Contacts & call section */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <h3 className="font-bold text-lg">Список контактов для обзвона</h3>
            <div className="flex flex-wrap gap-3 items-center">
              <div className="flex gap-2 items-center">
                <label className="text-xs font-bold text-slate-400 uppercase">Режим:</label>
                <div className="bg-slate-100 rounded-lg p-0.5 flex">
                  <button
                    type="button"
                    onClick={() => onCallModeChange('outgoing')}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium ${
                      callMode === 'outgoing' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'
                    }`}
                  >
                    Исходящий
                  </button>
                  <button
                    type="button"
                    onClick={() => onCallModeChange('incoming')}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium ${
                      callMode === 'incoming' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'
                    }`}
                  >
                    Входящий
                  </button>
                </div>
                <span className="text-slate-400 text-[10px]">
                  {callMode === 'outgoing' ? 'ждём Алло' : 'бот первый'}
                </span>
              </div>
              <div className="flex gap-4 items-center flex-wrap">
                <div className="flex gap-2 items-center">
                  <label className="text-xs font-bold text-slate-400 uppercase">Сценарий исходящий:</label>
                  <select
                    value={selectedChecklistId}
                    onChange={e => setSelectedChecklistId(e.target.value)}
                    className="text-sm p-2 border rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    {checklists.map(c => (
                      <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2 items-center">
                  <label className="text-xs font-bold text-slate-400 uppercase">Сценарий входящий:</label>
                  <select
                    value={selectedChecklistId}
                    onChange={async (e) => {
                      const id = e.target.value;
                      setSelectedChecklistId(id);
                      try {
                        await apiPost('/api/incoming/checklist', { checklistId: id });
                      } catch {
                        // ignore
                      }
                    }}
                    className="text-sm p-2 border rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  >
                    {checklists.map(c => (
                      <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <input 
              placeholder="Имя" 
              className="text-sm p-2 border rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500"
              value={newName}
              onChange={e => setNewName(e.target.value)}
            />
            <input 
              placeholder="Номер" 
              className="text-sm p-2 border rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500"
              value={newNumber}
              onChange={e => setNewNumber(e.target.value)}
            />
            <button 
              onClick={addContact}
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium"
            >
              Добавить
            </button>
          </div>
        </div>
        <table className="w-full text-left">
          <thead className="bg-slate-50 text-xs font-bold text-slate-400 uppercase">
            <tr>
              <th className="px-6 py-4">Имя</th>
              <th className="px-6 py-4">Номер телефона</th>
              <th className="px-6 py-4 text-right">Действия</th>
            </tr>
          </thead>
          <tbody className="text-sm divide-y divide-slate-100">
            {contacts.map(c => (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className="px-6 py-4 font-medium text-slate-700">{c.name}</td>
                <td className="px-6 py-4 text-slate-600 font-mono">{c.number}</td>
                <td className="px-6 py-4 text-right flex justify-end gap-2">
                  <button 
                    onClick={() => handleCall(c)}
                    disabled={sipStatus !== 'registered' || callingNumber !== null}
                    className={`px-3 py-1 rounded-md text-xs font-bold flex items-center gap-1 ${
                        sipStatus === 'registered' && callingNumber === null
                        ? 'bg-emerald-500 hover:bg-emerald-600 text-white' 
                        : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    }`}
                  >
                    <i className={`fas ${callingNumber === c.number ? 'fa-spinner fa-spin' : 'fa-phone'}`}></i>
                    {callingNumber === c.number ? 'Вызов...' : 'Позвонить'}
                  </button>
                  
                  <button onClick={() => setContacts(contacts.filter(x => x.id !== c.id))} className="text-red-400 hover:text-red-600 px-2">
                    <i className="fas fa-trash"></i>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default TelephonySettings;
