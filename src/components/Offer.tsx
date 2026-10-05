// The key the screen offers when something the guest asked for needs the
// visitor's touch (gesture.ts): a tap, or Enter, and it goes on; Escape, or
// the cross, and the guest hears that it was cancelled. It rises from the
// bottom of the screen, a keycap like those on the phone's deck.

import { X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useOffer } from "../gesture.ts";
import { term } from "../terminal.ts";

export function Offer() {
  const offer = useOffer((state) => state.offer);
  const Icon = offer?.icon;

  return (
    <AnimatePresence onExitComplete={() => term.focus()}>
      {offer && Icon && (
        <m.div
          key={offer.label}
          role="alertdialog"
          aria-label={offer.label}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          onKeyDown={(event) => event.key === "Escape" && offer.decline()}
          className="absolute inset-x-0 bottom-[clamp(16px,4vh,40px)] z-30 flex flex-col items-center gap-2.5 px-4"
        >
          <div className="flex items-stretch gap-2">
            <button
              type="button"
              autoFocus
              onClick={offer.accept}
              className="keycap flex h-13 touch-manipulation items-center gap-3 rounded-xl px-5 outline-none select-none focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-cyan/70 active:translate-y-px"
            >
              <Icon aria-hidden strokeWidth={1.8} className="phosphor-stroke size-[18px] text-cyan" />
              <span className="phosphor text-sm text-ink">{offer.label}</span>
            </button>
            <button
              type="button"
              aria-label="Cancel"
              onClick={offer.decline}
              className="keycap grid w-13 touch-manipulation place-items-center rounded-xl outline-none select-none focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-faint active:translate-y-px"
            >
              <X aria-hidden strokeWidth={1.8} className="phosphor-stroke size-[18px] text-faint" />
            </button>
          </div>
          <p className="phosphor text-[11px] text-faint">
            <span className="pointer-coarse:hidden">Enter to go on · Esc to cancel</span>
            <span className="hidden pointer-coarse:inline">Tap to go on</span>
          </p>
        </m.div>
      )}
    </AnimatePresence>
  );
}
