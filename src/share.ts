// Sharing timelines.
//
// A compact code, shown as a QR code (or copied into a message):
//   "OURSOUND2:" + base44( deflate-raw( slim JSON ) )   (older: "OURSOUND1:" + base64url)
// Too big for one easy QR code, it's split into parts scanned in any order:
//   "OSP2:" + part + "/" + parts + ":" + set id + ":" + slice of the code
//
// A timeline is just settings. Imported audio files never travel with it:
// instead the timeline lists them in `missingFiles` (name, length, size), and
// the receiver links their own copies (see relink.ts).
// Ids and dates are dropped (the receiver gets fresh ones).

import type { SharedFile, Timeline } from './engine/model.ts';
import { parseTimeline } from './engine/schema.ts';

const PREFIX = 'OURSOUND1:';
/** Current codes: QR-friendly characters (see toB44). */
const PREFIX2 = 'OURSOUND2:';
const FORMAT = 'oursound-timeline';
/** Bytes a single QR code can hold (version 40, low error correction, byte mode). */
export const QR_MAX_CHARS = 2900;

/** What we know about an imported file on this phone (a StoredAsset fits). */
export type FileInfo = { id: string; name: string; ext?: string; duration: number; size?: number };

function fromB64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** Asset ids the timeline's file segments use, in order of first use. */
export function usedAssetIds(tl: Timeline): string[] {
  const ids: string[] = [];
  for (const t of tl.soundtracks)
    for (const s of t.segments) if (s.generator === 'file' && s.assetId && !ids.includes(s.assetId)) ids.push(s.assetId);
  return ids;
}

/** The files a receiver will need: from this phone's library, or still missing here too. */
export function filesNeeded(tl: Timeline, library: FileInfo[]): SharedFile[] {
  const out: SharedFile[] = [];
  for (const id of usedAssetIds(tl)) {
    const a = library.find((x) => x.id === id) ?? tl.missingFiles?.find((x) => x.id === id);
    if (!a) continue;
    out.push({ id, name: a.name, ext: a.ext, duration: Math.round(a.duration * 1000) / 1000, size: a.size });
  }
  return out;
}

const round = (v: number) => (Number.isInteger(v) ? v : Math.round(v * 10000) / 10000);
const isEmpty = (v: unknown) =>
  v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && Object.keys(v).length === 0);

/** Drops fields equal to their default (the schema fills them back in). */
function strip<T extends object>(o: T, defaults: Record<string, unknown>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k in defaults ? v === defaults[k] || (isEmpty(v) && isEmpty(defaults[k])) : v === undefined) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * Shortest JSON for sharing: no ids or dates, default values left out, file
 * ids shortened ("f0", "f1"...), numbers trimmed.
 */
function slim(tl: Timeline, library: FileInfo[]): unknown {
  const tid = new Map(tl.soundtracks.map((t, i) => [t.id, 't' + i]));
  const files = filesNeeded(tl, library);
  const fid = new Map(files.map((f, i) => [f.id, 'f' + i]));
  return JSON.parse(
    JSON.stringify(
      {
        ...strip({ name: tl.name, duration: tl.duration, endBehavior: tl.endBehavior, masterGainDb: tl.masterGainDb }, {
          endBehavior: 'stop',
          masterGainDb: 0,
        }),
        soundtracks: tl.soundtracks.map((t) => ({
          ...strip({ ...t, id: undefined, segments: undefined }, { gainDb: 0, pan: 0, mute: false, solo: false, automation: [] }),
          segments: t.segments.map((seg) => {
            const file = seg.generator === 'file';
            return strip(
              { ...seg, id: undefined, assetId: seg.assetId && (fid.get(seg.assetId) ?? seg.assetId), seed: file && seg.repeat.mode !== 'random' ? undefined : seg.seed },
              { fadeIn: 0, fadeOut: 0, gainDb: 0, params: {}, seed: 1, automation: [], repeat: undefined },
            );
          }),
        })),
        focus:
          tl.focus && tid.has(tl.focus.lead)
            ? {
                ...tl.focus,
                lead: tid.get(tl.focus.lead),
                follow: tl.focus.follow.filter((f) => tid.has(f)).map((f) => tid.get(f)),
                fill: tl.focus.fill?.filter((f) => tid.has(f)).map((f) => tid.get(f)),
              }
            : undefined,
        missingFiles: files.length ? files.map((f) => strip({ ...f, id: fid.get(f.id) }, { ext: undefined, size: undefined })) : undefined,
      },
      (k, v) => (k === 'repeat' && v?.mode === 'none' ? undefined : typeof v === 'number' ? round(v) : v),
    ),
  );
}

/** Gives a slimmed timeline its ids back, ready for the schema. */
function expand(data: Record<string, unknown>): Record<string, unknown> {
  const tracks = Array.isArray(data.soundtracks) ? (data.soundtracks as Record<string, unknown>[]) : [];
  return {
    id: 'shared',
    ...data,
    soundtracks: tracks.map((t, i) => ({
      id: 't' + i,
      ...t,
      segments: (Array.isArray(t.segments) ? (t.segments as Record<string, unknown>[]) : []).map((seg, j) => ({ id: 's' + j, ...seg })),
    })),
  };
}

// QR codes store uppercase letters, digits and a few symbols ("alphanumeric
// mode") in 5.5 bits a character instead of 8, so the code is written with
// those: every 2 bytes become 3 characters (base 44; no space, which apps trim).
const B44 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$%*+-./:';

function toB44(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    let n = bytes[i]! * 256 + bytes[i + 1]!;
    for (let k = 0; k < 3; k++, n = Math.floor(n / 44)) s += B44[n % 44];
  }
  if (bytes.length % 2) {
    const n = bytes[bytes.length - 1]!;
    s += B44[n % 44]! + B44[Math.floor(n / 44)]!;
  }
  return s;
}

function fromB44(text: string): Uint8Array {
  const out: number[] = [];
  const val = (c: string) => {
    const v = B44.indexOf(c);
    if (v < 0) throw new Error('bad character');
    return v;
  };
  let i = 0;
  for (; i + 2 < text.length; i += 3) {
    const n = val(text[i]!) + val(text[i + 1]!) * 44 + val(text[i + 2]!) * 44 * 44;
    if (n > 0xffff) throw new Error('bad group');
    out.push(n >> 8, n & 0xff);
  }
  if (text.length - i === 2) out.push(val(text[i]!) + val(text[i + 1]!) * 44);
  else if (text.length - i !== 0) throw new Error('bad length');
  return new Uint8Array(out);
}

export async function encodeTimeline(tl: Timeline, library: FileInfo[] = []): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(slim(tl, library)));
  const packed = await pipe(json, new CompressionStream('deflate-raw'));
  return PREFIX2 + toB44(packed);
}

const damaged = () => new Error('This code looks damaged or incomplete.');

/** Decodes a shared code back into a timeline (throws a readable error). */
export async function decodeTimeline(code: string): Promise<Timeline> {
  const text = code.trim();
  const v2 = text.startsWith(PREFIX2);
  if (!v2 && !text.startsWith(PREFIX)) throw new Error("This isn't an OurSound timeline code.");
  let data: Record<string, unknown>;
  try {
    const bytes = v2 ? fromB44(text.slice(PREFIX2.length)) : fromB64Url(text.slice(PREFIX.length));
    const raw = await pipe(bytes, new DecompressionStream('deflate-raw'));
    data = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw damaged();
  }
  try {
    return parseTimeline(expand(data));
  } catch {
    throw new Error('This timeline was made by a newer OurSound, or the code is damaged.');
  }
}

/**
 * Reads anything shared with the app: a ".oursound" file's text, or a message
 * containing a code. Throws a readable error.
 */
export async function readShared(text: string): Promise<Timeline> {
  const t = text.replace(/^﻿/, '').trim();
  if (t.startsWith('{')) {
    let data: { format?: unknown; timeline?: unknown };
    try {
      data = JSON.parse(t);
    } catch {
      throw new Error('This file looks damaged or incomplete.');
    }
    if (data.format !== FORMAT || typeof data.timeline !== 'object' || !data.timeline)
      throw new Error("This isn't an OurSound timeline.");
    try {
      return parseTimeline({ id: 'shared', ...(data.timeline as Record<string, unknown>) });
    } catch {
      throw new Error('This timeline was made by a newer OurSound, or it is damaged.');
    }
  }
  const v2 = t.indexOf(PREFIX2);
  if (v2 >= 0) return decodeTimeline(t.slice(v2).match(/^OURSOUND2:[0-9A-Z$%*+\-./:]+/)?.[0] ?? '');
  const at = t.indexOf(PREFIX);
  if (at < 0) throw new Error("This isn't an OurSound timeline.");
  const code = t.slice(at).match(/^OURSOUND1:[A-Za-z0-9_-]+/)?.[0] ?? '';
  return decodeTimeline(code);
}

/** Imported audio files can't travel inside a share. */
export function usesImportedAudio(tl: Timeline): boolean {
  return tl.soundtracks.some((t) => t.segments.some((s) => s.generator === 'file'));
}

// ------------------------------------------------------------ multi-part QR codes

const PART = /^OSP[12]:(\d+)\/(\d+):([A-Za-z0-9]+):(.*)$/s;
/** Characters per part QR code: small enough to scan in a moment (about version 13). */
export const PART_CHARS = 560;
/** A single code up to this size; bigger ones are split. */
export const EASY_QR_CHARS = 700;

/** One code, or the QR parts for it (each scannable on its own, in any order). */
export function qrParts(code: string, max = EASY_QR_CHARS, partChars = PART_CHARS): string[] {
  if (code.length <= max) return [code];
  const n = Math.ceil(code.length / partChars);
  const size = Math.ceil(code.length / n);
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (Math.imul(h, 31) + code.charCodeAt(i)) | 0;
  const set = (h >>> 0).toString(36).toUpperCase();
  return Array.from({ length: n }, (_, i) => `OSP2:${i + 1}/${n}:${set}:${code.slice(i * size, (i + 1) * size)}`);
}

export type PartScan = { done: true; code: string } | { done: false; have: number; total: number; next: number };

/** Collects scanned parts; when all are in, gives back the whole code. */
export class PartCollector {
  private set = '';
  private parts: string[] = [];

  /** null if `text` isn't a part (a whole code or something else). */
  add(text: string): PartScan | null {
    const m = PART.exec(text.replace(/^\s+|[\r\n]+$/g, ''));
    if (!m) return null;
    const [, k, n, set, body] = m;
    const i = Number(k) - 1;
    const total = Number(n);
    if (set !== this.set || this.parts.length !== total) {
      this.set = set;
      this.parts = new Array<string>(total).fill('');
    }
    if (i >= 0 && i < total) this.parts[i] = body;
    const have = this.parts.filter(Boolean).length;
    if (have === total) {
      const code = this.parts.join('');
      this.set = '';
      this.parts = [];
      return { done: true, code };
    }
    return { done: false, have, total, next: this.parts.findIndex((p) => !p) + 1 };
  }
}
