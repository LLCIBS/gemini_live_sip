
import React, { useState, useEffect } from 'react';
import { AppView, Checklist, CallLog, PhoneContact } from './types';
import Dashboard from './components/Dashboard';
import ChecklistsManager from './components/ChecklistsManager';
import TelephonySettings from './components/TelephonySettings';
import ActiveCall from './components/ActiveCall';
import LocalTestCall from './components/LocalTestCall';
import ResultsHistory from './components/ResultsHistory';
import { apiPost, apiGet, wsClient, type WsMessage } from './utils/api';

const INITIAL_CHECKLISTS: Checklist[] = [
  {
    id: '1',
    title: 'Бронирование столика',
    description: 'Сценарий для приема заказа на столик в ресторане.',
    items: [
      'Уточнить имя клиента',
      'Уточнить количество персон',
      'Уточнить дату и время визита',
      'Уточнить предпочтения по залу (курящий/некурящий)',
      'Спросить про повод (день рождения и т.д.)'
    ],
    voiceName: 'Kore'
  },
  {
    id: '2',
    title: 'Опрос по качеству услуг',
    description: 'Оценка удовлетворенности после посещения.',
    items: [
      'Понравилось ли обслуживание?',
      'Довольны ли вы качеством блюд?',
      'Было ли время ожидания комфортным?',
      'Готовы ли вы рекомендовать нас друзьям?',
      'Есть ли пожелания по улучшению?'
    ],
    voiceName: 'Zephyr'
  }
];

const INITIAL_CONTACTS: PhoneContact[] = [
  { id: 'c1', name: 'Иван Петров', number: '+7 900 123 45 67' },
  { id: 'c2', name: 'Мария Сидорова', number: '+7 911 555 33 22' },
  { id: 'c3', name: 'Алексей Волков', number: '+7 999 888 77 66' },
  { id: 'c4', name: 'Фёдор', number: '89049175491' }
];

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<AppView>(AppView.DASHBOARD);
  const [checklists, setChecklists] = useState<Checklist[]>(INITIAL_CHECKLISTS);
  const [contacts, setContacts] = useState<PhoneContact[]>(INITIAL_CONTACTS);
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [activeCallContact, setActiveCallContact] = useState<PhoneContact | null>(null);
  const [activeChecklist, setActiveChecklist] = useState<Checklist>(INITIAL_CHECKLISTS[0]);
  const [sipStatus, setSipStatus] = useState<string>('offline');
  const [isLocalTestCall, setIsLocalTestCall] = useState(false);
  const [callMode, setCallMode] = useState<'outgoing' | 'incoming'>('outgoing');

  // Sync checklists to server whenever they change
  useEffect(() => {
    apiPost('/api/checklists/sync', { checklists }).catch(() => {});
  }, [checklists]);

  // Load call history from server on mount
  useEffect(() => {
    apiGet('/api/calls/history').then(data => {
      if (data.calls?.length) {
        setCallLogs(data.calls);
      }
    }).catch(() => {});
  }, []);

  // Subscribe to WebSocket for global events
  useEffect(() => {
    return wsClient.subscribe((msg: WsMessage) => {
      if (msg.type === 'sipStatus') {
        setSipStatus(msg.data as string);
      }
      if (msg.type === 'callEnded') {
        setCallLogs(prev => [msg.data, ...prev]);
        if (msg.data?.id && msg.data.id === activeCallId) {
          setActiveCallId(null);
          setActiveCallContact(null);
          setCurrentView(AppView.RESULTS);
        }
      }
      // Fallback: обновление состояния вызова от сервера (входящий или исходящий)
      if (msg.type === 'callState' && msg.data?.callId && msg.data?.phoneNumber) {
        // Если сервер сообщает, что вызов завершён — не открываем новое окно
        if (msg.data.status === 'ended') {
          if (activeCallId === msg.data.callId) {
            setActiveCallId(null);
            setActiveCallContact(null);
          }
          return;
        }
        const placeholderContact: PhoneContact = {
          id: msg.data.callId,
          name: msg.data.customerName || msg.data.phoneNumber,
          number: msg.data.phoneNumber,
        };
        setActiveCallId(prev => {
          if (prev === msg.data.callId) return prev;
          // Входящий звонок — переключаем на экран
          setActiveCallContact(placeholderContact);
          setCurrentView(AppView.ACTIVE_CALL);
          return msg.data.callId;
        });
        setActiveCallContact(prev => prev ?? placeholderContact);
      }
    });
  }, [activeCallId]);

  const handleStartCall = async (contact: PhoneContact, checklist: Checklist) => {
    // Локальный тест с микрофона — без SIP и сервера
    if (contact.id === 'local-test') {
      setIsLocalTestCall(true);
      setActiveCallId(null);
      setActiveCallContact(contact);
      setActiveChecklist(checklist);
      setCurrentView(AppView.ACTIVE_CALL);
      return;
    }

    try {
      const res = await apiPost('/api/call/start', {
        number: contact.number,
        checklistId: checklist.id,
        customerName: contact.name,
        callMode, // outgoing = ждём «Алло», incoming = бот первый представляется
      });
      setIsLocalTestCall(false);
      setActiveCallId(res.callId);
      setActiveCallContact(contact);
      setActiveChecklist(checklist);
      setCurrentView(AppView.ACTIVE_CALL);
    } catch (e: any) {
      alert(`Ошибка: ${e.message}`);
    }
  };

  const handleCallFinished = (log: CallLog) => {
    setCallLogs(prev => {
      if (prev.some(l => l.id === log.id)) return prev;
      return [log, ...prev];
    });
    setActiveCallId(null);
    setIsLocalTestCall(false);
    setCurrentView(AppView.RESULTS);
  };

  const handleCallStartedFromTelephony = (callId: string, contact: PhoneContact, checklist: Checklist) => {
    setIsLocalTestCall(false);
    setActiveCallId(callId);
    setActiveCallContact(contact);
    setActiveChecklist(checklist);
    setCurrentView(AppView.ACTIVE_CALL);
  };

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900 overflow-hidden">
      {/* Sidebar Navigation */}
      <nav className="w-64 bg-white border-r border-slate-200 flex flex-col">
        <div className="p-6">
          <h1 className="text-xl font-bold text-indigo-600 flex items-center gap-2">
            <i className="fas fa-headset"></i>
            VoiceAgent AI
          </h1>
          <p className="text-xs text-slate-500 mt-1 uppercase tracking-wider font-semibold">Gemini Live + SIP</p>
        </div>

        <div className="flex-1 px-4 space-y-1">
          <NavItem 
            active={currentView === AppView.DASHBOARD} 
            onClick={() => setCurrentView(AppView.DASHBOARD)} 
            icon="fa-chart-pie" 
            label="Обзор" 
          />
          <NavItem 
            active={currentView === AppView.CHECKLISTS} 
            onClick={() => setCurrentView(AppView.CHECKLISTS)} 
            icon="fa-list-check" 
            label="Чек-листы" 
          />
          <NavItem 
            active={currentView === AppView.TELEPHONY} 
            onClick={() => setCurrentView(AppView.TELEPHONY)} 
            icon="fa-phone-volume" 
            label="Телефония" 
          />
          <NavItem 
            active={currentView === AppView.RESULTS} 
            onClick={() => setCurrentView(AppView.RESULTS)} 
            icon="fa-history" 
            label="Результаты" 
          />
        </div>

        <div className="p-4 border-t border-slate-100">
          <div className={`p-3 rounded-lg flex items-center gap-3 ${
            sipStatus === 'registered' ? 'bg-emerald-50' : 'bg-slate-50'
          }`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
              sipStatus === 'registered' ? 'bg-emerald-200 text-emerald-700' : 'bg-slate-200 text-slate-500'
            }`}>
              <i className="fas fa-server"></i>
            </div>
            <div className="text-xs">
              <p className="font-semibold text-slate-700">SIP Agent</p>
              <p className={sipStatus === 'registered' ? 'text-emerald-600 font-bold' : 'text-slate-500'}>
                {sipStatus === 'registered' ? 'Online (UDP)' : 'Offline'}
              </p>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto p-8">
          {currentView === AppView.DASHBOARD && (
            <Dashboard 
              callLogs={callLogs} 
              onStartCall={(c, cl) => handleStartCall(c, cl)}
              contacts={contacts}
              checklists={checklists}
              sipStatus={sipStatus}
              callMode={callMode}
              onCallModeChange={setCallMode}
            />
          )}
          {currentView === AppView.CHECKLISTS && (
            <ChecklistsManager 
              checklists={checklists} 
              setChecklists={setChecklists} 
            />
          )}
          {currentView === AppView.TELEPHONY && (
            <TelephonySettings 
              contacts={contacts} 
              setContacts={setContacts}
              checklists={checklists}
              onCallStarted={handleCallStartedFromTelephony}
              callMode={callMode}
              onCallModeChange={setCallMode}
            />
          )}
          {currentView === AppView.ACTIVE_CALL && activeCallContact && (
            isLocalTestCall ? (
              <LocalTestCall
                contact={activeCallContact}
                checklist={activeChecklist}
                onFinished={handleCallFinished}
                onClose={() => {
                  setIsLocalTestCall(false);
                  setCurrentView(AppView.DASHBOARD);
                }}
              />
            ) : (
              activeCallId && (
                <ActiveCall
                  callId={activeCallId}
                  contact={activeCallContact}
                  checklist={activeChecklist}
                  onFinished={handleCallFinished}
                  onClose={() => setCurrentView(AppView.DASHBOARD)}
                />
              )
            )
          )}
          {currentView === AppView.RESULTS && (
            <ResultsHistory callLogs={callLogs} />
          )}
        </div>
      </main>
    </div>
  );
};

const NavItem: React.FC<{ active: boolean, onClick: () => void, icon: string, label: string }> = ({ active, onClick, icon, label }) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
      active 
        ? 'bg-indigo-600 text-white shadow-md shadow-indigo-100' 
        : 'text-slate-600 hover:bg-slate-100'
    }`}
  >
    <i className={`fas ${icon} w-5`}></i>
    {label}
  </button>
);

export default App;
