
export enum AppView {
  DASHBOARD = 'dashboard',
  CHECKLISTS = 'checklists',
  TELEPHONY = 'telephony',
  ACTIVE_CALL = 'active_call',
  RESULTS = 'results'
}

export interface Checklist {
  id: string;
  title: string;
  description: string;
  items: string[];
  voiceName?: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';
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

export interface PhoneContact {
  id: string;
  name: string;
  number: string;
  lastCalled?: string;
}

export interface SipConfig {
  host: string;
  port: number;
  domain: string;
  username: string;
  password?: string;
  displayName?: string;
}
