// Share cards: the picture a link to the site shows where it is shared
// (og:image), 1200×630, set the way the terminal sets text. A grid of cells
// in Monaspace Neon, CJK two cells wide in Noto Sans SC — the face the
// terminal falls back to for it — each glyph lit a little, on the tube's
// dark glass: the prompt that would have printed the page, then its title.
//
// The glyphs come straight out of the font files (fontkit) as outlines, so a
// card comes out the same wherever it is drawn: the site's build, or press
// when the writing changes, on Windows or in Alpine. sharp makes the PNG.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as fontkit from "fontkit";
import sharp from "sharp";
import image from "../../image/image.config.ts";
import { theme } from "../../src/theme.ts";

export interface Card {
  /** Where the prompt stands, and what it typed: none, and the cursor waits. */
  cwd: string;
  command: string;
  title: string;
  /** A line beneath, quieter: a date, tags. */
  meta?: string;
}

const WIDTH = 1200;
const HEIGHT = 630;
const PAD = 80;
/** One cell of Monaspace Neon, in ems: every glyph in it is this wide. */
const CELL = 0.62;
const TITLE_LINES = 3;
const HANG = "，。、；：！？」』）】》…,.;:!?)";

const require = createRequire(import.meta.url);
const files = (name: string) => join(dirname(require.resolve(`${name}/package.json`)), "files");
const MONASPACE = files("@fontsource/monaspace-neon");
const NOTO = files("@fontsource-variable/noto-sans-sc");
// Google's own WOFF2 decoder, in WebAssembly: fontkit reads a variable font's
// weights from a TrueType file, not from a WOFF2 one.
const woff2 = require("wawoff2") as { decompress(data: Uint8Array): Promise<Uint8Array> };

type Weight = 400 | 600;

const opened = new Map<string, Promise<fontkit.Font>>();
const once = (key: string, open: () => Promise<fontkit.Font>) => {
  if (!opened.has(key)) opened.set(key, open());
  return opened.get(key)!;
};

const monaspace = (weight: Weight) =>
  once(`monaspace ${weight}`, async () =>
    fontkit.create(await readFile(join(MONASPACE, `monaspace-neon-latin-${weight}-normal.woff2`))) as fontkit.Font,
  );

/** Noto Sans SC at `weight`, from the one of its hundred files that holds `cp`; none holds it, none. */
async function noto(cp: number, weight: Weight): Promise<fontkit.Font | undefined> {
  const file = (await subsets()).find(([from, to]) => cp >= from && cp <= to)?.[2];
  if (!file) return undefined;
  const variable = await once(file, async () => fontkit.create(Buffer.from(await woff2.decompress(await readFile(join(NOTO, file))))) as fontkit.Font);
  return once(`${file} ${weight}`, async () => variable.getVariation({ wght: weight }));
}

/** Which of Noto Sans SC's files holds which characters, from its unicode.json. */
const subsets = (() => {
  let read: Promise<[number, number, string][]> | undefined;
  return () =>
    (read ??= readFile(join(NOTO, "../unicode.json"), "utf8").then((json) =>
      Object.entries(JSON.parse(json) as Record<string, string>).flatMap(([subset, list]) =>
        list.split(",").map((range) => {
          const [from, to = from] = range.replace("U+", "").split("-").map((hex) => Number.parseInt(hex, 16));
          return [from!, to!, `noto-sans-sc-${subset.replace(/[[\]]/g, "")}-wght-normal.woff2`] as [number, number, string];
        }),
      ),
    ));
})();

/** The face that draws `cp` at `weight`: Monaspace Neon if it can, else Noto Sans SC. */
async function faceFor(cp: number, weight: Weight): Promise<fontkit.Font | undefined> {
  const mono = await monaspace(weight);
  if (mono.hasGlyphForCodePoint(cp)) return mono;
  const cjk = await noto(cp, weight);
  return cjk?.hasGlyphForCodePoint(cp) ? cjk : undefined;
}

/** Cells a character takes, by md.awk's rule: two for the wide East Asian ones. */
const cells = (ch: string) => {
  const cp = ch.codePointAt(0)!;
  return (cp >= 0x2e80 && cp <= 0xdfff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || cp >= 0x10000 ? 2 : 1;
};

const columns = (text: string) => [...text].reduce((sum, ch) => sum + cells(ch), 0);

/** A run of text in one colour and weight. */
interface Run {
  text: string;
  color: string;
  weight?: Weight;
}

/** `runs` from the first cell of a line `size` px tall, its baseline at `y`, as SVG; and the cell after them. */
async function line(runs: Run[], size: number, y: number): Promise<[string, number]> {
  const cell = CELL * size;
  let out = "";
  let col = 0;
  for (const { text, color, weight = 400 } of runs) {
    const paths: string[] = [];
    for (const ch of text) {
      const face = ch === " " ? undefined : await faceFor(ch.codePointAt(0)!, weight);
      const glyph = face?.glyphForCodePoint(ch.codePointAt(0)!);
      const d = glyph?.path.toSVG();
      if (face && glyph && d) {
        const scale = size / face.unitsPerEm;
        // Centred in its cells, as the terminal draws a glyph of another face.
        const x = PAD + col * cell + (cells(ch) * cell - glyph.advanceWidth * scale) / 2;
        paths.push(`<path transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(5)} ${(-scale).toFixed(5)})" d="${d}"/>`);
      }
      col += cells(ch);
    }
    if (paths.length) out += `<g fill="${color}">${paths.join("")}</g>`;
  }
  return [out, col];
}

/**
 * `text` in lines of at most `width` cells, as md.awk wraps: at spaces, and
 * between wide characters, closing punctuation hanging past the edge rather
 * than starting a line. A word wider than a line breaks where it runs out.
 */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  let space = false;
  const place = (unit: string) => {
    if (!unit) return;
    const room = columns(current) + (space && current ? 1 : 0) + columns(unit) <= width;
    const hangs = HANG.includes(unit) && columns(current) + columns(unit) <= width + 2;
    if (current && !room && !hangs) {
      lines.push(current);
      current = "";
    }
    current += (space && current ? " " : "") + unit;
    space = false;
  };
  let word = "";
  for (const ch of text) {
    if (/\s/.test(ch)) {
      place(word);
      word = "";
      space = true;
    } else if (cells(ch) === 2) {
      place(word);
      word = "";
      place(ch);
    } else {
      word += ch;
      if (columns(word) >= width) {
        place(word);
        word = "";
      }
    }
  }
  place(word);
  if (current) lines.push(current);
  return lines;
}

/** At most `count` lines, the last cut short with an ellipsis if more was left. */
function fit(lines: string[], count: number, width: number): string[] {
  if (lines.length <= count) return lines;
  let last = [...lines[count - 1]!];
  while (last.length && columns(`${last.join("")}…`) > width) last = last.slice(0, -1);
  return [...lines.slice(0, count - 1), `${last.join("").trimEnd()}…`];
}

/** The card, as SVG. */
async function svg({ cwd, command, title, meta }: Card): Promise<string> {
  const promptSize = 30;
  const titleSize = 66;
  const titleLeading = titleSize * 1.32;
  const metaSize = 28;
  const titleWidth = Math.floor((WIDTH - 2 * PAD) / (CELL * titleSize));
  const titleLines = fit(wrap(title, titleWidth), TITLE_LINES, titleWidth);

  let y = PAD + promptSize;
  const [prompt, end] = await line(
    [
      { text: "guest", color: theme.green },
      { text: `@${image.hostname} `, color: theme.foreground },
      { text: cwd, color: theme.green },
      { text: command ? `> ${command}` : ">", color: theme.foreground },
    ],
    promptSize,
    y,
  );
  // At an empty prompt, the cursor waits: a block in the cell after the space.
  const cell = CELL * promptSize;
  const cursor = command
    ? ""
    : `<rect x="${(PAD + (end + 1) * cell).toFixed(2)}" y="${(y - promptSize * 0.82).toFixed(2)}" width="${cell.toFixed(2)}" height="${(promptSize * 1.08).toFixed(2)}" fill="${theme.cursor}"/>`;

  y += 92 + titleSize * 0.8;
  const heading: string[] = [];
  for (const [i, text] of titleLines.entries()) {
    heading.push((await line([{ text, color: theme.foreground, weight: 600 }], titleSize, y + i * titleLeading))[0]);
  }
  // The quiet line sits at the foot, as the last line on a screen does.
  const quiet = meta ? (await line([{ text: meta, color: theme.brightBlack }], metaSize, HEIGHT - PAD + 8))[0] : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<defs>
<radialGradient id="tube" cx="50%" cy="45%" r="75%">
<stop offset="0" stop-color="#1b1b1b"/><stop offset="0.55" stop-color="${theme.background}"/><stop offset="1" stop-color="#0d0d0d"/>
</radialGradient>
<radialGradient id="glass" cx="50%" cy="50%" r="72%">
<stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.5"/>
</radialGradient>
<radialGradient id="shine" cx="22%" cy="8%" r="45%">
<stop offset="0" stop-color="#fff" stop-opacity="0.035"/><stop offset="0.7" stop-color="#fff" stop-opacity="0"/>
</radialGradient>
<filter id="phosphor" x="-5%" y="-20%" width="110%" height="140%" color-interpolation-filters="sRGB">
<feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="near"/>
<feGaussianBlur in="SourceGraphic" stdDeviation="7" result="far"/>
<feComponentTransfer in="near" result="near"><feFuncA type="linear" slope="0.45"/></feComponentTransfer>
<feComponentTransfer in="far" result="far"><feFuncA type="linear" slope="0.22"/></feComponentTransfer>
<feMerge><feMergeNode in="far"/><feMergeNode in="near"/><feMergeNode in="SourceGraphic"/></feMerge>
</filter>
</defs>
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#tube)"/>
<g filter="url(#phosphor)">${prompt}${cursor}${heading.join("")}${quiet}</g>
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#shine)"/>
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glass)"/>
</svg>`;
}

export interface Drawn {
  /** Named by its content, so that a card drawn anew is a new address too. */
  name: string;
  png: Uint8Array;
}

const drawn = new Map<string, Promise<Drawn>>();

/** The card as a PNG: drawn once for as long as the process lasts. */
export function draw(card: Card): Promise<Drawn> {
  const key = JSON.stringify(card);
  if (!drawn.has(key)) {
    drawn.set(
      key,
      svg(card)
        .then((source) => sharp(Buffer.from(source)).png({ compressionLevel: 9 }).toBuffer())
        .then((png) => ({ name: `card-${createHash("sha256").update(png).digest("hex").slice(0, 10)}.png`, png })),
    );
  }
  return drawn.get(key)!;
}
