// Linking a shared timeline's audio files to the receiver's own copies.
//
// The receiver's copy of a song can have a different file name ("03 - Rain.flac"
// vs "Rain.flac"), so files are matched on several clues: exact size, length,
// and how alike the names are. Each needed file gets at most one candidate,
// and each candidate is used at most once.

import type { SharedFile, Timeline } from './engine/model.ts';

/** An audio file found on this phone. */
export type Candidate = {
  /** content:// uri to copy it from (absent for files already in OurSound). */
  uri?: string;
  /** Already imported into OurSound: its asset id. */
  libraryId?: string;
  name: string;
  /** Seconds; 0 or absent when unknown. */
  duration?: number;
  size?: number;
  /** Where it is, for showing ("Music/Album"). */
  folder?: string;
};

export type Confidence = 'sure' | 'likely' | 'guess';
export type Match = { candidate: Candidate; score: number; confidence: Confidence };

const AUDIO_EXT = /\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|wave|aif|aiff|wma|mka|webm|3gp|amr|mp4)$/i;

/** Lowercase words of a file name, without extension, track numbers or punctuation. */
export function normName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(AUDIO_EXT, '')
    .replace(/[_.\-–—()[\]{},;:!?'"`~+&]+/g, ' ')
    .replace(/^\s*(cd|disc|disk)?\s*\d{1,2}\s*[-. ]?\s*\d{0,3}\s+(?=\D)/, '') // "01 ", "1-03 ", "disc 2 05 "
    .replace(/\s+/g, ' ')
    .trim();
}

function words(n: string): Set<string> {
  return new Set(n.split(' ').filter((w) => w.length > 0 && !/^\d{1,2}$/.test(w)));
}

/** 0..1: how alike two file names are. */
export function nameSimilarity(a: string, b: string): number {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const wa = words(na);
  const wb = words(nb);
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  const jaccard = common / (wa.size + wb.size - common);
  // one name containing the other ("Rain" vs "Rain (2019 remaster)")
  const contains = na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na)) ? 0.75 : 0;
  return Math.max(jaccard, contains);
}

/** 0..100: how sure we are that `c` is the shared file `f`. */
export function matchScore(f: SharedFile, c: Candidate): number {
  const dur = c.duration && c.duration > 0 ? Math.abs(c.duration - f.duration) : null;
  const sameSize = !!f.size && !!c.size && f.size === c.size;
  const sim = nameSimilarity(f.name + (f.ext ?? ''), c.name);
  if (dur !== null && dur > 3) return 0; // a different length is a different recording
  if (sameSize && (dur === null || dur <= 1.5)) return 100;
  if (dur !== null && dur <= 1.5) {
    if (sim === 1) return 95;
    if (sim >= 0.5) return 75 + Math.round(sim * 15);
    if (dur <= 0.15 && sim > 0) return 60;
    if (dur <= 0.05) return 45; // renamed, but the very same length
    return 0;
  }
  // length unknown (a folder scan)
  if (sim === 1) return 65;
  if (sim >= 0.6) return 40 + Math.round(sim * 20);
  return 0;
}

export function confidenceOf(score: number): Confidence {
  return score >= 90 ? 'sure' : score >= 60 ? 'likely' : 'guess';
}

/** Best one-to-one matches; files with nothing good enough are left out. */
export function matchFiles(files: SharedFile[], candidates: Candidate[], minScore = 40): Map<string, Match> {
  const pairs: { f: number; c: number; score: number }[] = [];
  files.forEach((f, fi) =>
    candidates.forEach((c, ci) => {
      const score = matchScore(f, c);
      if (score >= minScore) pairs.push({ f: fi, c: ci, score });
    }),
  );
  // already-imported copies win ties (no copying needed)
  pairs.sort((a, b) => b.score - a.score || Number(!!candidates[b.c].libraryId) - Number(!!candidates[a.c].libraryId));
  const out = new Map<string, Match>();
  const usedC = new Set<number>();
  for (const p of pairs) {
    const f = files[p.f];
    if (out.has(f.id) || usedC.has(p.c)) continue;
    usedC.add(p.c);
    out.set(f.id, { candidate: candidates[p.c], score: p.score, confidence: confidenceOf(p.score) });
  }
  return out;
}

/**
 * Points the timeline's segments at linked files (old asset id → new) and
 * keeps the rest in `missingFiles`.
 */
export function applyLinks(tl: Timeline, links: Map<string, string>): void {
  for (const t of tl.soundtracks)
    for (const s of t.segments) if (s.assetId && links.has(s.assetId)) s.assetId = links.get(s.assetId);
  const left = (tl.missingFiles ?? []).filter((f) => !links.has(f.id));
  if (left.length) tl.missingFiles = left;
  else delete tl.missingFiles;
}

/** Files a timeline still needs, that this phone doesn't have. */
export function stillMissing(tl: Timeline, haveIds: Set<string>): SharedFile[] {
  return (tl.missingFiles ?? []).filter((f) => !haveIds.has(f.id));
}
