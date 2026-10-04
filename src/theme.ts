import type { ITheme } from "@xterm/xterm";

// One palette for the page, the terminal and the guest's own colours
// (image/rootfs/etc/fish/conf.d/home.fish mirrors it).
export const palette = {
  bg: "#0a0b0e",
  fg: "#e7e9ee",
  muted: "#7e8590",
  faint: "#5c636e",
  line: "#1f232b",
  cyan: "#4de8ff",
  amber: "#ffb547",
  red: "#ff6b6b",
};

export const terminalTheme: ITheme = {
  background: palette.bg,
  foreground: palette.fg,
  cursor: palette.cyan,
  cursorAccent: palette.bg,
  selectionBackground: "#4de8ff38",
  selectionInactiveBackground: "#4de8ff1c",
  scrollbarSliderBackground: "#ffffff12",
  scrollbarSliderHoverBackground: "#ffffff22",
  scrollbarSliderActiveBackground: "#ffffff30",

  black: "#1f232b",
  red: palette.red,
  green: "#7ce38b",
  yellow: palette.amber,
  blue: "#5b9cff",
  magenta: "#c792ea",
  cyan: palette.cyan,
  white: "#c9ced6",

  brightBlack: palette.faint,
  brightRed: "#ff8a8a",
  brightGreen: "#9bf0a8",
  brightYellow: "#ffc871",
  brightBlue: "#82b4ff",
  brightMagenta: "#d9b0f2",
  brightCyan: "#8af0ff",
  brightWhite: "#ffffff",
};

/** 24-bit SGR foreground for text the page itself writes into the terminal. */
export const ink = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m`;
};
