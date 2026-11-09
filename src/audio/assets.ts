// Main-thread side of imported audio: import, storage and chunk decoding.
//
// The original file is stored as-is in IndexedDB on the phone (no conversion,
// no copy in memory). When the engine needs a 5-second chunk, it's decoded
// on demand with mediabunny (WebCodecs) and handed to the audio thread.

import { Capacitor } from '@capacitor/core';
import { del, get, set } from 'idb-keyval';
import { NativeEngine, type NativeAssetMeta } from '../native/engine-plugin.ts';
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import { ASSET_CHUNK_SEC, type AssetMeta } from '../engine/assets.ts';

const INDEX_KEY = 'oursound.assets.v1';
const blobKey = (id: string) => `oursound.asset.${id}`;

export type StoredAsset = AssetMeta & { size: number; type: string; importedAt: number; /** e.g. ".flac" */ ext?: string };

let index: StoredAsset[] | null = null;
const listeners = new Set<(a: StoredAsset[]) => void>();

/** On the phone, imported files live in the app's own storage and are decoded natively. */
const isNative = Capacitor.isNativePlatform();

const fromNative = (m: NativeAssetMeta): StoredAsset => ({
  id: m.id,
  name: m.name,
  sampleRate: m.sampleRate,
  channels: m.channels,
  duration: m.duration,
  size: m.size,
  type: '',
  importedAt: m.importedAt,
  ext: /\.[^./\\]+$/.exec(m.path)?.[0]?.toLowerCase(),
});

/** Adds (or replaces) natively imported files in the list. */
export async function addNativeAssets(metas: NativeAssetMeta[]): Promise<StoredAsset[]> {
  const assets = metas.map(fromNative);
  const ids = new Set(assets.map((a) => a.id));
  index = [...(await listAssets()).filter((a) => !ids.has(a.id)), ...assets];
  for (const fn of listeners) fn(index);
  return assets;
}

export async function listAssets(): Promise<StoredAsset[]> {
  if (isNative) {
    if (!index) index = (await NativeEngine.listAssets()).assets.map(fromNative);
    return index;
  }
  if (!index) index = ((await get(INDEX_KEY)) as StoredAsset[] | undefined) ?? [];
  return index;
}

/** Native import: opens Android's file picker. Returns null if cancelled. */
export async function importAudioNative(): Promise<StoredAsset | null> {
  const r = await NativeEngine.importAudio();
  if (r.cancelled) return null;
  const asset = fromNative(r);
  index = [...(await listAssets()).filter((a) => a.id !== asset.id), asset];
  for (const fn of listeners) fn(index);
  return asset;
}

/** Native import of several files at once (an album), in the order picked. */
export async function importAudioNativeMany(): Promise<{ assets: StoredAsset[]; failed: string[] } | null> {
  const r = await NativeEngine.importAudioMany();
  if (r.cancelled) return null;
  const assets = (r.assets ?? []).map(fromNative);
  const ids = new Set(assets.map((a) => a.id));
  index = [...(await listAssets()).filter((a) => !ids.has(a.id)), ...assets];
  for (const fn of listeners) fn(index);
  return { assets, failed: r.failed ?? [] };
}

export const usesNativeAssets = isNative;

export function onAssetsChanged(fn: (a: StoredAsset[]) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function saveIndex(list: StoredAsset[]) {
  index = list;
  await set(INDEX_KEY, list);
  for (const fn of listeners) fn(list);
}

const newAssetId = () =>
  'as_' + (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now()) + Math.random());

/** Reads a file's audio track info, or throws a readable error. */
async function probe(blob: Blob) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('This file has no audio track.');
    if (!(await track.canDecode())) throw new Error(`This phone can't decode ${track.codec ?? 'this'} audio.`);
    const duration = await track.computeDuration();
    if (!(duration > 0)) throw new Error('This file seems to be empty.');
    return { sampleRate: track.sampleRate, channels: track.numberOfChannels, duration };
  } finally {
    input.dispose();
  }
}

export async function importAudioFile(file: File): Promise<StoredAsset> {
  const info = await probe(file);
  const asset: StoredAsset = {
    id: newAssetId(),
    name: file.name.replace(/\.[^.]+$/, ''),
    ext: /\.[^.]+$/.exec(file.name)?.[0]?.toLowerCase(),
    size: file.size,
    type: file.type,
    importedAt: Date.now(),
    ...info,
  };
  await set(blobKey(asset.id), file);
  await saveIndex([...(await listAssets()), asset]);
  return asset;
}

export async function deleteAsset(id: string) {
  if (isNative) {
    await NativeEngine.deleteAsset({ id });
    index = (await listAssets()).filter((a) => a.id !== id);
    for (const fn of listeners) fn(index);
    return;
  }
  closeDecoder(id);
  await del(blobKey(id));
  await saveIndex((await listAssets()).filter((a) => a.id !== id));
}

// ------------------------------------------------------------ decoding

type Decoder = { input: Input; sink: AudioSampleSink; meta: StoredAsset; queue: Promise<void> };
const decoders = new Map<string, Promise<Decoder | null>>();

function openDecoder(id: string): Promise<Decoder | null> {
  let d = decoders.get(id);
  if (!d) {
    d = (async () => {
      const meta = (await listAssets()).find((a) => a.id === id);
      const blob = (await get(blobKey(id))) as Blob | undefined;
      if (!meta || !blob) return null;
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
      const track = await input.getPrimaryAudioTrack();
      if (!track) return null;
      return { input, sink: new AudioSampleSink(track), meta, queue: Promise.resolve() };
    })();
    decoders.set(id, d);
  }
  return d;
}

function closeDecoder(id: string) {
  const d = decoders.get(id);
  decoders.delete(id);
  void d?.then((x) => x?.input.dispose());
}

/**
 * Decodes chunk `idx` of an asset into planar stereo Float32 at the file's
 * own sample rate (mono files are duplicated). Chunks are decoded one at a
 * time per file, in request order.
 */
export async function decodeChunk(id: string, idx: number): Promise<{ L: Float32Array; R: Float32Array } | null> {
  const dec = await openDecoder(id);
  if (!dec) return null;
  const run = async () => {
    const { meta, sink } = dec;
    const cf = Math.round(ASSET_CHUNK_SEC * meta.sampleRate);
    const total = Math.ceil(meta.duration * meta.sampleRate);
    const len = Math.max(0, Math.min(cf, total - idx * cf));
    const L = new Float32Array(len);
    const R = new Float32Array(len);
    const t0 = (idx * cf) / meta.sampleRate;
    const t1 = t0 + len / meta.sampleRate;
    let scratch = new Float32Array(0);
    for await (const sample of sink.samples(t0, t1)) {
      try {
        const frames = sample.numberOfFrames;
        if (scratch.length < frames) scratch = new Float32Array(frames);
        const at = Math.round((sample.timestamp - t0) * meta.sampleRate);
        for (let ch = 0; ch < Math.min(2, sample.numberOfChannels); ch++) {
          sample.copyTo(scratch, { planeIndex: ch, format: 'f32-planar' });
          const dst = ch === 0 ? L : R;
          // copy the overlap of [at, at+frames) with [0, len)
          const from = Math.max(0, -at);
          const to = Math.min(frames, len - at);
          if (to > from) dst.set(scratch.subarray(from, to), at + from);
        }
        if (sample.numberOfChannels === 1) {
          const from = Math.max(0, -at);
          const to = Math.min(frames, len - at);
          if (to > from) R.set(L.subarray(at + from, at + to), at + from);
        }
      } finally {
        sample.close();
      }
    }
    return { L, R };
  };
  const result = dec.queue.then(run, run);
  dec.queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function assetMetas(list: StoredAsset[]): AssetMeta[] {
  return list.map(({ id, name, sampleRate, channels, duration }) => ({ id, name, sampleRate, channels, duration }));
}
