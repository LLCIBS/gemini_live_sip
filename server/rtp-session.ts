import dgram from 'dgram';
import { EventEmitter } from 'events';

// RTP header: 12 bytes fixed
// V=2, P=0, X=0, CC=0, M=0/1, PT=payload type
// Sequence number (16 bit), Timestamp (32 bit), SSRC (32 bit)

export interface RtpPacket {
  version: number;
  padding: boolean;
  extension: boolean;
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  payload: Buffer;
}

export const PAYLOAD_PCMU = 0;
export const PAYLOAD_PCMA = 8;
export const PAYLOAD_TELEPHONE_EVENT = 101;

// G.711: 8000 Hz, 1 byte per sample → 160 bytes per 20ms frame
export const SAMPLES_PER_FRAME = 160;
export const FRAME_DURATION_MS = 20;

export function parseRtpPacket(buf: Buffer): RtpPacket | null {
  if (buf.length < 12) return null;

  const b0 = buf[0];
  const version = (b0 >> 6) & 0x03;
  if (version !== 2) return null;

  const padding = !!(b0 & 0x20);
  const extension = !!(b0 & 0x10);
  const cc = b0 & 0x0f;

  const b1 = buf[1];
  const marker = !!(b1 & 0x80);
  const payloadType = b1 & 0x7f;

  const sequenceNumber = buf.readUInt16BE(2);
  const timestamp = buf.readUInt32BE(4);
  const ssrc = buf.readUInt32BE(8);

  let headerLen = 12 + cc * 4;
  if (extension && buf.length >= headerLen + 4) {
    const extLen = buf.readUInt16BE(headerLen + 2);
    headerLen += 4 + extLen * 4;
  }

  let payloadEnd = buf.length;
  if (padding && buf.length > headerLen) {
    payloadEnd -= buf[buf.length - 1];
  }

  if (headerLen > payloadEnd) return null;

  return {
    version,
    padding,
    extension: !!(b0 & 0x10),
    marker,
    payloadType,
    sequenceNumber,
    timestamp,
    ssrc,
    payload: buf.subarray(headerLen, payloadEnd),
  };
}

export function buildRtpPacket(
  payloadType: number,
  sequenceNumber: number,
  timestamp: number,
  ssrc: number,
  payload: Buffer,
  marker = false
): Buffer {
  const header = Buffer.allocUnsafe(12);
  header[0] = 0x80; // V=2, P=0, X=0, CC=0
  header[1] = (marker ? 0x80 : 0x00) | (payloadType & 0x7f);
  header.writeUInt16BE(sequenceNumber & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

export interface RtpSessionConfig {
  localPort?: number; // 0 = random
  remoteHost: string;
  remotePort: number;
  payloadType: number; // 0=PCMU, 8=PCMA
  ssrc?: number;
}

export declare interface RtpSession {
  on(event: 'audio', listener: (pcmPayload: Buffer, pt: number) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'ready', listener: (localPort: number) => void): this;
  emit(event: 'audio', pcmPayload: Buffer, pt: number): boolean;
  emit(event: 'error', err: Error): boolean;
  emit(event: 'ready', localPort: number): boolean;
}

export class RtpSession extends EventEmitter {
  private socket: dgram.Socket;
  private config: RtpSessionConfig;
  private seqNum = 0;
  private timestamp = 0;
  private ssrc: number;
  private _localPort = 0;
  private _closed = false;

  constructor(config: RtpSessionConfig) {
    super();
    this.config = config;
    this.ssrc = config.ssrc ?? (Math.random() * 0xffffffff) >>> 0;
    this.socket = dgram.createSocket('udp4');

    this.socket.on('error', (err) => {
      if (!this._closed) this.emit('error', err);
    });

    this.socket.on('message', (msg, rinfo) => {
      const pkt = parseRtpPacket(msg);
      if (!pkt) return;
      // Dynamically update remote address from first incoming RTP (symmetric RTP)
      if (this.config.remotePort === 0 || this.config.remoteHost === '0.0.0.0') {
        this.config.remoteHost = rinfo.address;
        this.config.remotePort = rinfo.port;
      }
      this.emit('audio', pkt.payload, pkt.payloadType);
    });

    this.socket.bind(config.localPort || 0, () => {
      this._localPort = this.socket.address().port;
      this.emit('ready', this._localPort);
    });
  }

  get localPort(): number {
    return this._localPort;
  }

  get closed(): boolean {
    return this._closed;
  }

  /**
   * Advance the RTP timestamp by one frame without sending a packet.
   * Call this for "silent gaps" where the receiver should use PLC —
   * ensures the next sent frame has a correct timestamp relative to real time.
   */
  advanceTimestamp(frames = 1): void {
    this.timestamp = (this.timestamp + SAMPLES_PER_FRAME * frames) >>> 0;
  }

  /**
   * Send one G.711 frame (typically 160 bytes = 20ms at 8kHz).
   */
  sendFrame(payload: Buffer, marker = false): void {
    if (this._closed) return;
    const pkt = buildRtpPacket(
      this.config.payloadType,
      this.seqNum,
      this.timestamp,
      this.ssrc,
      payload,
      marker
    );
    this.seqNum = (this.seqNum + 1) & 0xffff;
    this.timestamp = (this.timestamp + SAMPLES_PER_FRAME) >>> 0;

    this.socket.send(pkt, this.config.remotePort, this.config.remoteHost, (err) => {
      if (err && !this._closed) this.emit('error', err);
    });
  }

  /**
   * Send a larger buffer by splitting into 160-byte frames, paced at 20ms intervals.
   * Returns a promise that resolves when all frames are sent.
   */
  sendAudio(g711Buf: Buffer): Promise<void> {
    return new Promise((resolve) => {
      let offset = 0;
      const sendNext = () => {
        if (this._closed || offset >= g711Buf.length) {
          resolve();
          return;
        }
        const end = Math.min(offset + SAMPLES_PER_FRAME, g711Buf.length);
        const frame = g711Buf.subarray(offset, end);
        this.sendFrame(frame, offset === 0);
        offset = end;
        setTimeout(sendNext, FRAME_DURATION_MS);
      };
      sendNext();
    });
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this.socket.close();
    } catch {
      // ignore
    }
    this.removeAllListeners();
  }
}
