// Code in the writing, coloured: one set of rules, for both places it is
// read. The web pages colour it here (blog.ts); the guest's `cat` colours it
// in md.awk, from these same rules, which the image build writes into the
// machine as a plain table (`guestTable`: /usr/libexec/home/syntax). A rule
// kept in one place cannot drift from the other.
//
// A lexer of the simplest kind, line by line, which md.awk repeats step for
// step: a comment opened by its marker at the start of a line or after a
// space; strings between a pair of their quotes, backslashes escaping; a
// number where a word could start; words — the language's own (keywords),
// one led by a sigil ($HOME, #include), one called (a name right before
// "("). Comments in blocks run across lines. A diff is coloured by line.

/** What a piece of code is, and how each place shows it: an SGR for the terminal, classes for the web. */
export const styles = {
  keyword: { sgr: "35", css: "text-magenta" },
  string: { sgr: "32", css: "text-green" },
  comment: { sgr: "3;90", css: "text-faint italic" },
  number: { sgr: "33", css: "text-yellow" },
  call: { sgr: "34", css: "text-blue" },
  variable: { sgr: "36", css: "text-cyan" },
  inserted: { sgr: "32", css: "text-green" },
  deleted: { sgr: "31", css: "text-red" },
  hunk: { sgr: "36", css: "text-cyan" },
  heading: { sgr: "1", css: "font-semibold" },
} as const;

export type Style = keyof typeof styles;

interface Language {
  /** The names a fence may give it: ```c, ```sh … */
  names: string[];
  /** To the end of the line. */
  comment?: string;
  /** Across lines, from the first to the second. */
  block?: [string, string];
  /** The characters a string opens and closes with. */
  quotes?: string;
  /** Characters a word may begin with, and still be one: $ for shells, # for C's directives. */
  sigils?: string;
  /** The language's own words. */
  words?: string;
  /** Coloured by line, as a diff is: added, removed, where. */
  lines?: true;
}

const C = "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL #include #define #undef #if #ifdef #ifndef #elif #else #endif #pragma #error";

const languages: Language[] = [
  {
    names: ["sh", "bash", "shell", "zsh", "console"],
    comment: "#",
    quotes: `"'`,
    sigils: "$",
    words: "if then else elif fi for while until do done case esac in function return local export readonly declare set unset shift source exit break continue select time",
  },
  {
    names: ["fish"],
    comment: "#",
    quotes: `"'`,
    sigils: "$",
    words: "and begin break builtin case command continue else end exit for function if in not or return set switch while",
  },
  { names: ["c", "h"], comment: "//", block: ["/*", "*/"], quotes: `"'`, sigils: "#", words: C },
  {
    names: ["cpp", "c++", "cc", "hpp"],
    comment: "//",
    block: ["/*", "*/"],
    quotes: `"'`,
    sigils: "#",
    words: `${C} class namespace template typename public private protected virtual override final new delete this nullptr using try catch throw constexpr noexcept operator`,
  },
  {
    names: ["rust", "rs"],
    comment: "//",
    block: ["/*", "*/"],
    quotes: `"`,
    words: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
  },
  {
    names: ["go", "golang"],
    comment: "//",
    block: ["/*", "*/"],
    quotes: "\"'`",
    words: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil",
  },
  {
    names: ["python", "py"],
    comment: "#",
    quotes: `"'`,
    words: "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self",
  },
  {
    names: ["js", "javascript", "mjs", "jsx", "ts", "typescript", "tsx"],
    comment: "//",
    block: ["/*", "*/"],
    quotes: "\"'`",
    words: "as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function if implements import in instanceof interface keyof let new null of readonly return satisfies static super switch this throw true try type typeof undefined var void while yield",
  },
  { names: ["json", "jsonc"], comment: "//", block: ["/*", "*/"], quotes: `"`, words: "true false null" },
  { names: ["toml", "ini", "conf"], comment: "#", quotes: `"'`, words: "true false" },
  { names: ["yaml", "yml"], comment: "#", quotes: `"'`, words: "true false null yes no" },
  {
    names: ["lua"],
    comment: "--",
    block: ["--[[", "]]"],
    quotes: `"'`,
    words: "and break do else elseif end false for function goto if in local nil not or repeat return then true until while",
  },
  { names: ["diff", "patch"], lines: true },
];

const byName = new Map(languages.flatMap((language) => language.names.map((name) => [name, language] as const)));
const keywords = new Map(languages.map((language) => [language, new Set(language.words?.split(" "))]));

/** The language a fence names, by its first word, in any case. */
const language = (fence: string) => byName.get(fence.trim().split(/\s/)[0]!.toLowerCase());

const isWordStart = (c: string | undefined) => c !== undefined && /[A-Za-z_]/.test(c);
const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);

/** One run of code: how it shows, if at all, and its text. */
export type Token = [Style | "", string];

/** `code`, line by line, as runs of what each part is. */
export function tokens(code: string, fence: string): Token[][] {
  const lang = language(fence);
  let inBlock = false;
  return code.split("\n").map((line) => {
    if (!lang) return [["", line]];
    if (lang.lines) return [[diffStyle(line), line]];
    const out: Token[] = [];
    const put = (style: Style | "", text: string) => {
      const last = out.at(-1);
      if (last && last[0] === style) last[1] += text;
      else if (text) out.push([style, text]);
    };
    const n = line.length;
    let i = 0;
    while (i < n) {
      const [open, close] = lang.block ?? ["", ""];
      if (inBlock || (open && line.startsWith(open, i))) {
        const from = inBlock ? i : i + open.length;
        inBlock = true;
        const at = line.indexOf(close, from);
        if (at < 0) {
          put("comment", line.slice(i));
          break;
        }
        put("comment", line.slice(i, at + close.length));
        i = at + close.length;
        inBlock = false;
        continue;
      }
      if (lang.comment && line.startsWith(lang.comment, i) && (i === 0 || /[ \t]/.test(line[i - 1]!))) {
        put("comment", line.slice(i));
        break;
      }
      const c = line[i]!;
      if (lang.quotes?.includes(c)) {
        let j = i + 1;
        while (j < n && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
        const end = Math.min(j, n - 1);
        put("string", line.slice(i, end + 1));
        i = end + 1;
        continue;
      }
      if (/[0-9]/.test(c) && !isWord(line[i - 1])) {
        let j = i + 1;
        while (j < n && /[0-9A-Za-z_.]/.test(line[j]!)) j++;
        put("number", line.slice(i, j));
        i = j;
        continue;
      }
      const sigil = Boolean(lang.sigils?.includes(c)) && isWordStart(line[i + 1]);
      if (isWordStart(c) || sigil) {
        let j = i + 1;
        while (j < n && isWord(line[j])) j++;
        const word = line.slice(i, j);
        put(keywords.get(lang)!.has(word) ? "keyword" : sigil ? "variable" : line[j] === "(" ? "call" : "", word);
        i = j;
        continue;
      }
      put("", c);
      i++;
    }
    return out;
  });
}

function diffStyle(line: string): Style | "" {
  if (/^(\+\+\+ |--- |diff |index )/.test(line)) return "heading";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "inserted";
  if (line.startsWith("-")) return "deleted";
  return "";
}

const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** `code` as HTML, its runs in the terminal's colours by name. */
export function highlight(code: string, fence: string): string {
  return tokens(code, fence)
    .map((line) => line.map(([style, text]) => (style ? `<span class="${styles[style].css}">${escape(text)}</span>` : escape(text))).join(""))
    .join("\n");
}

/**
 * The rules as md.awk reads them, one per line, fields between tabs: each
 * style's SGR, then each language, its names first.
 */
export function guestTable(): string {
  const rows = Object.entries(styles).map(([name, { sgr }]) => ["style", name, sgr]);
  for (const lang of languages) {
    rows.push(["lang", ...lang.names]);
    if (lang.lines) rows.push(["lines"]);
    if (lang.comment) rows.push(["comment", lang.comment]);
    if (lang.block) rows.push(["block", ...lang.block]);
    if (lang.quotes) rows.push(["quotes", lang.quotes]);
    if (lang.sigils) rows.push(["sigils", lang.sigils]);
    if (lang.words) rows.push(["words", ...lang.words.split(" ")]);
  }
  return rows.map((row) => `${row.join("\t")}\n`).join("");
}
