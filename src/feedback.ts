// Feedback reports: a note from the user, posted to a webhook with the
// app's state attached so the issue can be reproduced. The webhook address
// comes from VITE_FEEDBACK_WEBHOOK in .env.local (kept out of git); any
// Discord-compatible webhook works.

import { Playback } from './native/playback.ts';
import { currentScreen, useLibrary } from './store/library.ts';
import { usePlayback } from './store/playback.ts';

declare const __BUILD__: string;

export const FEEDBACK_WEBHOOK: string = import.meta.env.VITE_FEEDBACK_WEBHOOK ?? '';
export const feedbackEnabled = /^https:\/\/[^/]+\/api\/webhooks\/./.test(FEEDBACK_WEBHOOK);

/** The timeline the report is most likely about: the one on screen, else the one playing. */
function relevantTimelineId(): string | null {
  const screen = currentScreen(useLibrary.getState());
  if ('id' in screen && typeof screen.id === 'string') return screen.id;
  return usePlayback.getState().activeId;
}

export async function sendFeedback(text: string, attachTimeline: boolean): Promise<void> {
  const lib = useLibrary.getState();
  const pb = usePlayback.getState();
  const screen = currentScreen(lib);
  const tlId = relevantTimelineId();
  const tl = tlId ? lib.timelines[tlId] : undefined;
  const fields = [
    { name: 'Screen', value: screen.name, inline: true },
    { name: 'Timeline', value: tl ? tl.name.slice(0, 200) : '—', inline: true },
    { name: 'Playing', value: pb.playing ? 'yes' : 'no', inline: true },
    { name: 'Build', value: __BUILD__, inline: true },
    { name: 'Device', value: navigator.userAgent.slice(0, 1000) },
  ];
  const payload = {
    username: 'OurSound feedback',
    embeds: [
      {
        title: 'Feedback',
        description: text.trim().slice(0, 4000) || '(no message)',
        color: 0x7c6cf0,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
  const attach = attachTimeline && tl;
  await Playback.postFeedback({
    url: FEEDBACK_WEBHOOK,
    payload: JSON.stringify(payload),
    fileName: attach ? 'timeline.json' : undefined,
    fileText: attach ? JSON.stringify(tl, null, 1) : undefined,
  });
}
