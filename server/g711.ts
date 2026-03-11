// G.711 A-law / μ-law codec and PCM resampling utilities.
// All functions operate on raw Buffers — no dependencies.

// ─── A-law encode/decode lookup tables ───────────────────────────────────────

const ALAW_ENCODE = new Uint8Array(65536);
const ALAW_DECODE = new Int16Array(256);

function buildAlawTables() {
  // Build decode table first (canonical ITU-T G.711 A-law)
  for (let i = 0; i < 256; i++) {
    let ix = i ^ 0x55;
    const sign = ix & 0x80;
    ix &= 0x7f;
    let sample: number;
    const seg = (ix >> 4) & 0x07;
    const quant = ix & 0x0f;
    if (seg === 0) {
      sample = (quant * 2 + 1) * 2; // +1 for midrise
    } else {
      sample = ((quant * 2 + 33) << (seg - 1)) * 2;
    }
    ALAW_DECODE[i] = sign ? -sample : sample;
  }

  // Build encode table: for every signed 16-bit value, find closest A-law byte
  for (let s = -32768; s <= 32767; s++) {
    let sample = s;
    let sign = 0;
    if (sample < 0) {
      sign = 0x80;
      sample = -sample;
    }
    if (sample > 32767) sample = 32767;

    let seg = 0;
    let val = sample >> 1; // A-law uses 13-bit precision
    if (val >= 256) {
      seg = 1;
      let v = val >> 4;
      while (v > 1 && seg < 7) {
        v >>= 1;
        seg++;
      }
    }

    let quant: number;
    if (seg === 0) {
      quant = (val >> 1) & 0x0f;
    } else {
      quant = (val >> seg) & 0x0f;
    }

    const encoded = (sign | (seg << 4) | quant) ^ 0x55;
    ALAW_ENCODE[(s + 32768) & 0xffff] = encoded;
  }
}

// ─── μ-law encode/decode lookup tables ───────────────────────────────────────

const ULAW_ENCODE = new Uint8Array(65536);
const ULAW_DECODE = new Int16Array(256);

const ULAW_BIAS = 0x84;
const ULAW_CLIP = 32635;

function buildUlawTables() {
  // Decode table
  for (let i = 0; i < 256; i++) {
    const ix = ~i;
    const sign = ix & 0x80;
    const exponent = (ix >> 4) & 0x07;
    const mantissa = ix & 0x0f;
    const sample = ((mantissa << 3) + ULAW_BIAS) << exponent;
    ULAW_DECODE[i] = sign ? -(sample - ULAW_BIAS) : (sample - ULAW_BIAS);
  }

  // Encode table
  for (let s = -32768; s <= 32767; s++) {
    let sample = s;
    let sign = 0;
    if (sample < 0) {
      sign = 0x80;
      sample = -sample;
    }
    if (sample > ULAW_CLIP) sample = ULAW_CLIP;
    sample += ULAW_BIAS;

    let exponent = 7;
    const mask = 0x4000;
    for (let i = 0; i < 8; i++) {
      if (sample & (mask >> i)) {
        exponent = 7 - i;
        break;
      }
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    ULAW_ENCODE[(s + 32768) & 0xffff] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
}

buildAlawTables();
buildUlawTables();

// ─── Public codec functions ──────────────────────────────────────────────────

/** Encode signed 16-bit PCM samples to G.711 A-law bytes. */
export function pcmToAlaw(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = ALAW_ENCODE[(pcm[i] + 32768) & 0xffff];
  }
  return out;
}

/** Decode G.711 A-law bytes to signed 16-bit PCM samples. */
export function alawToPcm(alaw: Buffer): Int16Array {
  const out = new Int16Array(alaw.length);
  for (let i = 0; i < alaw.length; i++) {
    out[i] = ALAW_DECODE[alaw[i]];
  }
  return out;
}

/** Encode signed 16-bit PCM samples to G.711 μ-law bytes. */
export function pcmToUlaw(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = ULAW_ENCODE[(pcm[i] + 32768) & 0xffff];
  }
  return out;
}

/** Decode G.711 μ-law bytes to signed 16-bit PCM samples. */
export function ulawToPcm(ulaw: Buffer): Int16Array {
  const out = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) {
    out[i] = ULAW_DECODE[ulaw[i]];
  }
  return out;
}

// ─── Telephony preprocessing (before G.711 encode) ───────────────────────────

/**
 * Prepare PCM for G.711 encoding: DC removal, peak normalization, soft clip.
 * Gemini TTS often outputs low-level audio — G.711 quantization noise becomes
 * audible ("вязь", "помехи"). Boosting to use ~70% of dynamic range reduces
 * relative quantization noise. Soft clip avoids harsh distortion.
 */
export function prepareForTelephony(pcm: Int16Array): Int16Array {
  if (pcm.length === 0) return pcm;
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
    sum += pcm[i];
  }
  const dc = Math.round(sum / pcm.length);
  const TARGET_PEAK = 22937; // ~70% of 32767, leaves headroom
  const MIN_PEAK_FOR_GAIN = 256;
  let gain = 1;
  if (peak > MIN_PEAK_FOR_GAIN) {
    gain = Math.min(5, TARGET_PEAK / peak);
  }
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = (pcm[i] - dc) * gain;
    // Soft clip: tanh-like curve avoids harsh clipping distortion
    const sign = s >= 0 ? 1 : -1;
    const abs = Math.abs(s);
    if (abs > 32767) {
      s = sign * (32767 - 32767 * 32767 / (abs + 32767));
    }
    out[i] = Math.round(s);
  }
  return out;
}

// ─── Resampling ──────────────────────────────────────────────────────────────

/** Linear-interpolation resample. Works for any ratio. */
export function resample(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.round(input.length / ratio);
  const output = new Int16Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    if (srcIdx + 1 < input.length) {
      output[i] = Math.round(input[srcIdx] * (1 - frac) + input[srcIdx + 1] * frac);
    } else {
      output[i] = input[Math.min(srcIdx, input.length - 1)];
    }
  }
  return output;
}

/** Convenience: 8 kHz → 16 kHz (for sending to Gemini) */
export function upsample8to16(pcm8k: Int16Array): Int16Array {
  return resample(pcm8k, 8000, 16000);
}

/**
 * 24 kHz → 8 kHz with box-filter anti-aliasing (ratio exactly 3:1).
 * Averages every group of 3 input samples before decimation, acting as
 * a low-pass filter that suppresses aliasing above 4 kHz (Nyquist for 8 kHz).
 * This produces noticeably cleaner voice compared to plain linear interpolation.
 */
export function downsample24to8(pcm24k: Int16Array): Int16Array {
  const outLen = Math.floor(pcm24k.length / 3);
  const output = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const base = i * 3;
    output[i] = Math.round((pcm24k[base] + pcm24k[base + 1] + pcm24k[base + 2]) / 3);
  }
  return output;
}

/** Convert Int16Array PCM to base64 string (for Gemini sendRealtimeInput). */
export function pcmToBase64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
}

/** Convert base64 PCM string to Int16Array (from Gemini response). */
export function base64ToPcm(b64: string): Int16Array {
  const buf = Buffer.from(b64, 'base64');
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
}
