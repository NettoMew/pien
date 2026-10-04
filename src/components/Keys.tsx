// Keys a phone keyboard lacks, then the commands a visitor reaches for first —
// on touch screens only, on a deck of their own below the glass. Acting on
// pointerdown, and cancelling it, keeps the terminal focused, so the
// on-screen keyboard stays up.

import {
  ArrowRightToLine,
  ArrowUp,
  BookOpen,
  CircleQuestionMark,
  Eraser,
  Folder,
  OctagonX,
  type LucideIcon,
} from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";
import { tv, type VariantProps } from "tailwind-variants/lite";
import { term } from "../terminal.ts";

const keycap = tv({
  slots: {
    key: "keycap flex h-14 touch-manipulation flex-col items-center justify-center gap-1.5 rounded-xl select-none active:translate-y-px",
    icon: "phosphor-stroke size-[18px]",
    caption: "phosphor text-[10px] text-faint",
  },
  variants: {
    tone: {
      control: { icon: "text-ink" },
      interrupt: { icon: "text-red" },
      command: { icon: "text-cyan" },
    },
  },
});

interface Shortcut extends Required<VariantProps<typeof keycap>> {
  caption: string;
  /** What a screen reader says, when the caption alone would not do. */
  name?: string;
  icon: LucideIcon;
  /** What it types. */
  input: string;
}

const CONTROLS: Shortcut[] = [
  { caption: "tab", name: "Tab", icon: ArrowRightToLine, tone: "control", input: "\t" },
  { caption: "prev", name: "Previous command", icon: ArrowUp, tone: "control", input: "\x1b[A" },
  { caption: "^C", name: "Interrupt", icon: OctagonX, tone: "interrupt", input: "\x03" },
];

const COMMANDS: Shortcut[] = [
  { caption: "help", icon: CircleQuestionMark, tone: "command", input: "help\r" },
  { caption: "blog", icon: BookOpen, tone: "command", input: "blog\r" },
  { caption: "ls", name: "ls -l blog", icon: Folder, tone: "command", input: "ls -l blog\r" },
  { caption: "clear", icon: Eraser, tone: "command", input: "clear\r" },
];

function Key({ caption, name, icon: Icon, tone, input }: Shortcut) {
  const styles = keycap({ tone });
  const type = () => {
    term.input(input);
    term.focus();
  };
  const press = (event: PointerEvent) => {
    event.preventDefault();
    type();
  };
  // A click with no pointer behind it: a keyboard, or a screen reader's double tap.
  const activate = (event: MouseEvent) => event.detail === 0 && type();

  return (
    <button type="button" aria-label={name} onPointerDown={press} onClick={activate} className={styles.key()}>
      <Icon aria-hidden strokeWidth={1.8} className={styles.icon()} />
      <span className={styles.caption()}>{caption}</span>
    </button>
  );
}

export function Keys() {
  return (
    <nav
      aria-label="Keys"
      className="hidden grid-cols-[repeat(3,minmax(0,1fr))_1px_repeat(4,minmax(0,1fr))] gap-1.5 px-3 pt-3 pb-[max(1.375rem,env(safe-area-inset-bottom))] pointer-coarse:grid"
    >
      {CONTROLS.map((shortcut) => (
        <Key key={shortcut.caption} {...shortcut} />
      ))}
      <span aria-hidden className="h-8 self-center bg-line" />
      {COMMANDS.map((shortcut) => (
        <Key key={shortcut.caption} {...shortcut} />
      ))}
    </nav>
  );
}
