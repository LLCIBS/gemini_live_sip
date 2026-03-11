import dgram from 'dgram';
import crypto from 'crypto';
import os from 'os';
import { EventEmitter } from 'events';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SipConfig {
  host: string;       // АТС IP: 176.67.241.251
  port: number;       // АТС порт: 5060
  username: string;   // 4998
  password: string;   // F@Al?~4i%o7e4mrj3
  domain: string;     // bestway
  localPort?: number; // локальный SIP-порт (0 = random)
  displayName?: string;
  /**
   * Необязательный явный локальный IP, который будет использоваться в
   * заголовках SIP (Via/Contact) и в SDP (o=/c=).
   * Если не задан, берётся первый не-внутренний IPv4 из интерфейсов ОС.
   */
  localIp?: string;
}

export interface SipCallInfo {
  callId: string;
  fromTag: string;
  toTag: string;
  targetNumber: string;
  localRtpPort: number;
  remoteRtpHost: string;
  remoteRtpPort: number;
  codec: 'alaw' | 'ulaw';
  cseq: number;
  routeSet: string[];
}

interface DigestChallenge {
  realm: string;
  nonce: string;
  algorithm?: string;
  qop?: string;
  opaque?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getLocalIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function generateBranch(): string {
  return 'z9hG4bK' + crypto.randomBytes(8).toString('hex');
}

function generateTag(): string {
  return crypto.randomBytes(6).toString('hex');
}

function generateCallId(): string {
  return crypto.randomBytes(12).toString('hex');
}

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

function computeDigestResponse(
  challenge: DigestChallenge,
  method: string,
  uri: string,
  username: string,
  password: string
): string {
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);

  if (challenge.qop === 'auth') {
    const nc = '00000001';
    const cnonce = crypto.randomBytes(4).toString('hex');
    const response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
    return `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${response}", algorithm=MD5, qop=auth, nc=${nc}, cnonce="${cnonce}"${challenge.opaque ? `, opaque="${challenge.opaque}"` : ''}`;
  }

  const response = md5(`${ha1}:${challenge.nonce}:${ha2}`);
  return `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", response="${response}", algorithm=MD5${challenge.opaque ? `, opaque="${challenge.opaque}"` : ''}`;
}

function parseDigestChallenge(header: string): DigestChallenge | null {
  const realmMatch = header.match(/realm="([^"]+)"/);
  const nonceMatch = header.match(/nonce="([^"]+)"/);
  if (!realmMatch || !nonceMatch) return null;

  return {
    realm: realmMatch[1],
    nonce: nonceMatch[1],
    algorithm: header.match(/algorithm=([^\s,]+)/)?.[1],
    qop: header.match(/qop="?([^",]+)"?/)?.[1],
    opaque: header.match(/opaque="([^"]+)"/)?.[1],
  };
}

function parseSipResponse(data: string): {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
} | null {
  const parts = data.split('\r\n\r\n');
  const headerBlock = parts[0];
  const body = parts.slice(1).join('\r\n\r\n');
  const lines = headerBlock.split('\r\n');
  const firstLine = lines[0];

  const statusMatch = firstLine.match(/^SIP\/2\.0\s+(\d{3})\s+(.*)$/);
  if (!statusMatch) return null;

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx < 0) continue;
    const key = lines[i].substring(0, idx).trim().toLowerCase();
    const val = lines[i].substring(idx + 1).trim();
    // Accumulate multi-value headers
    if (headers[key]) {
      headers[key] += ',' + val;
    } else {
      headers[key] = val;
    }
  }

  return {
    statusCode: parseInt(statusMatch[1], 10),
    statusText: statusMatch[2],
    headers,
    body,
  };
}

function parseSipRequest(data: string): {
  method: string;
  uri: string;
  headers: Record<string, string>;
  body: string;
} | null {
  const parts = data.split('\r\n\r\n');
  const headerBlock = parts[0];
  const body = parts.slice(1).join('\r\n\r\n');
  const lines = headerBlock.split('\r\n');
  const firstLine = lines[0];

  const reqMatch = firstLine.match(/^(\w+)\s+(\S+)\s+SIP\/2\.0$/);
  if (!reqMatch) return null;

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx < 0) continue;
    const key = lines[i].substring(0, idx).trim().toLowerCase();
    const val = lines[i].substring(idx + 1).trim();
    if (headers[key]) {
      headers[key] += ',' + val;
    } else {
      headers[key] = val;
    }
  }

  return {
    method: reqMatch[1],
    uri: reqMatch[2],
    headers,
    body,
  };
}

function extractRtpInfoFromSdp(sdp: string, fallbackHost?: string): { host: string; port: number; codec: 'alaw' | 'ulaw' } | null {
  const cLine = sdp.match(/c=IN IP4 (\S+)/);
  const mLine = sdp.match(/m=audio (\d+) RTP\/AVP (.+)/);
  if (!cLine || !mLine) return null;

  let host = cLine[1];
  // If the SDP host is 0.0.0.0 or private/invalid, fall back to the remote SIP server address
  if (host === '0.0.0.0' || !host) {
    host = fallbackHost || host;
  }
  const port = parseInt(mLine[1], 10);
  const payloads = mLine[2].split(/\s+/).map(Number);

  // Prefer PCMA (8=alaw), fallback to PCMU (0=ulaw)
  let codec: 'alaw' | 'ulaw' = 'alaw';
  if (payloads.includes(8)) {
    codec = 'alaw';
  } else if (payloads.includes(0)) {
    codec = 'ulaw';
  }

  return { host, port, codec };
}

function extractTagFromHeader(header: string): string {
  const m = header.match(/tag=([^\s;,>]+)/);
  return m ? m[1] : '';
}

/** Нормализует Call-ID: убирает угловые скобки и пробелы для сопоставления. */
function normalizeCallId(raw: string): string {
  return (raw || '').replace(/^<|>$/g, '').trim();
}

/**
 * Находит ключ в activeCalls по входящему Call-ID.
 * АТС может добавлять @host к Call-ID в BYE (например abc123 → abc123@176.67.241.251),
 * поэтому при отсутствии точного совпадения ищем по "core" (часть до @).
 */
function findCallIdForBye(activeCalls: Map<string, SipCallInfo>, incomingNormalized: string): string | undefined {
  if (activeCalls.has(incomingNormalized)) return incomingNormalized;
  const core = incomingNormalized.split('@')[0]?.trim() || incomingNormalized;
  for (const key of activeCalls.keys()) {
    const keyCore = key.split('@')[0]?.trim() || key;
    if (core === keyCore || key === core || incomingNormalized === key) return key;
  }
  return undefined;
}

// ─── SIP Agent ───────────────────────────────────────────────────────────────

export declare interface SipAgent {
  on(event: 'registered', listener: () => void): this;
  on(event: 'unregistered', listener: () => void): this;
  on(event: 'registrationFailed', listener: (reason: string) => void): this;
  on(event: 'invite', listener: (callInfo: SipCallInfo) => void): this;
  on(event: 'callEstablished', listener: (callInfo: SipCallInfo) => void): this;
  on(event: 'callEnded', listener: (callId: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'log', listener: (level: string, msg: string) => void): this;
}

export class SipAgent extends EventEmitter {
  private config: SipConfig;
  private socket: dgram.Socket;
  private localIp: string;
  private localPort = 0;
  private registered = false;
  private registerTimer: NodeJS.Timeout | null = null;
  private registerAuthCseq = 0;
  private registerRetryCount = 0;
  private fromTag: string;
  private registerCseq = 0;
  private callCseq = 0;

  // Active calls tracked by callId
  private activeCalls = new Map<string, SipCallInfo>();

  // Pending outbound invites (callId → resolve/reject + metadata)
  private pendingInvites = new Map<string, {
    resolve: (info: SipCallInfo) => void;
    reject: (err: Error) => void;
    callId: string;
    fromTag: string;
    targetNumber: string;
    localRtpPort: number;
    cseq: number;           // current (latest) cseq
    branch: string;
    authCseq: number;       // cseq of the last authenticated INVITE (0 = none sent)
    retryCount: number;     // number of auth retries attempted
  }>();

  // Guard: prevents duplicate concurrent REGISTER transactions
  private registering = false;

  constructor(config: SipConfig) {
    super();
    this.config = config;
    this.localIp = config.localIp || getLocalIp();
    this.fromTag = generateTag();
    this.socket = dgram.createSocket('udp4');

    this.socket.on('error', (err) => {
      this.log('error', `Socket error: ${err.message}`);
      this.emit('error', err);
    });

    this.socket.on('message', (msg, rinfo) => {
      this.handleMessage(msg.toString(), rinfo);
    });
  }

  private log(level: string, msg: string) {
    this.emit('log', level, msg);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.bind(this.config.localPort || 0, () => {
        this.localPort = this.socket.address().port;
        this.localIp = this.config.localIp || getLocalIp();
        this.log('info', `SIP Agent started on ${this.localIp}:${this.localPort}`);
        resolve();
      });
      this.socket.once('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (this.registerTimer) {
      clearInterval(this.registerTimer);
      this.registerTimer = null;
    }
    if (this.registered) {
      await this.sendRegister(0); // Expires=0 → unregister
      this.registered = false;
    }
    // Hang up all active calls
    for (const [, call] of this.activeCalls) {
      this.sendBye(call);
    }
    this.activeCalls.clear();
    try {
      this.socket.close();
    } catch {
      // ignore
    }
    this.log('info', 'SIP Agent stopped');
  }

  // ─── Registration ──────────────────────────────────────────────────────────

  async register(): Promise<void> {
    if (this.registering) return;
    this.registering = true;
    await this.sendRegister(300);
  }

  private sendRegister(expires: number, authorization?: string): Promise<void> {
    this.registerCseq++;
    const branch = generateBranch();
    const callId = `register-${this.config.username}@${this.config.domain}`;
    const uri = `sip:${this.config.domain}`;

    let msg = `REGISTER ${uri} SIP/2.0\r\n`;
    msg += `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};rport;branch=${branch}\r\n`;
    msg += `Max-Forwards: 70\r\n`;
    msg += `From: "${this.config.displayName || this.config.username}" <sip:${this.config.username}@${this.config.domain}>;tag=${this.fromTag}\r\n`;
    msg += `To: <sip:${this.config.username}@${this.config.domain}>\r\n`;
    msg += `Call-ID: ${callId}\r\n`;
    msg += `CSeq: ${this.registerCseq} REGISTER\r\n`;
    msg += `Contact: <sip:${this.config.username}@${this.localIp}:${this.localPort};transport=udp>\r\n`;
    msg += `Expires: ${expires}\r\n`;
    msg += `Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, NOTIFY\r\n`;
    msg += `User-Agent: GeminiLiveSipBot/1.0\r\n`;
    if (authorization) {
      msg += `Authorization: ${authorization}\r\n`;
    }
    msg += `Content-Length: 0\r\n`;
    msg += `\r\n`;

    return this.send(msg);
  }

  // ─── Outbound call ─────────────────────────────────────────────────────────

  async makeCall(targetNumber: string, localRtpPort: number): Promise<SipCallInfo> {
    const callId = generateCallId();
    const fromTag = generateTag();
    this.callCseq++;
    const branch = generateBranch();

    return new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        callId,
        fromTag,
        targetNumber,
        localRtpPort,
        cseq: this.callCseq,
        branch,
        authCseq: 0,
        retryCount: 0,
      };
      this.pendingInvites.set(callId, pending);

      this.sendInvite(callId, fromTag, targetNumber, localRtpPort, branch, this.callCseq);

      // Timeout after 60 seconds
      setTimeout(() => {
        if (this.pendingInvites.has(callId)) {
          this.pendingInvites.delete(callId);
          reject(new Error('Call timeout'));
        }
      }, 60000);
    });
  }

  private sendInvite(
    callId: string,
    fromTag: string,
    targetNumber: string,
    localRtpPort: number,
    branch: string,
    cseq: number,
    authorization?: string
  ): void {
    const uri = `sip:${targetNumber}@${this.config.domain}`;

    const sdp = [
      'v=0',
      `o=GeminiBot 0 0 IN IP4 ${this.localIp}`,
      's=GeminiLiveCall',
      `c=IN IP4 ${this.localIp}`,
      't=0 0',
      `m=audio ${localRtpPort} RTP/AVP 8 0 101`,
      'a=rtpmap:8 PCMA/8000',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=fmtp:101 0-16',
      'a=ptime:20',
      'a=sendrecv',
    ].join('\r\n');

    let msg = `INVITE ${uri} SIP/2.0\r\n`;
    msg += `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};rport;branch=${branch}\r\n`;
    msg += `Max-Forwards: 70\r\n`;
    msg += `From: "${this.config.displayName || this.config.username}" <sip:${this.config.username}@${this.config.domain}>;tag=${fromTag}\r\n`;
    msg += `To: <${uri}>\r\n`;
    msg += `Call-ID: ${callId}\r\n`;
    msg += `CSeq: ${cseq} INVITE\r\n`;
    msg += `Contact: <sip:${this.config.username}@${this.localIp}:${this.localPort};transport=udp>\r\n`;
    msg += `Content-Type: application/sdp\r\n`;
    msg += `Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, NOTIFY\r\n`;
    msg += `User-Agent: GeminiLiveSipBot/1.0\r\n`;
    if (authorization) {
      msg += `Proxy-Authorization: ${authorization}\r\n`;
    }
    msg += `Content-Length: ${Buffer.byteLength(sdp)}\r\n`;
    msg += `\r\n`;
    msg += sdp;

    this.send(msg);
  }

  hangup(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (call) {
      this.sendBye(call);
      this.activeCalls.delete(callId);
      this.emit('callEnded', callId);
    }
    // Also cancel pending invite if still pending
    const pending = this.pendingInvites.get(callId);
    if (pending) {
      this.sendCancel(pending.callId, pending.fromTag, pending.targetNumber, pending.branch, pending.cseq);
      this.pendingInvites.delete(callId);
    }
  }

  private sendBye(call: SipCallInfo): void {
    const branch = generateBranch();
    call.cseq++;
    const uri = `sip:${call.targetNumber}@${this.config.domain}`;

    let msg = `BYE ${uri} SIP/2.0\r\n`;
    msg += `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};rport;branch=${branch}\r\n`;
    msg += `Max-Forwards: 70\r\n`;
    msg += `From: "${this.config.displayName || this.config.username}" <sip:${this.config.username}@${this.config.domain}>;tag=${call.fromTag}\r\n`;
    msg += `To: <${uri}>;tag=${call.toTag}\r\n`;
    msg += `Call-ID: ${call.callId}\r\n`;
    msg += `CSeq: ${call.cseq} BYE\r\n`;
    msg += `User-Agent: GeminiLiveSipBot/1.0\r\n`;
    msg += `Content-Length: 0\r\n`;
    msg += `\r\n`;

    this.send(msg);
  }

  private sendCancel(callId: string, fromTag: string, targetNumber: string, branch: string, cseq: number): void {
    const uri = `sip:${targetNumber}@${this.config.domain}`;

    let msg = `CANCEL ${uri} SIP/2.0\r\n`;
    msg += `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};rport;branch=${branch}\r\n`;
    msg += `Max-Forwards: 70\r\n`;
    msg += `From: "${this.config.displayName || this.config.username}" <sip:${this.config.username}@${this.config.domain}>;tag=${fromTag}\r\n`;
    msg += `To: <${uri}>\r\n`;
    msg += `Call-ID: ${callId}\r\n`;
    msg += `CSeq: ${cseq} CANCEL\r\n`;
    msg += `User-Agent: GeminiLiveSipBot/1.0\r\n`;
    msg += `Content-Length: 0\r\n`;
    msg += `\r\n`;

    this.send(msg);
  }

  private sendAck(callId: string, fromTag: string, toTag: string, targetNumber: string, cseq: number): void {
    const branch = generateBranch();
    const uri = `sip:${targetNumber}@${this.config.domain}`;

    let msg = `ACK ${uri} SIP/2.0\r\n`;
    msg += `Via: SIP/2.0/UDP ${this.localIp}:${this.localPort};rport;branch=${branch}\r\n`;
    msg += `Max-Forwards: 70\r\n`;
    msg += `From: "${this.config.displayName || this.config.username}" <sip:${this.config.username}@${this.config.domain}>;tag=${fromTag}\r\n`;
    msg += `To: <${uri}>;tag=${toTag}\r\n`;
    msg += `Call-ID: ${callId}\r\n`;
    msg += `CSeq: ${cseq} ACK\r\n`;
    msg += `User-Agent: GeminiLiveSipBot/1.0\r\n`;
    msg += `Content-Length: 0\r\n`;
    msg += `\r\n`;

    this.send(msg);
  }

  // ─── Incoming message handler ──────────────────────────────────────────────

  private handleMessage(data: string, rinfo: dgram.RemoteInfo): void {
    // Try to parse as response first
    const resp = parseSipResponse(data);
    if (resp) {
      this.handleResponse(resp, data);
      return;
    }

    // Try to parse as request
    const req = parseSipRequest(data);
    if (req) {
      this.handleRequest(req, data, rinfo);
      return;
    }

    this.log('warn', `Unparseable SIP message from ${rinfo.address}:${rinfo.port}`);
  }

  private handleResponse(resp: { statusCode: number; statusText: string; headers: Record<string, string>; body: string }, raw: string): void {
    const callId = normalizeCallId(resp.headers['call-id'] || '');
    const cseqHeader = resp.headers['cseq'] || '';
    const method = cseqHeader.split(/\s+/)[1] || '';
    const respCseq = parseInt(cseqHeader.split(/\s+/)[0] || '0', 10);

    this.log('info', `← ${resp.statusCode} ${resp.statusText} (${method} ${callId.substring(0, 16)}...)`);

    // ─── REGISTER responses ──────────────────────────────────────────────
    if (method === 'REGISTER') {
      if (resp.statusCode === 200) {
        this.registering = false;
        this.registerAuthCseq = respCseq;
        this.registerRetryCount = 0;
        if (!this.registered) {
          this.registered = true;
          this.log('info', 'Registration successful');
          this.emit('registered');
          // Re-register periodically (with guard so concurrent retries don't stack)
          if (!this.registerTimer) {
            this.registerTimer = setInterval(() => {
              if (!this.registering) {
                this.registering = true;
                this.sendRegister(300);
              }
            }, 120000);
          }
        }
      } else if (resp.statusCode === 401 || resp.statusCode === 407) {
        // Если это повторная 401/407 для старого CSeq → игнорируем (UDP‑ретрансмит)
        if (this.registerAuthCseq > 0 && respCseq < this.registerAuthCseq) {
          this.log('info', `[SIP] Ignoring stale REGISTER auth challenge (cseq=${respCseq}, lastAuthCseq=${this.registerAuthCseq})`);
          return;
        }

        // Слишком много попыток подряд → считаем, что что‑то не так с учёткой
        if (this.registerRetryCount >= 5) {
          this.registering = false;
          this.log('error', `Registration auth failed after ${this.registerRetryCount} attempts`);
          this.emit('registrationFailed', 'Too many auth failures for REGISTER');
          return;
        }

        const wwwAuth = resp.headers['www-authenticate'] || resp.headers['proxy-authenticate'] || '';
        const challenge = parseDigestChallenge(wwwAuth);
        if (challenge) {
          const uri = `sip:${this.config.domain}`;
          const auth = computeDigestResponse(challenge, 'REGISTER', uri, this.config.username, this.config.password);
           this.registerRetryCount++;
          this.sendRegister(300, auth);
        } else {
          this.registering = false;
          this.log('error', 'Failed to parse auth challenge for REGISTER');
          this.emit('registrationFailed', 'Auth challenge parse error');
        }
      } else {
        this.registering = false;
        this.log('error', `Registration failed: ${resp.statusCode} ${resp.statusText}`);
        this.emit('registrationFailed', `${resp.statusCode} ${resp.statusText}`);
      }
      return;
    }

    // ─── INVITE responses ────────────────────────────────────────────────
    if (method === 'INVITE') {
      // Extract the CSeq number from the response to detect retransmissions
      const respCseq = parseInt(cseqHeader.split(/\s+/)[0] || '0', 10);

      // Check if already established (duplicate 200 OK retransmission)
      if (resp.statusCode === 200 && this.activeCalls.has(callId)) {
        const call = this.activeCalls.get(callId)!;
        const toTag = extractTagFromHeader(resp.headers['to'] || '') || call.toTag;
        this.sendAck(callId, call.fromTag, toTag, call.targetNumber, respCseq);
        return;
      }

      const pending = this.pendingInvites.get(callId);
      if (!pending) return;

      if (resp.statusCode === 100 || resp.statusCode === 183) {
        this.log('info', `Call ${pending.targetNumber}: Trying...`);
        return;
      }

      if (resp.statusCode === 180) {
        this.log('info', `Call ${pending.targetNumber}: Ringing`);
        return;
      }

      if (resp.statusCode === 401 || resp.statusCode === 407) {
        // Always ACK non-2xx responses first (RFC 3261)
        this.sendAck(callId, pending.fromTag, '', pending.targetNumber, respCseq);

        // If this 407 is for a cseq that predates our authenticated INVITE → it's a
        // UDP retransmission of an already-handled challenge. Just ignore it.
        if (pending.authCseq > 0 && respCseq < pending.authCseq) {
          this.log('info', `[SIP] Ignoring stale 407 retransmit (cseq=${respCseq}, already authenticated with cseq=${pending.authCseq})`);
          return;
        }

        // Too many retries → give up
        if (pending.retryCount >= 3) {
          this.pendingInvites.delete(callId);
          pending.reject(new Error(`Authentication failed after ${pending.retryCount} attempts`));
          return;
        }

        const wwwAuth = resp.headers['www-authenticate'] || resp.headers['proxy-authenticate'] || '';
        const challenge = parseDigestChallenge(wwwAuth);
        if (challenge) {
          pending.retryCount++;
          pending.cseq++;
          pending.authCseq = pending.cseq; // mark which cseq has auth
          pending.branch = generateBranch();
          const uri = `sip:${pending.targetNumber}@${this.config.domain}`;
          const auth = computeDigestResponse(challenge, 'INVITE', uri, this.config.username, this.config.password);
          this.log('info', `[SIP] Auth retry #${pending.retryCount} for INVITE (cseq=${pending.cseq})`);
          this.sendInvite(callId, pending.fromTag, pending.targetNumber, pending.localRtpPort, pending.branch, pending.cseq, auth);
        } else {
          this.pendingInvites.delete(callId);
          pending.reject(new Error('Auth challenge parse error'));
        }
        return;
      }

      if (resp.statusCode === 200) {
        // Call established!
        const toTag = extractTagFromHeader(resp.headers['to'] || '');
        const rtpInfo = extractRtpInfoFromSdp(resp.body, this.config.host);

        const callInfo: SipCallInfo = {
          callId,
          fromTag: pending.fromTag,
          toTag,
          targetNumber: pending.targetNumber,
          localRtpPort: pending.localRtpPort,
          remoteRtpHost: rtpInfo?.host || this.config.host,
          remoteRtpPort: rtpInfo?.port || 0,
          codec: rtpInfo?.codec || 'alaw',
          cseq: respCseq,
          routeSet: [],
        };

        // Send ACK (MUST be sent for every 200 OK on INVITE)
        this.sendAck(callId, pending.fromTag, toTag, pending.targetNumber, respCseq);

        this.activeCalls.set(callId, callInfo);
        this.pendingInvites.delete(callId);
        this.log('info', `Call established: ${pending.targetNumber} → RTP ${callInfo.remoteRtpHost}:${callInfo.remoteRtpPort} (${callInfo.codec})`);
        this.emit('callEstablished', callInfo);
        pending.resolve(callInfo);
        return;
      }

      // Any other error response (3xx-6xx)
      if (resp.statusCode >= 300) {
        this.sendAck(callId, pending.fromTag, '', pending.targetNumber, respCseq);
        this.pendingInvites.delete(callId);
        pending.reject(new Error(`Call rejected: ${resp.statusCode} ${resp.statusText}`));
        return;
      }
    }

    // ─── BYE response ────────────────────────────────────────────────────
    if (method === 'BYE' && resp.statusCode === 200) {
      this.log('info', `BYE acknowledged for ${callId}`);
    }
  }

  private handleRequest(req: { method: string; uri: string; headers: Record<string, string>; body: string }, raw: string, rinfo: dgram.RemoteInfo): void {
    this.log('info', `← ${req.method} from ${rinfo.address}:${rinfo.port}`);

    if (req.method === 'OPTIONS') {
      this.sendOptionsResponse(req, rinfo);
      return;
    }

    if (req.method === 'BYE') {
      const incomingCallId = normalizeCallId(req.headers['call-id'] || '');
      this.sendSimpleResponse(200, 'OK', req, rinfo);
      let matchedCallId = findCallIdForBye(this.activeCalls, incomingCallId);
      if (!matchedCallId && this.activeCalls.size === 1) {
        matchedCallId = this.activeCalls.keys().next().value;
        this.log('info', `[SIP] BYE unknown call-id, but only 1 active → ending: ${matchedCallId}`);
      }
      if (matchedCallId) {
        this.activeCalls.delete(matchedCallId);
        this.emit('callEnded', matchedCallId);
        this.log('info', `[SIP] BYE received → call ended by remote: ${matchedCallId}`);
      } else {
        this.log('warn', `[SIP] BYE for unknown call-id: ${incomingCallId} (active: ${[...this.activeCalls.keys()].join(', ')})`);
      }
      return;
    }

    if (req.method === 'INVITE') {
      this.handleIncomingInvite(req, rinfo);
      return;
    }

    if (req.method === 'ACK') {
      // ACK for our response — no action needed
      return;
    }

    if (req.method === 'CANCEL') {
      const incomingCallId = normalizeCallId(req.headers['call-id'] || '');
      this.sendSimpleResponse(200, 'OK', req, rinfo);
      const matchedCallId = findCallIdForBye(this.activeCalls, incomingCallId);
      if (matchedCallId) {
        this.activeCalls.delete(matchedCallId);
        this.emit('callEnded', matchedCallId);
        this.log('info', `[SIP] CANCEL received → call ended: ${matchedCallId} (incoming: ${incomingCallId})`);
      } else {
        this.emit('callEnded', incomingCallId);
        this.log('info', `[SIP] CANCEL for unknown call-id, emitting anyway: ${incomingCallId}`);
      }
      return;
    }

    // Respond 405 Method Not Allowed for anything else
    this.sendSimpleResponse(405, 'Method Not Allowed', req, rinfo);
  }

  private handleIncomingInvite(req: { method: string; uri: string; headers: Record<string, string>; body: string }, rinfo: dgram.RemoteInfo): void {
    // 100 Trying — отправлять туда, откуда пришёл INVITE (иначе АТС не получит ответ)
    this.sendSimpleResponse(100, 'Trying', req, rinfo);

    const callId = normalizeCallId(req.headers['call-id'] || '');
    const fromTag = extractTagFromHeader(req.headers['from'] || '');
    const toTag = generateTag();
    const rtpInfo = extractRtpInfoFromSdp(req.body, rinfo.address);

    // Determine caller number from From header
    const fromMatch = (req.headers['from'] || '').match(/sip:([^@>]+)/);
    const callerNumber = fromMatch ? fromMatch[1] : 'unknown';

    const callInfo: SipCallInfo = {
      callId,
      fromTag,
      toTag,
      targetNumber: callerNumber,
      localRtpPort: 0, // Will be set by CallManager
      remoteRtpHost: rtpInfo?.host || rinfo.address,
      remoteRtpPort: rtpInfo?.port || 0,
      codec: rtpInfo?.codec || 'alaw',
      cseq: parseInt((req.headers['cseq'] || '1').split(/\s+/)[0], 10),
      routeSet: [],
    };

    (callInfo as any)._incomingReq = req;
    (callInfo as any)._incomingRinfo = rinfo; // куда слать 200 OK

    this.log('info', `Incoming call from ${callerNumber}`);
    this.emit('invite', callInfo);
  }

  /** Accept an incoming call (called by CallManager after setting up RTP). */
  acceptCall(callInfo: SipCallInfo): void {
    const req = (callInfo as any)._incomingReq;
    const rinfo = (callInfo as any)._incomingRinfo as dgram.RemoteInfo | undefined;
    if (!req) return;

    const sdp = [
      'v=0',
      `o=GeminiBot 0 0 IN IP4 ${this.localIp}`,
      's=GeminiLiveCall',
      `c=IN IP4 ${this.localIp}`,
      't=0 0',
      `m=audio ${callInfo.localRtpPort} RTP/AVP 8 0 101`,
      'a=rtpmap:8 PCMA/8000',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=fmtp:101 0-16',
      'a=ptime:20',
      'a=sendrecv',
    ].join('\r\n');

    const viaHeader = this.extractViaFromRequest(req);
    const cseq = req.headers['cseq'] || '1 INVITE';

    let msg = `SIP/2.0 200 OK\r\n`;
    msg += `${viaHeader}\r\n`;
    msg += `From: ${req.headers['from']}\r\n`;
    msg += `To: ${req.headers['to']};tag=${callInfo.toTag}\r\n`;
    msg += `Call-ID: ${callInfo.callId}\r\n`;
    msg += `CSeq: ${cseq}\r\n`;
    msg += `Contact: <sip:${this.config.username}@${this.localIp}:${this.localPort};transport=udp>\r\n`;
    msg += `Content-Type: application/sdp\r\n`;
    msg += `User-Agent: GeminiLiveSipBot/1.0\r\n`;
    msg += `Content-Length: ${Buffer.byteLength(sdp)}\r\n`;
    msg += `\r\n`;
    msg += sdp;

    if (rinfo) {
      this.sendTo(rinfo.address, rinfo.port, msg);
    } else {
      this.send(msg);
    }
    this.activeCalls.set(callInfo.callId, callInfo);
    this.log('info', `Accepted incoming call ${callInfo.callId}`);
  }

  private extractViaFromRequest(req: { headers: Record<string, string> }): string {
    // Return the Via header as-is for responses
    const viaValue = req.headers['via'] || req.headers['v'] || '';
    return `Via: ${viaValue}`;
  }

  private sendSimpleResponse(code: number, text: string, req: { headers: Record<string, string> }, rinfo?: dgram.RemoteInfo): void {
    const viaHeader = this.extractViaFromRequest(req);
    const cseq = req.headers['cseq'] || '1 OPTIONS';

    let msg = `SIP/2.0 ${code} ${text}\r\n`;
    msg += `${viaHeader}\r\n`;
    msg += `From: ${req.headers['from']}\r\n`;
    msg += `To: ${req.headers['to']}\r\n`;
    msg += `Call-ID: ${req.headers['call-id']}\r\n`;
    msg += `CSeq: ${cseq}\r\n`;
    msg += `User-Agent: GeminiLiveSipBot/1.0\r\n`;
    msg += `Content-Length: 0\r\n`;
    msg += `\r\n`;

    if (rinfo) {
      this.sendTo(rinfo.address, rinfo.port, msg);
    } else {
      this.send(msg);
    }
  }

  private sendOptionsResponse(req: { headers: Record<string, string> }, rinfo?: dgram.RemoteInfo): void {
    const viaHeader = this.extractViaFromRequest(req);
    const cseq = req.headers['cseq'] || '1 OPTIONS';

    let msg = `SIP/2.0 200 OK\r\n`;
    msg += `${viaHeader}\r\n`;
    msg += `From: ${req.headers['from']}\r\n`;
    msg += `To: ${req.headers['to']}\r\n`;
    msg += `Call-ID: ${req.headers['call-id']}\r\n`;
    msg += `CSeq: ${cseq}\r\n`;
    msg += `Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, NOTIFY\r\n`;
    msg += `User-Agent: GeminiLiveSipBot/1.0\r\n`;
    msg += `Content-Length: 0\r\n`;
    msg += `\r\n`;

    if (rinfo) {
      this.sendTo(rinfo.address, rinfo.port, msg);
    } else {
      this.send(msg);
    }
  }

  /** Отправить SIP на конкретный host:port (для ответов на входящие запросы) */
  private sendTo(host: string, port: number, msg: string): void {
    const buf = Buffer.from(msg, 'utf-8');
    this.socket.send(buf, port, host, (err) => {
      if (err) {
        this.log('error', `Failed to send to ${host}:${port}: ${err.message}`);
      } else {
        const firstLine = msg.split('\r\n')[0];
        this.log('info', `→ ${firstLine} (to ${host}:${port})`);
      }
    });
  }

  private send(msg: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const buf = Buffer.from(msg, 'utf-8');
      this.socket.send(buf, this.config.port, this.config.host, (err) => {
        if (err) {
          this.log('error', `Failed to send: ${err.message}`);
          reject(err);
        } else {
          // Log first line only
          const firstLine = msg.split('\r\n')[0];
          this.log('info', `→ ${firstLine}`);
          resolve();
        }
      });
    });
  }

  get isRegistered(): boolean {
    return this.registered;
  }

  getActiveCallIds(): string[] {
    return Array.from(this.activeCalls.keys());
  }

  getCallInfo(callId: string): SipCallInfo | undefined {
    return this.activeCalls.get(callId);
  }
}
