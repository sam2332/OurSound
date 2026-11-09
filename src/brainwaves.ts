// The commonly used brainwave bands, for beat / pulse frequencies.
// (Ranges vary slightly between sources; these are the usual ones.)

export type Band = {
  id: 'delta' | 'theta' | 'alpha' | 'beta' | 'gamma';
  name: string;
  min: number;
  max: number;
  /** Frequency the band chip sets. */
  pick: number;
  use: string;
};

export const BANDS: Band[] = [
  { id: 'delta', name: 'Delta', min: 0.5, max: 4, pick: 2, use: 'Deep, dreamless sleep' },
  { id: 'theta', name: 'Theta', min: 4, max: 8, pick: 6, use: 'Drowsy, dreaming, deep meditation' },
  { id: 'alpha', name: 'Alpha', min: 8, max: 13, pick: 10, use: 'Calm, relaxed, eyes-closed rest' },
  { id: 'beta', name: 'Beta', min: 13, max: 30, pick: 18, use: 'Alert, focused thinking' },
  { id: 'gamma', name: 'Gamma', min: 30, max: 40, pick: 40, use: 'Peak concentration (40 Hz)' },
];

export function bandFor(hz: number): Band | undefined {
  if (hz < BANDS[0].min) return undefined;
  return BANDS.find((b) => hz < b.max) ?? (hz <= BANDS[BANDS.length - 1].max ? BANDS[BANDS.length - 1] : undefined);
}

/** Which param of a generator is the brainwave frequency. */
export function brainwaveParam(generator: string): string | null {
  if (generator === 'binaural' || generator === 'monaural') return 'beat';
  if (generator === 'isochronic') return 'rate';
  return null;
}
