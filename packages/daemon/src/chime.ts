/**
 * Chime generator (FR: app-grade notifications with tone + volume).
 * Writes a short pleasant two-tone chime (A5 → E6) as 16-bit PCM WAV on
 * first use; played back with afplay at user-configured volume.
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SAMPLE_RATE = 44_100;

export function chimePath(dataDir: string): string {
  const dir = path.join(dataDir, 'assets');
  const file = path.join(dir, 'chime.wav');
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });

  const durationSec = 0.55;
  const n = Math.floor(SAMPLE_RATE * durationSec);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // two-note motif with exponential decay
    const freq = t < 0.22 ? 880 : 1318.5; // A5 then E6
    const local = t < 0.22 ? t : t - 0.22;
    const attack = Math.min(1, local / 0.01);
    const decay = Math.exp(-local * 7);
    const env = attack * decay;
    const vibrato = 1 + 0.002 * Math.sin(2 * Math.PI * 6 * t);
    const s = Math.sin(2 * Math.PI * freq * vibrato * t) * env;
    samples[i] = Math.max(-32767, Math.min(32767, Math.round(s * 28000)));
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + n * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(n * 2, 40);

  writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer)]));
  return file;
}
