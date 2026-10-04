import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/600.css";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { terminalTheme } from "./theme.ts";

// Monaspace Neon for text; Nerd Font icons from their own font, fetched only
// when one appears (style.css); CJK from whatever the system has.
const FONT = '"Monaspace Neon", "Symbols Nerd Font Mono", "Noto Sans Mono CJK SC", "PingFang SC", "Microsoft YaHei UI", monospace';

/** Opens http(s) links — absolute, or relative to this page — in a new tab; anything else is ignored. */
export function openLink(url: string): void {
  try {
    const target = new URL(url, location.href);
    if (target.protocol === "https:" || target.protocol === "http:") window.open(target, "_blank", "noopener");
  } catch {}
}

export async function createTerminal(host: HTMLElement) {
  const compact = matchMedia("(max-width: 640px)").matches;
  const fontSize = compact ? 13 : 15;
  // xterm.js measures glyphs once, up front: the font has to be there first.
  await Promise.all([`400 ${fontSize}px "Monaspace Neon"`, `600 ${fontSize}px "Monaspace Neon"`].map((f) => document.fonts.load(f)));

  const term = new Terminal({
    fontFamily: FONT,
    fontSize,
    fontWeightBold: "600",
    lineHeight: 1.3,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 2,
    cursorInactiveStyle: "outline",
    scrollback: 5000,
    theme: terminalTheme,
    allowProposedApi: true,
    macOptionIsMeta: true,
    linkHandler: { activate: (_, url) => openLink(url) }, // OSC 8 hyperlinks
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11"; // CJK and emoji take two cells
  term.loadAddon(new WebLinksAddon((_, url) => openLink(url)));
  // The default DOM renderer: the browser lays out the glyphs itself, so text
  // stays crisp at any pixel ratio and CJK falls back to system fonts cleanly.
  term.open(host);

  let frame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => fit.fit());
  }).observe(host);
  fit.fit();

  return term;
}
