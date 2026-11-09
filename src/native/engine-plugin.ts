import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { EngineStatus } from '../engine/core.ts';
import type { Timeline } from '../engine/model.ts';

/** Status pushed by the native engine (EngineStatus + diagnostics). */
export type NativeStatus = EngineStatus & { timelineId: string | null; underruns: number };

export type NativeAssetMeta = {
  id: string;
  name: string;
  path: string;
  sampleRate: number;
  channels: number;
  duration: number;
  size: number;
  importedAt: number;
};

export type FoundAudio = { uri: string; name: string; size: number; duration?: number; folder: string };

/** The native audio engine (android/.../NativeAudio.java via PlaybackPlugin.java). */
export interface NativeEnginePlugin {
  engineLoad(o: { timeline: Timeline }): Promise<void>;
  enginePlay(o: { fadeSeconds: number }): Promise<void>;
  enginePause(o: { fadeSeconds?: number }): Promise<void>;
  engineSeek(o: { seconds: number }): Promise<void>;
  engineSetCap(o: { capDb: number }): Promise<void>;
  engineSleep(o: { seconds: number | null; fadeSeconds: number }): Promise<void>;
  engineStatusEvery(o: { seconds: number }): Promise<void>;
  engineGetStatus(): Promise<NativeStatus>;
  listAssets(): Promise<{ assets: NativeAssetMeta[] }>;
  importAudio(): Promise<NativeAssetMeta & { cancelled?: boolean }>;
  importAudioMany(): Promise<{ assets?: NativeAssetMeta[]; failed?: string[]; cancelled?: boolean }>;
  deleteAsset(o: { id: string }): Promise<void>;
  scanQr(): Promise<{ text?: string; cancelled?: boolean }>;
  /** Every audio file Android knows about (asks for permission). */
  scanAudio(): Promise<{ files: FoundAudio[]; denied?: boolean }>;
  /** Audio files in a folder the user picks (length unknown). */
  scanFolder(): Promise<{ files?: FoundAudio[]; cancelled?: boolean }>;
  importAudioUri(o: { uri: string }): Promise<NativeAssetMeta>;
  addListener(event: 'engineStatus', fn: (s: NativeStatus) => void): Promise<PluginListenerHandle>;
}

export const NativeEngine = registerPlugin<NativeEnginePlugin>('Playback');
