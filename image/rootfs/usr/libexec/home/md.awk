# md.awk — typesets Markdown for the terminal, with care for Chinese text.
#
#   awk -v width=78 -f md.awk post.md     # width: whole lines, margin included
#
# Covers what the posts here use: front matter, headings, paragraphs, lists,
# quotes, fenced code, rules, and inline **bold**, *italic*, `code` and
# [links](url) — the last as OSC 8 hyperlinks you can click.
#
# Wrapping counts display columns (CJK takes two), breaks between Chinese
# characters as well as at spaces, and lets closing punctuation hang past the
# edge instead of starting a line. busybox awk sees bytes, so UTF-8 is decoded
# by hand: a lead byte tells a character's length, and its range its width.
#
# (busybox awk mangles backslashes in regexes built from strings, so every
# regex here is a /literal/.)

BEGIN {
	ESC = sprintf("%c", 27)
	RESET = ESC "[0m"
	BOLD = ESC "[1m"; UNBOLD = ESC "[22m"
	ITALIC = ESC "[3m"; UNITALIC = ESC "[23m"
	# The terminal's own palette, by name: it decides what each looks like.
	TEXT = ESC "[39m"; MUTED = ESC "[90m"; CODE = ESC "[37m"
	CYAN = ESC "[36m"; YELLOW = ESC "[33m"
	PANEL = ESC "[40m"
	HANG = "，。、；：！？」』）】》…,.;:!?)"
	MARGIN = "  "
	if (width < 20) width = 78
	BASE = ESC "[39m"
}

function spaces(n,   s) { s = ""; while (n-- > 0) s = s " "; return s }
function repeat(t, n,   s) { s = ""; while (n-- > 0) s = s t; return s }

# ─── UTF-8 ───────────────────────────────────────────────────────────────────

function clen(c) { return c < "\200" ? 1 : c < "\340" ? 2 : c < "\360" ? 3 : 4 }

function cwidth(ch,   b, b2, b3) {
	b = substr(ch, 1, 1)
	if (b < "\342") return 1                       # ASCII .. U+1FFF
	if (b >= "\360") return 2                      # emoji, CJK extensions
	b2 = substr(ch, 2, 1)
	if (b == "\342") return b2 >= "\272" ? 2 : 1   # U+2E80..: CJK radicals
	if (b <= "\355") return 2                      # U+3000..U+D7FF: CJK, kana, Hangul
	if (b == "\357") {                             # U+F000..U+FFFF
		b3 = substr(ch, 3, 1)
		if (b2 >= "\244" && b2 <= "\253") return 2  # CJK compatibility ideographs
		if (b2 == "\274" || (b2 == "\275" && b3 <= "\240")) return 2  # fullwidth forms
	}
	return 1
}

function dwidth(s,   i, n, k, w) {
	w = 0; n = length(s)
	for (i = 1; i <= n; i += k) { k = clen(substr(s, i, 1)); w += cwidth(substr(s, i, k)) }
	return w
}

# ─── Inline markup ───────────────────────────────────────────────────────────

# Wraps the part of `s` that match() just found: `k` marker characters each
# side are dropped, the inside goes between `on` and `off`.
function swap(s, k, on, off) {
	return substr(s, 1, RSTART - 1) on substr(s, RSTART + k, RLENGTH - 2 * k) off
}

function emphasis(s,   out) {
	out = ""
	while (match(s, /\*\*[^*]+\*\*/)) { out = out swap(s, 2, BOLD, UNBOLD); s = substr(s, RSTART + RLENGTH) }
	s = out s; out = ""
	while (match(s, /\*[^*]+\*/)) { out = out swap(s, 1, ITALIC, UNITALIC); s = substr(s, RSTART + RLENGTH) }
	return out s
}

# (match() sets the globals RSTART and RLENGTH, and the helpers called below
# match too — so each loop keeps its own copies.)

function links(s,   out, at, len, t, mid) {
	out = ""
	while (match(s, /\[[^]]*\]\([^)]*\)/)) {
		at = RSTART; len = RLENGTH
		t = substr(s, at, len)
		mid = index(t, "](")
		out = out emphasis(substr(s, 1, at - 1)) \
			ESC "]8;;" substr(t, mid + 2, length(t) - mid - 2) ESC "\\" \
			CYAN emphasis(substr(t, 2, mid - 2)) BASE ESC "]8;;" ESC "\\"
		s = substr(s, at + len)
	}
	return out emphasis(s)
}

function inline(s,   out, at, len) {
	out = ""
	while (match(s, /`[^`]+`/)) {
		at = RSTART; len = RLENGTH
		out = out links(substr(s, 1, at - 1)) YELLOW substr(s, at + 1, len - 2) BASE
		s = substr(s, at + len)
	}
	return out links(s)
}

# ─── Wrapping ────────────────────────────────────────────────────────────────

# The style in force, so it can be closed at a line break and reopened after
# the next line's prefix (which brings its own colours).
function track(e) {
	if (e == RESET) { bold = italic = 0; color = link = "" }
	else if (e == BOLD) bold = 1
	else if (e == UNBOLD) bold = 0
	else if (e == ITALIC) italic = 1
	else if (e == UNITALIC) italic = 0
	else if (e == ESC "[39m") color = ""
	else if (index(e, ESC "[38;") == 1) color = e
	else if (index(e, ESC "]8;;") == 1) link = substr(e, 6, length(e) - 7)  # ESC ]8;; <url> ESC \
}

function reopen(   s) {
	s = ""
	if (bold) s = s BOLD
	if (italic) s = s ITALIC
	s = s color
	if (link != "") s = s ESC "]8;;" link ESC "\\"
	return s
}

function unlink() {
	if (link != "") return ESC "]8;;" ESC "\\"
	return ""
}

# The escape sequence starting at s[i]: CSI ends at its final byte, OSC at ST.
function escape_at(s, i,   j, n, c) {
	n = length(s)
	c = substr(s, i + 1, 1)
	if (c == "[") {
		for (j = i + 2; j <= n; j++) { c = substr(s, j, 1); if (c >= "@" && c <= "~") return substr(s, i, j - i + 1) }
	} else if (c == "]") {
		for (j = i + 2; j < n; j++) if (substr(s, j, 2) == ESC "\\") return substr(s, i, j - i + 2)
	}
	return ESC
}

function plain(u,   out, i, c, k) {
	out = ""
	for (i = 1; i <= length(u); i += k) {
		c = substr(u, i, 1)
		if (c == ESC) k = length(escape_at(u, i))
		else { k = clen(c); out = out substr(u, i, k) }
	}
	return out
}

# Appends one unbreakable unit (a word, or a single CJK character). LW is the
# line's width so far, prefix included; START is where its text begins.
function place(u, uw,   i, k) {
	if (u == "") return
	if (LW > START && LW + SP + uw > width) {
		# Closing punctuation hangs into the margin rather than open a line.
		if (uw > 2 || LW + uw > width + 2 || index(HANG, plain(u)) == 0) {
			print LINE unlink() RESET
			LINE = REST reopen(); LW = START = RESTW; SP = 0
		}
	}
	if (SP && LW > START) { LINE = LINE " "; LW++ }
	SP = 0
	LINE = LINE u; LW += uw
	for (i = 1; i <= length(u); i++) if (substr(u, i, 1) == ESC) { k = escape_at(u, i); track(k); i += length(k) - 1 }
}

# Prints `text` wrapped to the width; `first` and `rest` prefix the first and
# following lines (margin, bullet, quote bar); `style` opens every line.
function wrap(text, first, rest, style,   n, i, c, k, ch, w, word, ww) {
	bold = italic = 0; color = link = ""
	REST = rest; RESTW = dwidth(plain(rest))
	LINE = first; LW = START = dwidth(plain(first)); SP = 0
	text = style text
	word = ""; ww = 0
	n = length(text)
	for (i = 1; i <= n; ) {
		c = substr(text, i, 1)
		if (c == ESC) { k = escape_at(text, i); word = word k; i += length(k); continue }
		k = clen(c); ch = substr(text, i, k); i += k
		if (ch == " ") { place(word, ww); word = ""; ww = 0; SP = 1; continue }
		w = cwidth(ch)
		if (w == 2) { place(word, ww); word = ""; ww = 0; place(ch, 2); continue }
		word = word ch; ww += w
	}
	place(word, ww)
	print LINE unlink() RESET
}

# ─── Blocks ──────────────────────────────────────────────────────────────────

# One blank line between blocks — except between items of the same list.
function gap(type) {
	if (last != "" && (type != last || (type != "ul" && type != "ol"))) print ""
	last = type
}

# Joins source lines; Chinese broken across lines rejoins without a space.
function join(a, b) {
	if (a == "") return b
	if (substr(a, length(a), 1) >= "\200" && substr(b, 1, 1) >= "\200") return a b
	return a " " b
}

function flush(   num) {
	if (block == "p") {
		gap("p"); BASE = ESC "[39m"
		wrap(inline(buf), MARGIN, MARGIN, "")
	} else if (block == "ul") {
		gap("ul"); BASE = ESC "[39m"
		wrap(inline(buf), MARGIN MUTED "•" RESET " ", MARGIN "  ", "")
	} else if (block == "ol") {
		gap("ol"); BASE = ESC "[39m"
		wrap(inline(buf), MARGIN MUTED marker RESET " ", MARGIN spaces(length(marker) + 1), "")
	} else if (block == "quote") {
		gap("quote"); BASE = MUTED
		wrap(inline(buf), MARGIN CYAN "▎" RESET " ", MARGIN CYAN "▎" RESET " ", ITALIC MUTED)
	}
	block = ""; buf = ""
}

function heading(level, text) {
	flush(); gap("h"); BASE = ESC "[39m"
	if (level <= 1) wrap(inline(text), MARGIN, MARGIN, BOLD TEXT)
	else if (level == 2) wrap(inline(text), MARGIN, MARGIN, BOLD CYAN)
	else wrap(inline(text), MARGIN, MARGIN, BOLD)
}

# A code block is a panel the width of the text, the language in its corner.
# Lines too long for it continue on the next row, marked ↳, never past its edge.
function code(   i) {
	gap("code")
	PANELW = width - length(MARGIN)
	print MARGIN PANEL spaces(PANELW - dwidth(lang) - 2) MUTED lang "  " RESET
	for (i = 1; i <= ncode; i++) { gsub(/\t/, "    ", codeline[i]); panel(codeline[i]) }
	print MARGIN PANEL spaces(PANELW) RESET
	ncode = 0
}

function panel(s,   avail, i, n, k, ch, w, chunk, cw, lead) {
	avail = PANELW - 4
	lead = "  "; chunk = ""; cw = 0; n = length(s)
	for (i = 1; i <= n; i += k) {
		k = clen(substr(s, i, 1)); ch = substr(s, i, k); w = cwidth(ch)
		if (cw + w > avail) {
			print MARGIN PANEL lead CODE chunk spaces(PANELW - 2 - cw) RESET
			lead = MUTED "↳ "; chunk = ""; cw = 0
		}
		chunk = chunk ch; cw += w
	}
	print MARGIN PANEL lead CODE chunk spaces(PANELW - 2 - cw) RESET
}

function front(   meta, tags) {
	tags = meta_tags
	gsub(/^\[|\]$/, "", tags); gsub(/, */, " · ", tags)
	meta = meta_date
	if (meta != "" && tags != "") meta = meta " · "
	meta = meta tags
	if (meta_title != "") { gap("h"); print MARGIN BOLD TEXT meta_title RESET }
	if (meta != "") { if (meta_title == "") gap("h"); print MARGIN MUTED meta RESET }
}

NR == 1 { print "" }
NR == 1 && $0 == "---" { mode = "front"; next }

mode == "front" {
	if ($0 == "---") { mode = ""; front(); next }
	if (match($0, "^[A-Za-z]+:")) {
		value = substr($0, RLENGTH + 1); sub(/^ +/, "", value)
		key = substr($0, 1, RLENGTH - 1)
		if (key == "title") meta_title = value
		else if (key == "date") meta_date = value
		else if (key == "tags") meta_tags = value
	}
	next
}

mode == "code" {
	if ($0 ~ /^```/) { mode = ""; code() } else codeline[++ncode] = $0
	next
}

/^```/ { flush(); mode = "code"; lang = substr($0, 4); next }

/^#+ / { match($0, /^#+/); heading(RLENGTH, substr($0, RLENGTH + 2)); next }

/^(---|\*\*\*|___) *$/ { flush(); gap("hr"); print MARGIN MUTED repeat("─", 40) RESET; next }

/^> ?/ {
	if (block != "quote") flush()
	block = "quote"; line = $0; sub(/^> ?/, "", line); buf = join(buf, line)
	next
}

/^[-*+] / { flush(); block = "ul"; buf = substr($0, 3); next }

/^[0-9]+\. / { flush(); block = "ol"; match($0, /^[0-9]+\./); marker = substr($0, 1, RLENGTH); buf = substr($0, RLENGTH + 2); next }

/^[ \t]*$/ { flush(); next }

{
	line = $0; sub(/^[ \t]+/, "", line)
	if (block == "") block = "p"
	buf = join(buf, line)
}

END { if (mode == "code") code(); flush(); print "" }
