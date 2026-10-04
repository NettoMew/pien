import type { ITheme } from "@xterm/xterm";

/**
 * Grok Night (iterm2colorschemes.com): the terminal's palette, and the only
 * place a colour is spelled out. Everything else names one — the guest by
 * ANSI number, the page through the custom properties below.
 */
export const theme = {
  background: "#141414",
  foreground: "#e1e1e1",
  cursor: "#e0af68",
  cursorAccent: "#141414",
  selectionBackground: "#242424",
  black: "#0a0a0a",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#c8c8c8",
  brightBlack: "#6c6c6c",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#e1e1e1",
} as const satisfies ITheme;

/**
 * The palette as custom properties (--term-background, --term-bright-black …)
 * for every page's head, so the colours are there before any stylesheet is;
 * the stylesheets give them roles (src/index.css).
 */
export const themeCss = `:root{${Object.entries(theme)
  .map(([name, value]) => `--term-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`)
  .join(";")}}`;
