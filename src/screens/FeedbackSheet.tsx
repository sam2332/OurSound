import { CheckCircle2, Loader2, MessageSquareText, Send } from 'lucide-react';
import { useState } from 'react';
import { feedbackEnabled, sendFeedback } from '../feedback.ts';
import { Button, IconButton, Sheet } from '../ui/controls.tsx';

/** Write a note about a bug or idea; it's sent along with the timeline you're on. */
export function FeedbackSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [attach, setAttach] = useState(true);
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (state === 'sent') {
      setText('');
      setState('idle');
    }
    setError(null);
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title="Send feedback">
      {state === 'sent' ? (
        <>
          <p className="flex items-center gap-2 text-ok">
            <CheckCircle2 size={20} /> Sent. Thank you!
          </p>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      ) : (
        <>
          <textarea
            className="min-h-36 rounded-xl bg-card-2 p-3 outline-none focus:ring-1 focus:ring-accent"
            placeholder="What sounded wrong, what broke, or what you'd like…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={attach}
              onChange={(e) => setAttach(e.target.checked)}
              className="h-5 w-5 accent-[var(--color-accent)]"
            />
            <span>
              Include the timeline I'm on
              <span className="block text-xs text-muted">Its sounds and settings, so the problem can be heard exactly. No audio files are sent.</span>
            </span>
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <Button
            variant="primary"
            disabled={state === 'sending' || !text.trim()}
            onClick={async () => {
              setState('sending');
              setError(null);
              try {
                await sendFeedback(text, attach);
                setState('sent');
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                setState('idle');
              }
            }}
          >
            {state === 'sending' ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />} Send
          </Button>
        </>
      )}
    </Sheet>
  );
}

/** Header button that opens the feedback sheet (hidden when no feedback address is built in). */
export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  if (!feedbackEnabled) return null;
  return (
    <>
      <IconButton label="Send feedback" onClick={() => setOpen(true)}>
        <MessageSquareText size={18} />
      </IconButton>
      <FeedbackSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
