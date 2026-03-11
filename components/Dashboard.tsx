
import React, { useState } from 'react';
import { CallLog, PhoneContact, Checklist } from '../types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface DashboardProps {
  callLogs: CallLog[];
  contacts: PhoneContact[];
  checklists: Checklist[];
  sipStatus: string;
  callMode: 'outgoing' | 'incoming';
  onCallModeChange: (mode: 'outgoing' | 'incoming') => void;
  onStartCall: (contact: PhoneContact, checklist: Checklist) => void;
}

const Dashboard: React.FC<DashboardProps> = ({ callLogs, contacts, checklists, sipStatus, callMode, onCallModeChange, onStartCall }) => {
  const [selectedChecklistId, setSelectedChecklistId] = useState(checklists[0]?.id || '');

  const handleLocalTest = () => {
    const checklist = checklists.find(c => c.id === selectedChecklistId) || checklists[0];
    const dummyContact: PhoneContact = {
      id: 'local-test',
      name: 'Тестовый Клиент (Локально)',
      number: 'Internal Audio',
    };
    onStartCall(dummyContact, checklist);
  };

  const statsData = [
    { name: 'Пн', calls: 12 },
    { name: 'Вт', calls: 18 },
    { name: 'Ср', calls: 15 },
    { name: 'Чт', calls: 24 },
    { name: 'Пт', calls: 30 },
    { name: 'Сб', calls: 10 },
    { name: 'Вс', calls: 5 },
  ];

  return (
    <div className="space-y-8">
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold text-slate-800">Обзор системы</h2>
          <p className="text-slate-500 mt-2">Управление голосовыми опросами и аналитика в реальном времени.</p>
        </div>
        <div className="flex flex-col items-stretch md:items-end gap-2">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-500 font-medium">Режим звонка:</span>
            <div className="bg-slate-100 rounded-xl p-1 flex">
              <button
                type="button"
                onClick={() => onCallModeChange('outgoing')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  callMode === 'outgoing' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Исходящий
              </button>
              <button
                type="button"
                onClick={() => onCallModeChange('incoming')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  callMode === 'incoming' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Входящий
              </button>
            </div>
            <span className="text-slate-400 text-xs max-w-[140px]">
              {callMode === 'outgoing' ? 'Ждём «Алло» от клиента' : 'Бот сразу представляется'}
            </span>
          </div>
          <div className="bg-indigo-600 rounded-2xl p-1 shadow-sm flex items-center">
            <div className="bg-white/10 px-4 py-2 rounded-xl text-white flex items-center gap-3">
              <div className="flex flex-col">
                <span className="text-[10px] font-bold uppercase opacity-70">Быстрый тест</span>
                <select
                  value={selectedChecklistId}
                  onChange={(e) => setSelectedChecklistId(e.target.value)}
                  className="bg-transparent border-none text-sm font-semibold focus:ring-0 cursor-pointer outline-none"
                >
                  {checklists.map(c => (
                    <option key={c.id} value={c.id} className="text-slate-900">
                      {c.title}
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={handleLocalTest}
                className="bg-white text-indigo-600 px-4 py-2 rounded-lg text-sm font-bold hover:bg-indigo-50 transition-colors flex items-center gap-2"
              >
                <i className="fas fa-play" /> Тест с микрофона
              </button>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 text-[11px] text-slate-500">
            <span
              className={`w-2 h-2 rounded-full ${
                sipStatus === 'registered' ? 'bg-emerald-500' : 'bg-slate-400'
              }`}
            />
            <span className="font-medium">
              SIP статус: {sipStatus === 'registered' ? 'Online' : 'Offline'}
            </span>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatCard title="Всего звонков" value={callLogs.length.toString()} icon="fa-phone" color="text-indigo-600" />
        <StatCard
          title="Завершенные опросы"
          value={callLogs.filter(l => l.status === 'completed').length.toString()}
          icon="fa-check-double"
          color="text-emerald-600"
        />
        <StatCard
          title="SIP статус"
          value={sipStatus === 'registered' ? 'Online' : 'Offline'}
          icon="fa-server"
          color={sipStatus === 'registered' ? 'text-emerald-600' : 'text-slate-400'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
          <h3 className="font-bold text-lg mb-6 flex items-center gap-2">
            <i className="fas fa-chart-line text-indigo-500" />
            Активность звонков (неделя)
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statsData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" axisLine={false} tickLine={false} />
                <YAxis axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: '#f1f5f9' }}
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                />
                <Bar dataKey="calls" fill="#4f46e5" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
          <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
            <i className="fas fa-bolt text-amber-500" />
            Список обзвона
          </h3>
          <div className="space-y-4 max-h-64 overflow-y-auto">
            {contacts.length === 0 ? (
              <p className="text-slate-400 text-sm italic text-center py-8">Список пуст</p>
            ) : (
              contacts.slice(0, 5).map(contact => (
                <div
                  key={contact.id}
                  className="flex items-center justify-between p-3 border border-slate-100 rounded-xl hover:bg-slate-50 transition-colors"
                >
                  <div>
                    <p className="font-semibold text-sm">{contact.name}</p>
                    <p className="text-xs text-slate-500">{contact.number}</p>
                  </div>
                  <button
                    onClick={() =>
                      onStartCall(contact, checklists.find(c => c.id === selectedChecklistId) || checklists[0])
                    }
                    disabled={sipStatus !== 'registered'}
                    className={`text-xs px-3 py-2 rounded-lg font-medium ${
                      sipStatus === 'registered'
                        ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                        : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    }`}
                  >
                    <i className="fas fa-phone mr-1" /> Звонок
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const StatCard: React.FC<{ title: string; value: string; icon: string; color: string }> = ({ title, value, icon, color }) => (
  <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-4">
    <div className={`w-12 h-12 rounded-xl bg-slate-50 flex items-center justify-center text-xl ${color}`}>
      <i className={`fas ${icon}`} />
    </div>
    <div>
      <p className="text-sm font-medium text-slate-500">{title}</p>
      <p className="text-2xl font-bold text-slate-800">{value}</p>
    </div>
  </div>
);

export default Dashboard;
