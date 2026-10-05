// The terminal, one per page like the machine behind it (session.ts). React
// only gives it a place on the screen: components/Terminal.tsx.

import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { theme } from "./theme.ts";

// Monaspace Neon for text; Nerd Font icons from their own font, fetched only
// when one appears (index.css); CJK from whatever the system has.
const FONT =
  '"Monaspace Neon", "Symbols Nerd Font Mono", "Noto Sans Mono CJK SC", "PingFang SC", "Microsoft YaHei UI", monospace';

/** Phones get a smaller face, from Tailwind's `sm` breakpoint down. */
const compact = matchMedia("(width < 40rem)");
const fontSize = () => (compact.matches ? 13 : 15);

/** Opens http(s) links — absolute, or relative to this page — in a new tab; anything else is ignored. */
export function openLink(url: string): void {
  try {
    const target = new URL(url, location.href);
    if (target.protocol === "https:" || target.protocol === "http:") window.open(target, "_blank", "noopener");
  } catch {
    // Not a URL at all: nothing to open.
  }
}

export const term = new Terminal({
  fontFamily: FONT,
  fontSize: fontSize(),
  fontWeightBold: "600",
  lineHeight: 1.3,
  cursorBlink: true,
  cursorStyle: "block",
  cursorInactiveStyle: "outline",
  scrollback: 5000,
  theme,
  allowProposedApi: true,
  macOptionIsMeta: true,
  linkHandler: { activate: (_, url) => openLink(url) }, // OSC 8 hyperlinks
});

const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = "11"; // CJK and emoji take two cells
term.loadAddon(new WebLinksAddon((_, url) => openLink(url)));
// Pictures in the text: the iTerm2 inline-image sequence, which md.awk prints
// for a post's or a moment's images. SIXEL is the guest's to choose too.
term.loadAddon(new ImageAddon({ pixelLimit: 4_000_000, storageLimit: 64 }));

/**
 * OSC 52: the guest may put text on the visitor's clipboard (Neovim's yanks,
 * say), and never read it, so whatever was copied elsewhere stays theirs.
 * Pasting is the browser's own: Ctrl+Shift+V, or a long press.
 */
const clipboard: IClipboardProvider = {
  readText: () => "",
  writeText: (selection, text) => {
    if (String(selection) === "c") return navigator.clipboard.writeText(text).catch(() => {});
  },
};
term.loadAddon(new ClipboardAddon(undefined, clipboard));

compact.addEventListener("change", () => {
  term.options.fontSize = fontSize();
  fit.fit();
});

/** xterm.js measures glyphs once, when it opens: the font has to be in first. */
export const fonts = Promise.all(["400", "600"].map((weight) => document.fonts.load(`${weight} 1em "Monaspace Neon"`)));

const { promise: opened, resolve: open } = Promise.withResolvers<void>();

/** Settles once the terminal is on screen and knows its size. */
export { opened };

/**
 * Puts the terminal into `host` and keeps it fitted there: a React ref
 * callback, cleanup included. The default DOM renderer: the browser lays out
 * the glyphs itself, so text stays crisp at any pixel ratio, CJK falls back to
 * system fonts cleanly, and every glyph is an element CSS can light.
 */
export function mount(host: HTMLElement | null) {
  if (!host) return;
  if (!term.element) term.open(host); // StrictMode mounts twice; a terminal opens once
  let frame = 0;
  const resize = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => fit.fit());
  });
  resize.observe(host);
  fit.fit();
  open();
  return () => {
    resize.disconnect();
    cancelAnimationFrame(frame);
  };
}
