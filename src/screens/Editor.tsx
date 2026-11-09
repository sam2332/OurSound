// Timeline editor: a touch canvas.
//
//  - pinch to zoom (thousands of hours ↔ seconds), drag empty space to pan
//  - tap a segment to select it; drag it to move, drag its edges to resize
//  - repeats are drawn as ghosted copies
//  - tap a soundtrack's name to open its automation lanes: Volume for the
//    whole soundtrack, plus one lane per sound setting (intensity, beat, ...).
//    Tap a lane to add a point, drag points to shape the curve, long-press a
//    point to change its curve or delete it
//  - tap the ruler to move the playhead
// Every change goes through the store, so it is undoable and plays live.

import { ArrowLeft, Copy, Maximize2, Pause, Play, Redo2, SlidersHorizontal, Trash2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { compileCurve, curveValue } from '../engine/automation.ts';
import { GENERATORS } from '../engine/generators.ts';
import type { AutomationLane, AutomationPoint, CurveType, Segment, Soundtrack, Timeline } from '../engine/model.ts';
import { clampView, fitView, snap, tickLabel, tickStep, timeToX, visibleInstances, xToTime, zoomAround, type View } from '../editor/geometry.ts';
import { newId, newSeed, useLibrary } from '../store/library.ts';
import { activate, player, togglePlay, usePlayback } from '../store/playback.ts';
import { TRACK_COLORS } from '../templates.ts';
import { IconButton, Segmented, Sheet, fmtClock } from '../ui/controls.tsx';
import { SegmentEditor } from './Mixer.tsx';

const HEADER_W = 84;
const RULER_H = 30;
const TRACK_H = 54;
const AUTO_H = 92;
const EDGE_PX = 14;
const POINT_R = 7;
const MOVE_SLOP = 8;
const LONG_PRESS_MS = 550;

type Selection = { trackId: string; segId: string } | null;

/**
 * An automation lane: either the whole soundtrack's volume (track level, in
 * timeline time) or one sound setting of the soundtrack's segments (each
 * segment keeps its own curve, in segment time).
 */
type AutoLane = { kind: 'auto'; track: Soundtrack; param: string; trackLevel: boolean; y: number; h: number };
type Lane = { kind: 'track'; track: Soundtrack; index: number; y: number; h: number } | AutoLane;

type Range = { min: number; max: number; label: string; unit: string };

const TRACK_VOLUME: Range = { min: -30, max: 12, label: 'Volume', unit: 'dB' };
const TRACK_PAN: Range = { min: -1, max: 1, label: 'Pan', unit: 'R' };

/** Choices of a step setting (noise color, loop on/off…), or undefined for a smooth one. */
function stepOptions(track: Soundtrack, param: string): string[] | undefined {
  for (const seg of track.segments) {
    const d = GENERATORS[seg.generator]?.params.find((x) => x.name === param);
    if (d) return d.options;
  }
  return undefined;
}

/** Range of a segment setting. */
function paramRange(seg: Segment, param: string): Range {
  if (param === 'gain') return { min: -40, max: 12, label: 'Volume', unit: 'dB' };
  const d = GENERATORS[seg.generator]?.params.find((p) => p.name === param);
  return d ? { min: d.min, max: d.max, label: d.label, unit: d.unit } : { min: 0, max: 1, label: param, unit: '' };
}

function laneRange(lane: AutoLane): Range {
  if (lane.trackLevel) return lane.param === 'pan' ? TRACK_PAN : TRACK_VOLUME;
  const seg = lane.track.segments.find((s) => GENERATORS[s.generator]?.params.some((p) => p.name === lane.param));
  return seg ? paramRange(seg, lane.param) : { min: 0, max: 1, label: lane.param, unit: '' };
  // (step settings use their whole-number range: 0 … choices-1)
}

function laneFor(owner: { automation: AutomationLane[] }, param: string): AutomationLane | undefined {
  return owner.automation.find((l) => l.param === param);
}

/** Sound settings that can change over time, for every generator on a soundtrack (in order). */
function automatableParams(track: Soundtrack): string[] {
  const out: string[] = [];
  for (const seg of track.segments)
    for (const p of GENERATORS[seg.generator]?.params ?? [])
      if (!out.includes(p.name)) out.push(p.name);
  return out;
}

/** Segments on a lane: the ones whose generator has the lane's setting. */
function laneSegments(lane: AutoLane): Segment[] {
  return lane.track.segments.filter((s) => GENERATORS[s.generator]?.params.some((p) => p.name === lane.param));
}

/** Where a point lives: on the soundtrack (segId null) or on one segment. */
type PointRef = { trackId: string; segId: string | null; param: string; index: number };

type Drag =
  | { kind: 'pan'; x0: number; y0: number; view0: View; scroll0: number }
  | { kind: 'pinch'; d0: number; view0: View; anchorT: number }
  | { kind: 'move'; segId: string; trackId: string; x0: number; start0: number }
  | { kind: 'resize-l'; segId: string; trackId: string; x0: number; start0: number; len0: number }
  | { kind: 'resize-r'; segId: string; trackId: string; x0: number; len0: number }
  | ({ kind: 'point' } & PointRef)
  | { kind: 'seek'; x: number }
  | null;

export default function EditorScreen({
  id,
  focus,
}: {
  id: string;
  /** Open with this segment selected and its soundtrack's lanes showing. */
  focus?: { trackId: string; segId: string; param: string };
}) {
  const tl = useLibrary((s) => s.timelines[id]);
  const update = useLibrary((s) => s.updateTimeline);
  const back = useLibrary((s) => s.back);
  const { undo, redo, pastStates, futureStates } = useStore(useLibrary.temporal);
  const playing = usePlayback((s) => s.playing && s.activeId === id);
  const activeId = usePlayback((s) => s.activeId);
  const position = usePlayback((s) => (s.activeId === id ? s.status.positionSec : 0));

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ start: 0, pxPerSec: 0.01 });
  const [scrollY, setScrollY] = useState(0);
  const [sel, setSel] = useState<Selection>(focus ? { trackId: focus.trackId, segId: focus.segId } : null);
  // soundtracks whose automation lanes are open
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focus ? [focus.trackId] : []));
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pointMenu, setPointMenu] = useState<PointRef | null>(null);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);

  const laneW = Math.max(50, size.w - HEADER_W);
  const edit = useCallback((recipe: (d: Timeline) => void) => update(id, recipe), [id, update]);

  // --- size & initial fit
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const fitted = useRef(false);
  useEffect(() => {
    if (!tl || fitted.current || size.w === 0) return;
    fitted.current = true;
    const fseg = focus && tl.soundtracks.find((t) => t.id === focus.trackId)?.segments.find((s) => s.id === focus.segId);
    if (fseg) {
      // show the focused segment across most of the screen
      const span = Math.min(fseg.length, tl.duration);
      setView(clampView({ start: Math.max(0, fseg.start - span * 0.05), pxPerSec: laneW / (span * 1.1) }, tl.duration, laneW));
    } else {
      setView(fitView(tl.duration, laneW));
    }
  }, [tl, size.w, laneW, focus]);

  const selected = useMemo(() => {
    if (!tl || !sel) return null;
    const track = tl.soundtracks.find((t) => t.id === sel.trackId);
    const seg = track?.segments.find((s) => s.id === sel.segId);
    return track && seg ? { track, seg } : null;
  }, [tl, sel]);

  // --- lanes layout
  const lanes = useMemo<Lane[]>(() => {
    if (!tl) return [];
    const out: Lane[] = [];
    let y = RULER_H;
    tl.soundtracks.forEach((track, index) => {
      out.push({ kind: 'track', track, index, y, h: TRACK_H });
      y += TRACK_H;
      if (expanded.has(track.id)) {
        out.push({ kind: 'auto', track, param: 'gain', trackLevel: true, y, h: AUTO_H });
        y += AUTO_H;
        out.push({ kind: 'auto', track, param: 'pan', trackLevel: true, y, h: AUTO_H });
        y += AUTO_H;
        for (const param of automatableParams(track)) {
          out.push({ kind: 'auto', track, param, trackLevel: false, y, h: AUTO_H });
          y += AUTO_H;
        }
      }
    });
    return out;
  }, [tl, expanded]);
  const contentH = (lanes.length ? lanes[lanes.length - 1].y + lanes[lanes.length - 1].h : RULER_H) + 40;
  const maxScroll = Math.max(0, contentH - size.h);

  // --- drawing
  const colors = useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
    return {
      bg: v('--color-bg', '#0b0d1a'),
      card: v('--color-card', '#14172a'),
      card2: v('--color-card-2', '#1b1f36'),
      line: v('--color-line', '#262b45'),
      ink: v('--color-ink', '#e8eaf6'),
      muted: v('--color-muted', '#8d93b5'),
      accent: v('--color-accent', '#8fa8ff'),
      warn: v('--color-warn', '#f5c26b'),
    };
  }, []);

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !tl) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(size.w * dpr) || c.height !== Math.round(size.h * dpr)) {
      c.width = Math.round(size.w * dpr);
      c.height = Math.round(size.h * dpr);
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = colors.bg;
    g.fillRect(0, 0, size.w, size.h);
    const v = view;
    const t0 = v.start;
    const t1 = xToTime(v, size.w, HEADER_W);
    const step = tickStep(v.pxPerSec);

    // grid
    g.strokeStyle = colors.line;
    g.lineWidth = 1;
    const firstTick = Math.floor(t0 / step) * step;
    for (let t = firstTick; t <= t1; t += step) {
      const x = Math.round(timeToX(v, t, HEADER_W)) + 0.5;
      if (x < HEADER_W) continue;
      g.beginPath();
      g.moveTo(x, RULER_H);
      g.lineTo(x, size.h);
      g.stroke();
    }
    // end of timeline
    const endX = timeToX(v, tl.duration, HEADER_W);
    if (endX < size.w) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(Math.max(HEADER_W, endX), RULER_H, size.w - Math.max(HEADER_W, endX), size.h);
    }

    g.save();
    g.beginPath();
    g.rect(0, RULER_H, size.w, size.h - RULER_H);
    g.clip();
    g.translate(0, -scrollY);

    for (const lane of lanes) {
      if (lane.y + lane.h < scrollY + RULER_H || lane.y > scrollY + size.h) continue;
      const color = lane.track.color ?? TRACK_COLORS[0];
      if (lane.kind === 'track') {
        g.fillStyle = lane.index % 2 ? colors.card : colors.bg;
        g.fillRect(HEADER_W, lane.y, size.w - HEADER_W, lane.h);
        g.globalAlpha = lane.track.mute ? 0.35 : 1;
        for (const seg of lane.track.segments) {
          const isSel = sel?.segId === seg.id;
          for (const inst of visibleInstances(seg, t0, t1)) {
            const x0 = Math.max(HEADER_W - 4, timeToX(v, inst.start, HEADER_W));
            const x1 = Math.min(size.w + 4, timeToX(v, inst.start + seg.length, HEADER_W));
            const w = Math.max(2, x1 - x0);
            const first = inst.k === 0;
            g.fillStyle = color;
            g.globalAlpha = (lane.track.mute ? 0.35 : 1) * (first ? 0.85 : 0.35);
            roundRect(g, x0, lane.y + 6, w, lane.h - 12, 6);
            g.fill();
            if (isSel && first) {
              g.globalAlpha = 1;
              g.strokeStyle = colors.ink;
              g.lineWidth = 2;
              roundRect(g, x0, lane.y + 6, w, lane.h - 12, 6);
              g.stroke();
              // resize handles
              g.fillStyle = colors.ink;
              g.fillRect(x0 + 3, lane.y + lane.h / 2 - 9, 3, 18);
              g.fillRect(x0 + w - 6, lane.y + lane.h / 2 - 9, 3, 18);
            }
            // fades
            if (first && w > 30) {
              g.globalAlpha = 0.5;
              g.strokeStyle = colors.bg;
              g.lineWidth = 1.5;
              const fi = Math.min(seg.fadeIn, seg.length) * v.pxPerSec;
              const fo = Math.min(seg.fadeOut, seg.length) * v.pxPerSec;
              g.beginPath();
              g.moveTo(timeToX(v, inst.start, HEADER_W), lane.y + lane.h - 6);
              g.lineTo(timeToX(v, inst.start, HEADER_W) + fi, lane.y + 6);
              g.moveTo(timeToX(v, inst.start + seg.length, HEADER_W) - fo, lane.y + 6);
              g.lineTo(timeToX(v, inst.start + seg.length, HEADER_W), lane.y + lane.h - 6);
              g.stroke();
            }
            if (first && w > 60) {
              g.globalAlpha = 1;
              g.fillStyle = colors.bg;
              g.font = '600 12px system-ui, sans-serif';
              g.textBaseline = 'middle';
              const label = GENERATORS[seg.generator]?.label ?? seg.generator;
              g.fillText(label, Math.max(x0, HEADER_W) + 8, lane.y + lane.h / 2, w - 16);
            }
          }
        }
        g.globalAlpha = 1;
      } else {
        drawAutomation(g, lane, v, size.w, colors, t0, t1);
      }
    }

    // headers
    for (const lane of lanes) {
      if (lane.y + lane.h < scrollY + RULER_H || lane.y > scrollY + size.h) continue;
      g.fillStyle = colors.card2;
      g.fillRect(0, lane.y, HEADER_W, lane.h);
      g.fillStyle = lane.track.color ?? TRACK_COLORS[0];
      if (lane.kind === 'track') {
        g.fillRect(0, lane.y, 4, lane.h);
        g.fillStyle = lane.track.mute ? colors.muted : colors.ink;
        g.font = '600 12px system-ui, sans-serif';
        g.textBaseline = 'middle';
        wrapText(g, lane.track.name, 10, lane.y + lane.h / 2 - 6, HEADER_W - 14);
        // open/closed marker for the automation lanes
        g.fillStyle = expanded.has(lane.track.id) ? colors.accent : colors.muted;
        g.font = '10px system-ui, sans-serif';
        g.fillText(expanded.has(lane.track.id) ? '▾ lanes' : '▸ lanes', 10, lane.y + lane.h - 10, HEADER_W - 14);
      } else {
        const r = laneRange(lane);
        g.fillRect(0, lane.y, 2, lane.h);
        g.fillStyle = colors.ink;
        g.font = '600 11px system-ui, sans-serif';
        g.textBaseline = 'top';
        g.fillText(r.label, 10, lane.y + 6, HEADER_W - 14);
        g.fillStyle = colors.muted;
        g.font = '11px system-ui, sans-serif';
        g.fillText(`${fmtNum(r.max)} ${r.unit}`, 10, lane.y + 22, HEADER_W - 14);
        g.textBaseline = 'bottom';
        g.fillText(`${fmtNum(r.min)} ${r.unit}`, 10, lane.y + lane.h - 6, HEADER_W - 14);
      }
      g.strokeStyle = colors.line;
      g.beginPath();
      g.moveTo(0, lane.y + lane.h - 0.5);
      g.lineTo(size.w, lane.y + lane.h - 0.5);
      g.stroke();
    }
    g.restore();

    // ruler
    g.fillStyle = colors.card2;
    g.fillRect(0, 0, size.w, RULER_H);
    g.fillStyle = colors.muted;
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let t = firstTick; t <= t1; t += step) {
      const x = timeToX(v, t, HEADER_W);
      if (x < HEADER_W - 1) continue;
      g.fillText(tickLabel(t, step), x + 4, RULER_H / 2);
      g.fillRect(Math.round(x), RULER_H - 8, 1, 8);
    }
    g.fillStyle = colors.card2;
    g.fillRect(0, 0, HEADER_W, RULER_H);

    // playhead
    const ph = seekPreview ?? (activeId === id ? position : 0);
    const px = timeToX(v, ph, HEADER_W);
    if (px >= HEADER_W && px <= size.w) {
      g.fillStyle = colors.warn;
      g.fillRect(Math.round(px) - 1, 0, 2, size.h);
      g.beginPath();
      g.moveTo(px - 6, 0);
      g.lineTo(px + 6, 0);
      g.lineTo(px, 9);
      g.fill();
    }
  }, [tl, size, view, scrollY, lanes, sel, colors, expanded, position, activeId, id, seekPreview]);

  useEffect(() => {
    const raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  // --- hit testing
  const hit = useCallback(
    (x: number, yScreen: number) => {
      if (yScreen < RULER_H) return { area: 'ruler' as const };
      const y = yScreen + scrollY;
      const lane = lanes.find((l) => y >= l.y && y < l.y + l.h);
      if (!lane) return { area: 'empty' as const };
      if (x < HEADER_W) return { area: 'header' as const, lane };
      const t = xToTime(view, x, HEADER_W);
      if (lane.kind === 'auto') {
        const r = laneRange(lane);
        const owners: { segId: string | null; base: number; al: AutomationLane | undefined }[] = lane.trackLevel
          ? [{ segId: null, base: 0, al: laneFor(lane.track, lane.param) }]
          : laneSegments(lane).map((sg) => ({ segId: sg.id, base: sg.start, al: laneFor(sg, lane.param) }));
        for (const o of owners) {
          if (!o.al) continue;
          for (let i = 0; i < o.al.points.length; i++) {
            const pt = o.al.points[i];
            const px = timeToX(view, o.base + pt.t, HEADER_W);
            const py = valueToY(pt.v, r, lane);
            if (Math.hypot(px - x, py - y) <= POINT_R + 10)
              return { area: 'point' as const, lane, ref: { trackId: lane.track.id, segId: o.segId, param: lane.param, index: i } };
          }
        }
        return { area: 'auto' as const, lane, t };
      }
      // segments: selected one first, so its handles win
      const segs = [...lane.track.segments].sort((a, b) => (a.id === sel?.segId ? -1 : b.id === sel?.segId ? 1 : 0));
      for (const seg of segs) {
        const x0 = timeToX(view, seg.start, HEADER_W);
        const x1 = timeToX(view, seg.start + seg.length, HEADER_W);
        const isSel = seg.id === sel?.segId;
        if (isSel && Math.abs(x - x0) <= EDGE_PX && x1 - x0 > EDGE_PX) return { area: 'edge-l' as const, lane, seg };
        if (isSel && Math.abs(x - x1) <= EDGE_PX) return { area: 'edge-r' as const, lane, seg };
        if (x >= x0 && x <= x1) return { area: 'segment' as const, lane, seg };
        // repeats select their segment
        for (const inst of visibleInstances(seg, t - 1, t + 1, 8)) {
          if (t >= inst.start && t <= inst.start + seg.length) return { area: 'repeat' as const, lane, seg };
        }
      }
      return { area: 'lane' as const, lane, t };
    },
    [lanes, scrollY, view, sel],
  );

  /** The automation lane a point belongs to, inside a timeline draft. */
  const pointLane = (d: Timeline, ref: { trackId: string; segId: string | null; param: string }) => {
    const tr = d.soundtracks.find((t) => t.id === ref.trackId);
    if (!tr) return undefined;
    if (ref.segId === null) return laneFor(tr, ref.param);
    return laneFor(tr.segments.find((x) => x.id === ref.segId) ?? { automation: [] }, ref.param);
  };

  // --- gestures
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<Drag>(null);
  const down = useRef<{ x: number; y: number; time: number; moved: boolean; hit: ReturnType<typeof hit> } | null>(null);
  const longTimer = useRef<number | null>(null);

  const local = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const setViewClamped = useCallback(
    (v: View) => setView(clampView(v, tl?.duration ?? 1, laneW)),
    [tl?.duration, laneW],
  );

  const editSeg = useCallback(
    (trackId: string, segId: string, recipe: (s: Segment) => void) =>
      edit((d) => {
        const s = d.soundtracks.find((t) => t.id === trackId)?.segments.find((x) => x.id === segId);
        if (s) recipe(s);
      }),
    [edit],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // pointer already gone (or synthetic): capture is only a nicety
    }
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      cancelLong();
      const [a, b] = [...pointers.current.values()];
      const midX = (a.x + b.x) / 2;
      drag.current = { kind: 'pinch', d0: Math.abs(a.x - b.x) || 1, view0: view, anchorT: xToTime(view, midX, HEADER_W) };
      down.current = null;
      return;
    }
    const h = hit(p.x, p.y);
    down.current = { x: p.x, y: p.y, time: Date.now(), moved: false, hit: h };
    drag.current = null;
    if (h.area === 'ruler') {
      drag.current = { kind: 'seek', x: p.x };
      setSeekPreview(Math.max(0, Math.min(tl!.duration, xToTime(view, p.x, HEADER_W))));
      return;
    }
    if (h.area === 'point') {
      drag.current = { kind: 'point', ...h.ref };
      longTimer.current = window.setTimeout(() => {
        if (down.current && !down.current.moved) {
          setPointMenu(h.ref);
          drag.current = null;
          down.current = null;
        }
      }, LONG_PRESS_MS);
      return;
    }
    if (h.area === 'edge-l') {
      drag.current = { kind: 'resize-l', segId: h.seg.id, trackId: h.lane.track.id, x0: p.x, start0: h.seg.start, len0: h.seg.length };
      return;
    }
    if (h.area === 'edge-r') {
      drag.current = { kind: 'resize-r', segId: h.seg.id, trackId: h.lane.track.id, x0: p.x, len0: h.seg.length };
      return;
    }
    if (h.area === 'segment' && h.seg.id === sel?.segId) {
      drag.current = { kind: 'move', segId: h.seg.id, trackId: h.lane.track.id, x0: p.x, start0: h.seg.start };
      longTimer.current = window.setTimeout(() => {
        if (down.current && !down.current.moved) {
          setDetailsOpen(true);
          drag.current = null;
          down.current = null;
        }
      }, LONG_PRESS_MS);
      return;
    }
    if (h.area === 'lane') {
      longTimer.current = window.setTimeout(() => {
        if (down.current && !down.current.moved) {
          addSegmentAt(h.lane.track, h.t);
          down.current = null;
          drag.current = null;
        }
      }, LONG_PRESS_MS);
    }
    drag.current = { kind: 'pan', x0: p.x, y0: p.y, view0: view, scroll0: scrollY };
  };

  const cancelLong = () => {
    if (longTimer.current !== null) window.clearTimeout(longTimer.current);
    longTimer.current = null;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const d = drag.current;
    if (!d || !tl) return;
    if (down.current && !down.current.moved && Math.hypot(p.x - down.current.x, p.y - down.current.y) > MOVE_SLOP) {
      down.current.moved = true;
      cancelLong();
    }
    if (down.current && !down.current.moved && d.kind !== 'pinch') return;

    switch (d.kind) {
      case 'pinch': {
        if (pointers.current.size < 2) return;
        const [a, b] = [...pointers.current.values()];
        const dist = Math.abs(a.x - b.x) || 1;
        setViewClamped(zoomAround(d.view0, dist / d.d0, d.anchorT));
        return;
      }
      case 'pan': {
        const dt = (p.x - d.x0) / d.view0.pxPerSec;
        setViewClamped({ ...d.view0, start: d.view0.start - dt });
        setScrollY(Math.max(0, Math.min(maxScroll, d.scroll0 - (p.y - d.y0))));
        return;
      }
      case 'seek': {
        setSeekPreview(Math.max(0, Math.min(tl.duration, xToTime(view, p.x, HEADER_W))));
        return;
      }
      case 'move': {
        const t = snap(d.start0 + (p.x - d.x0) / view.pxPerSec, view.pxPerSec);
        editSeg(d.trackId, d.segId, (s) => void (s.start = Math.max(0, Math.min(tl.duration - 1, t))));
        return;
      }
      case 'resize-l': {
        const end = d.start0 + d.len0;
        const t = Math.max(0, Math.min(end - 1, snap(d.start0 + (p.x - d.x0) / view.pxPerSec, view.pxPerSec)));
        editSeg(d.trackId, d.segId, (s) => {
          s.start = t;
          s.length = end - t;
        });
        return;
      }
      case 'resize-r': {
        const len = Math.max(1, snap(d.len0 + (p.x - d.x0) / view.pxPerSec, view.pxPerSec));
        editSeg(d.trackId, d.segId, (s) => void (s.length = len));
        return;
      }
      case 'point': {
        const lane = lanes.find(
          (l): l is AutoLane => l.kind === 'auto' && l.track.id === d.trackId && l.param === d.param && l.trackLevel === (d.segId === null),
        );
        if (!lane) return;
        const base = d.segId === null ? 0 : (lane.track.segments.find((x) => x.id === d.segId)?.start ?? 0);
        const t = Math.max(0, xToTime(view, p.x, HEADER_W) - base);
        const raw = yToValue(p.y + scrollY, laneRange(lane), lane);
        const v = !lane.trackLevel && stepOptions(lane.track, lane.param) ? Math.round(raw) : raw;
        edit((dr) => {
          const al = pointLane(dr, d);
          if (!al || !al.points[d.index]) return;
          al.points[d.index].t = t;
          al.points[d.index].v = v;
        });
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    cancelLong();
    const d = drag.current;
    const dn = down.current;
    if (d?.kind === 'pinch') {
      if (pointers.current.size === 0) drag.current = null;
      return;
    }
    if (d?.kind === 'seek') {
      if (seekPreview !== null) {
        const target = seekPreview;
        if (activeId !== id) void activate(id).then(() => player.seek(target));
        else player.seek(target);
      }
      setSeekPreview(null);
    }
    if (d?.kind === 'point') {
      // keep points ordered after a drag
      edit((dr) => {
        pointLane(dr, d)?.points.sort((a, b) => a.t - b.t);
      });
    }
    if (dn && !dn.moved && Date.now() - dn.time < LONG_PRESS_MS) onTap(dn.hit);
    drag.current = null;
    down.current = null;
  };

  const onTap = (h: ReturnType<typeof hit>) => {
    switch (h.area) {
      case 'segment':
      case 'repeat':
        setSel({ trackId: h.lane.track.id, segId: h.seg.id });
        return;
      case 'auto': {
        // add a point at the tapped spot
        const lane = h.lane;
        const r = laneRange(lane);
        const down0 = down.current;
        const v = down0 ? yToValue(down0.y + scrollY, r, lane) : (r.min + r.max) / 2;
        if (lane.trackLevel) {
          const t = Math.max(0, snap(h.t, view.pxPerSec));
          edit((d) => {
            const tr = d.soundtracks.find((x) => x.id === lane.track.id);
            if (!tr) return;
            let al = laneFor(tr, lane.param);
            if (!al) {
              // start from the current steady value so nothing jumps
              al = { param: lane.param, points: [{ t: 0, v: lane.param === 'pan' ? tr.pan : 0, curve: 'smooth' }] };
              tr.automation.push(al);
            }
            al.points.push({ t, v, curve: 'smooth' });
            al.points.sort((a, b) => a.t - b.t);
          });
          return;
        }
        // a setting: the point goes on the segment under the finger
        const seg = laneSegments(lane).find((sg) => h.t >= sg.start && h.t <= sg.start + sg.length);
        if (!seg) return;
        const t = Math.max(0, Math.min(seg.length, snap(h.t - seg.start, view.pxPerSec)));
        const steps = stepOptions(lane.track, lane.param);
        const curve = steps ? 'hold' : 'smooth';
        const value = steps ? Math.round(v) : v;
        editSeg(lane.track.id, seg.id, (sg) => {
          let al = laneFor(sg, lane.param);
          if (!al) {
            // start from the current steady value so nothing jumps
            const base = sg.params[lane.param] ?? r.min;
            al = { param: lane.param, points: [{ t: 0, v: base, curve }] };
            sg.automation.push(al);
          }
          al.points.push({ t, v: value, curve });
          al.points.sort((a, b) => a.t - b.t);
        });
        setSel({ trackId: lane.track.id, segId: seg.id });
        return;
      }
      case 'header':
        if (h.lane.kind === 'track') {
          // open / close this soundtrack's automation lanes
          const tid = h.lane.track.id;
          setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(tid)) next.delete(tid);
            else next.add(tid);
            return next;
          });
        }
        return;
      case 'lane':
        setSel(null);
        return;
    }
  };

  const addSegmentAt = (track: Soundtrack, t: number) => {
    if (!tl) return;
    const tmpl = track.segments[0];
    const len = Math.max(60, snap((laneW / view.pxPerSec) * 0.2, view.pxPerSec));
    const start = Math.max(0, Math.min(tl.duration - len, snap(t, view.pxPerSec)));
    const segId = newId();
    edit((d) => {
      const tr = d.soundtracks.find((x) => x.id === track.id);
      if (!tr) return;
      const base: Segment = tmpl
        ? { ...structuredClone(tmpl), automation: [], repeat: { mode: 'none' } }
        : { id: '', start: 0, length: len, fadeIn: 5, fadeOut: 10, gainDb: -12, generator: 'noise', params: { color: 1, width: 1 }, seed: 1, repeat: { mode: 'none' }, automation: [] };
      tr.segments.push({ ...base, id: segId, seed: newSeed(), start, length: len });
    });
    setSel({ trackId: track.id, segId });
  };

  // mouse wheel / trackpad zoom when testing on a computer
  const onWheel = (e: React.WheelEvent) => {
    const p = { x: e.nativeEvent.offsetX };
    if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      setViewClamped(zoomAround(view, Math.exp(-e.deltaY * 0.002), xToTime(view, p.x, HEADER_W)));
    } else {
      setViewClamped({ ...view, start: view.start + e.deltaX / view.pxPerSec });
    }
  };

  if (!tl) return null;
  const menuPoint = pointMenu ? pointLane(tl, pointMenu)?.points[pointMenu.index] : undefined;

  return (
    <div className="fixed inset-0 flex flex-col bg-bg pt-safe">
      <header className="flex items-center gap-2 px-3 pb-2">
        <IconButton label="Back" onClick={back}>
          <ArrowLeft size={20} />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{tl.name}</div>
          <div className="text-xs tabular-nums text-muted">
            {fmtClock(activeId === id ? position : 0)} / {fmtClock(tl.duration)}
          </div>
        </div>
        <IconButton label="Undo" onClick={() => undo()} disabled={pastStates.length === 0}>
          <Undo2 size={18} />
        </IconButton>
        <IconButton label="Redo" onClick={() => redo()} disabled={futureStates.length === 0}>
          <Redo2 size={18} />
        </IconButton>
        <IconButton label="Fit whole timeline" onClick={() => setView(fitView(tl.duration, laneW))}>
          <Maximize2 size={18} />
        </IconButton>
        <IconButton label={playing ? 'Pause' : 'Play'} active onClick={() => void togglePlay(id)}>
          {playing ? <Pause size={20} /> : <Play size={20} className="ml-0.5" />}
        </IconButton>
      </header>

      <div ref={wrapRef} className="relative min-h-0 flex-1 touch-none">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          aria-label="Timeline. Pinch to zoom, drag to scroll, tap a segment to select it."
        />
      </div>

      <footer className="pb-safe border-t border-line bg-card px-3 pt-2">
        {selected ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full" style={{ background: selected.track.color }} />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                {selected.track.name} · {GENERATORS[selected.seg.generator]?.label}
              </span>
              <IconButton label="Segment details" onClick={() => setDetailsOpen(true)} className="h-9 w-9">
                <SlidersHorizontal size={16} />
              </IconButton>
              <IconButton
                label="Duplicate segment"
                className="h-9 w-9"
                onClick={() => {
                  const segId = newId();
                  edit((d) => {
                    const tr = d.soundtracks.find((t) => t.id === selected.track.id);
                    const s = tr?.segments.find((x) => x.id === selected.seg.id);
                    if (!tr || !s) return;
                    tr.segments.push({ ...structuredClone(s), id: segId, seed: newSeed(), start: Math.min(tl.duration - 1, s.start + s.length) });
                  });
                  setSel({ trackId: selected.track.id, segId });
                }}
              >
                <Copy size={16} />
              </IconButton>
              <IconButton
                label="Delete segment"
                className="h-9 w-9 text-danger"
                onClick={() => {
                  edit((d) => {
                    const tr = d.soundtracks.find((t) => t.id === selected.track.id);
                    if (tr) tr.segments = tr.segments.filter((x) => x.id !== selected.seg.id);
                  });
                  setSel(null);
                }}
              >
                <Trash2 size={16} />
              </IconButton>
            </div>
            <p className="text-xs text-muted">
              Drag to move · drag edges to resize · tap the soundtrack's name for its automation lanes
            </p>
          </div>
        ) : (
          <p className="py-2 text-sm text-muted">
            Tap a soundtrack's name to show its automation lanes (volume, intensity…) · tap a lane to add a point, drag
            to shape, long-press to edit · tap a segment to select · pinch to zoom · tap the ruler to move the playhead
          </p>
        )}
      </footer>

      <Sheet open={detailsOpen && !!selected} onClose={() => setDetailsOpen(false)} title="Segment">
        {selected && (
          <SegmentEditor
            seg={selected.seg}
            index={selected.track.segments.indexOf(selected.seg)}
            count={1}
            duration={tl.duration}
            color={selected.track.color ?? TRACK_COLORS[0]}
            editSeg={(recipe) => editSeg(selected.track.id, selected.seg.id, recipe)}
            remove={() => {}}
            onEditOverTime={() => {
              setExpanded((prev) => new Set(prev).add(selected.track.id));
              setDetailsOpen(false);
            }}
          />
        )}
      </Sheet>

      <Sheet open={!!pointMenu && !!menuPoint} onClose={() => setPointMenu(null)} title="Automation point">
        {pointMenu && menuPoint && (
          <>
            <p className="text-sm text-muted">
              At {fmtClock(menuPoint.t)} {pointMenu.segId === null ? 'into the timeline' : 'into the segment'} · {fmtNum(menuPoint.v)}
            </p>
            <span className="text-sm text-muted">Curve to the next point</span>
            <Segmented<CurveType>
              value={menuPoint.curve ?? 'linear'}
              onChange={(c) =>
                edit((dr) => {
                  const pt = pointLane(dr, pointMenu)?.points[pointMenu.index];
                  if (pt) pt.curve = c;
                })
              }
              options={[
                { value: 'smooth', label: 'Smooth' },
                { value: 'linear', label: 'Straight' },
                { value: 'exp', label: 'Curved' },
                { value: 'hold', label: 'Step' },
              ]}
            />
            <button
              type="button"
              className="mt-2 flex items-center justify-center gap-2 rounded-xl bg-danger/15 py-3 text-danger"
              onClick={() => {
                edit((dr) => {
                  const tr = dr.soundtracks.find((t) => t.id === pointMenu.trackId);
                  const owner = pointMenu.segId === null ? tr : tr?.segments.find((x) => x.id === pointMenu.segId);
                  const al = owner ? laneFor(owner, pointMenu.param) : undefined;
                  if (!owner || !al) return;
                  al.points.splice(pointMenu.index, 1);
                  if (al.points.length === 0) owner.automation = owner.automation.filter((l) => l !== al);
                });
                setPointMenu(null);
              }}
            >
              <Trash2 size={16} /> Delete point
            </button>
          </>
        )}
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------- drawing helpers

function valueToY(v: number, r: { min: number; max: number }, lane: { y: number; h: number }) {
  const pad = 12;
  const u = (v - r.min) / (r.max - r.min || 1);
  return lane.y + lane.h - pad - Math.max(0, Math.min(1, u)) * (lane.h - 2 * pad);
}

function yToValue(y: number, r: { min: number; max: number }, lane: { y: number; h: number }) {
  const pad = 12;
  const u = (lane.y + lane.h - pad - y) / (lane.h - 2 * pad);
  const v = r.min + Math.max(0, Math.min(1, u)) * (r.max - r.min);
  const step = (r.max - r.min) / 200;
  return Math.round(v / step) * step;
}

function fmtNum(v: number) {
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

function wrapText(g: CanvasRenderingContext2D, text: string, x: number, yMid: number, maxW: number) {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, 2);
  const lh = 14;
  shown.forEach((l, i) => g.fillText(l, x, yMid + (i - (shown.length - 1) / 2) * lh, maxW));
}

function drawAutomation(
  g: CanvasRenderingContext2D,
  lane: AutoLane,
  v: View,
  width: number,
  colors: Record<string, string>,
  t0: number,
  t1: number,
) {
  g.fillStyle = colors.card;
  g.fillRect(HEADER_W, lane.y, width - HEADER_W, lane.h);
  const r = laneRange(lane);
  const color = lane.track.color ?? colors.accent;
  g.lineWidth = 2;

  /** One curve (or a dashed steady line) over [from, to], with points offset by `base`. */
  const drawCurve = (al: AutomationLane | undefined, steady: number, base: number, from: number, to: number) => {
    const x0 = Math.max(HEADER_W, timeToX(v, from, HEADER_W));
    const x1 = Math.min(width, timeToX(v, to, HEADER_W));
    if (x1 <= x0) return;
    g.strokeStyle = color;
    g.beginPath();
    if (!al || al.points.length === 0) {
      const y = valueToY(steady, r, lane);
      g.setLineDash([5, 5]);
      g.moveTo(x0, y);
      g.lineTo(x1, y);
      g.stroke();
      g.setLineDash([]);
      return;
    }
    const compiled = compileCurve(al.points as AutomationPoint[])!;
    const a = Math.max(t0, from);
    const b = Math.min(t1, to);
    const steps = Math.max(2, Math.ceil(((b - a) * v.pxPerSec) / 2));
    for (let i = 0; i <= steps; i++) {
      const t = a + ((b - a) * i) / steps;
      const y = valueToY(curveValue(compiled, t - base), r, lane);
      const x = timeToX(v, t, HEADER_W);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    for (const pt of al.points) {
      const x = timeToX(v, base + pt.t, HEADER_W);
      if (x < HEADER_W - POINT_R || x > width + POINT_R) continue;
      const y = valueToY(pt.v, r, lane);
      g.fillStyle = colors.bg;
      g.beginPath();
      g.arc(x, y, POINT_R, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = color;
      g.lineWidth = 2.5;
      g.stroke();
      g.lineWidth = 2;
    }
  };

  if (lane.trackLevel) {
    const steady = lane.param === 'pan' ? lane.track.pan : 0;
    drawCurve(laneFor(lane.track, lane.param), steady, 0, 0, Number.MAX_VALUE);
    if (!laneFor(lane.track, lane.param))
      hintText(g, colors, lane, lane.param === 'pan' ? 'Tap to move the sound left ↔ right over time' : 'Tap to shape the volume over time');
    return;
  }
  const steps = stepOptions(lane.track, lane.param);
  if (steps) {
    // label each step level on the left of the lane
    g.fillStyle = colors.muted;
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    steps.forEach((name, i) => g.fillText(name, HEADER_W + 4, valueToY(i, r, lane)));
  }
  const segs = laneSegments(lane);
  for (const seg of segs) {
    // the segment's span
    const sx0 = Math.max(HEADER_W, timeToX(v, seg.start, HEADER_W));
    const sx1 = Math.min(width, timeToX(v, seg.start + seg.length, HEADER_W));
    if (sx1 > sx0) {
      g.fillStyle = colors.card2;
      g.fillRect(sx0, lane.y + 4, sx1 - sx0, lane.h - 8);
    }
    drawCurve(laneFor(seg, lane.param), seg.params[lane.param] ?? r.min, seg.start, seg.start, seg.start + seg.length);
  }
  if (!segs.some((sg) => laneFor(sg, lane.param))) hintText(g, colors, lane, `Tap to change ${r.label.toLowerCase()} over time`);
}

function hintText(g: CanvasRenderingContext2D, colors: Record<string, string>, lane: AutoLane, text: string) {
  g.fillStyle = colors.muted;
  g.font = '11px system-ui, sans-serif';
  g.textBaseline = 'top';
  g.fillText(text, HEADER_W + 8, lane.y + 6);
}
