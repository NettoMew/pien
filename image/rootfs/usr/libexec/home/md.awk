# md.awk — typesets Markdown for the terminal, with care for Chinese text.
#
#   awk -v width=78 -f md.awk post.md     # width: whole lines, margin included
#
# Covers what the posts here use: front matter, headings, paragraphs, lists,
# quotes, tables, rules, fenced code in colour, pictures on lines of their
# own, and inline **bold**, *italic*, `code` and [links](url) — the last as
# OSC 8 hyperlinks you can click. Code is coloured by the very rules the web
# pages colour it with (scripts/lib/syntax.ts), which the image build writes
# into the machine as a table of their own (-v syntax=… to read another).
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
	UNSTYLE = ESC "[22;23;37m" # back to plain code, on the panel still
	HANG = "，。、；：！？」』）】》…,.;:!?)"
	MARGIN = "  "
	ROWS = 18 # the tallest a picture gets
	if (width < 20) width = 78
	if (syntax == "") syntax = "/usr/libexec/home/syntax"
	BASE = ESC "[39m"
	LIMIT = width; HANGS = 1
}

function spaces(n,   s) { s = ""; while (n-- > 0) s = s " "; return s }
function repeat(t, n,   s) { s = ""; while (n-- > 0) s = s t; return s }
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }

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

function links(s,   out, at, len, t, mid, before, mark) {
	out = ""
	while (match(s, /\[[^]]*\]\([^)]*\)/)) {
		at = RSTART; len = RLENGTH
		t = substr(s, at, len)
		mid = index(t, "](")
		# An image amid the text is a link to it, marked as one.
		before = substr(s, 1, at - 1); mark = ""
		if (substr(before, length(before)) == "!") { before = substr(before, 1, length(before) - 1); mark = "▣ " }
		out = out emphasis(before) \
			ESC "]8;;" substr(t, mid + 2, length(t) - mid - 2) ESC "\\" \
			CYAN mark emphasis(substr(t, 2, mid - 2)) BASE ESC "]8;;" ESC "\\"
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

# A finished line: printed, or kept in OUT[] for a table's cell to lay out.
function emit(s) { if (KEEP) OUT[++NOUT] = s; else print s }

# Appends one unbreakable unit (a word, or a single CJK character). LW is the
# line's width so far, prefix included; START is where its text begins; the
# line ends at LIMIT.
function place(u, uw,   i, k) {
	if (u == "") return
	if (LW > START && LW + SP + uw > LIMIT) {
		# Closing punctuation hangs into the margin rather than open a line.
		if (!HANGS || uw > 2 || LW + uw > LIMIT + 2 || index(HANG, plain(u)) == 0) {
			emit(LINE unlink() RESET)
			LINE = REST reopen(); LW = START = RESTW; SP = 0
		}
	}
	if (SP && LW > START) { LINE = LINE " "; LW++ }
	SP = 0
	LINE = LINE u; LW += uw
	for (i = 1; i <= length(u); i++) if (substr(u, i, 1) == ESC) { k = escape_at(u, i); track(k); i += length(k) - 1 }
}

# Prints `text` wrapped to LIMIT; `first` and `rest` prefix the first and
# following lines (margin, bullet, quote bar); `style` opens every line. A
# word wider than a whole line breaks where the line runs out.
function wrap(text, first, rest, style,   n, i, c, k, ch, w, word, ww, room) {
	bold = italic = 0; color = link = ""
	REST = rest; RESTW = dwidth(plain(rest))
	LINE = first; LW = START = dwidth(plain(first)); SP = 0
	room = LIMIT - RESTW
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
		if (ww >= room) { place(word, ww); word = ""; ww = 0 }
	}
	place(word, ww)
	emit(LINE unlink() RESET)
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

function flush(   r) {
	# Rows with no line of dashes under the first were never a table.
	if (block == "table" && !(nrows >= 2 && delimiter(trow[2]))) {
		block = "p"
		for (r = 1; r <= nrows; r++) buf = join(buf, trim(trow[r]))
	}
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
	} else if (block == "table") {
		gap("table"); BASE = ESC "[39m"
		table()
	}
	block = ""; buf = ""; nrows = 0
}

function heading(level, text) {
	flush(); gap("h"); BASE = ESC "[39m"
	if (level <= 1) wrap(inline(text), MARGIN, MARGIN, BOLD TEXT)
	else if (level == 2) wrap(inline(text), MARGIN, MARGIN, BOLD CYAN)
	else wrap(inline(text), MARGIN, MARGIN, BOLD)
}

# ─── Tables ──────────────────────────────────────────────────────────────────

# A row's cells, into `cell`: between pipes, the outer two optional, a pipe
# in `code` or escaped (\|) being text.
function cells(row, cell,   n, i, c, text, quoted) {
	delete cell
	row = trim(row); sub(/^\|/, "", row); sub(/\|$/, "", row)
	n = 0; text = ""; quoted = 0
	for (i = 1; i <= length(row); i++) {
		c = substr(row, i, 1)
		if (c == "\\" && substr(row, i + 1, 1) == "|") { text = text "|"; i++; continue }
		if (c == "`") quoted = !quoted
		if (c == "|" && !quoted) { cell[++n] = trim(text); text = ""; continue }
		text = text c
	}
	cell[++n] = trim(text)
	return n
}

# The line under a table's header: dashes in every cell, colons for alignment.
function delimiter(row,   cell, n, c) {
	n = cells(row, cell)
	for (c = 1; c <= n; c++) if (cell[c] !~ /^:?-+:?$/) return 0
	return 1
}

# A table as the web pages set one: the header bold above a rule, columns
# two spaces apart, each aligned as its line of dashes says. Too wide for
# the measure, the narrow columns keep what they need and the wide ones give
# way, their cells wrapping within.
function table(   c, r, k, n, t, total, left, share, order, need, cell, head, rule) {
	NCOLS = cells(trow[1], head)
	cells(trow[2], cell)
	for (c = 1; c <= NCOLS; c++) {
		ALIGN[c] = cell[c] ~ /^:.*:$/ ? "center" : cell[c] ~ /:$/ ? "right" : "left"
		need[c] = dwidth(plain(inline(head[c])))
	}
	for (r = 3; r <= nrows; r++) {
		n = cells(trow[r], cell)
		for (c = 1; c <= NCOLS; c++) {
			BODY[r, c] = c <= n ? cell[c] : ""
			k = dwidth(plain(inline(BODY[r, c]))); if (k > need[c]) need[c] = k
		}
	}
	total = 0
	for (c = 1; c <= NCOLS; c++) { COLW[c] = need[c]; total += need[c] }
	left = width - length(MARGIN) - 2 * (NCOLS - 1)
	if (total > left) {
		for (c = 1; c <= NCOLS; c++) order[c] = c
		for (c = 2; c <= NCOLS; c++)
			for (k = c; k > 1 && need[order[k - 1]] > need[order[k]]; k--) { t = order[k]; order[k] = order[k - 1]; order[k - 1] = t }
		for (k = 1; k <= NCOLS; k++) {
			c = order[k]; share = int(left / (NCOLS - k + 1))
			COLW[c] = need[c] < share ? need[c] : share
			if (COLW[c] < 2) COLW[c] = 2
			left -= COLW[c]
		}
	}
	tablerow(head, BOLD)
	rule = MARGIN MUTED
	for (c = 1; c <= NCOLS; c++) rule = rule repeat("─", COLW[c]) (c < NCOLS ? "  " : "")
	print rule RESET
	for (r = 3; r <= nrows; r++) {
		for (c = 1; c <= NCOLS; c++) cell[c] = BODY[r, c]
		tablerow(cell, "")
	}
}

# One row: each cell wrapped to its column, side by side, line by line.
function tablerow(text, style,   c, l, most, line, pad, out) {
	most = 1
	for (c = 1; c <= NCOLS; c++) {
		KEEP = 1; NOUT = 0; LIMIT = COLW[c]; HANGS = 0
		wrap(inline(text[c]), "", "", style)
		KEEP = 0; LIMIT = width; HANGS = 1
		LINES_OF[c] = NOUT
		for (l = 1; l <= NOUT; l++) CELL[c, l] = OUT[l]
		if (NOUT > most) most = NOUT
	}
	for (l = 1; l <= most; l++) {
		out = MARGIN
		for (c = 1; c <= NCOLS; c++) {
			line = l <= LINES_OF[c] ? CELL[c, l] : ""
			pad = COLW[c] - dwidth(plain(line))
			if (ALIGN[c] == "right") line = spaces(pad) line
			else if (ALIGN[c] == "center") line = spaces(int(pad / 2)) line (c < NCOLS ? spaces(pad - int(pad / 2)) : "")
			else if (c < NCOLS) line = line spaces(pad)
			out = out line (c < NCOLS ? "  " : "")
		}
		print out
	}
}

# ─── Code ────────────────────────────────────────────────────────────────────

# The colouring rules, read once: each style's SGR; each language's markers
# and words, under every one of its names.
function rules(   line, f, n, i, id) {
	if (RULES++) return
	while ((getline line < syntax) > 0) {
		n = split(line, f, "\t")
		if (f[1] == "style") SGR[f[2]] = ESC "[" f[3] "m"
		else if (f[1] == "lang") { id++; for (i = 2; i <= n; i++) LANG[f[i]] = id }
		else if (f[1] == "lines") BYLINE[id] = 1
		else if (f[1] == "comment") COMMENT[id] = f[2]
		else if (f[1] == "block") { OPEN[id] = f[2]; CLOSE[id] = f[3] }
		else if (f[1] == "quotes") QUOTES[id] = f[2]
		else if (f[1] == "sigils") SIGILS[id] = f[2]
		else if (f[1] == "words") for (i = 2; i <= n; i++) WORD[id, f[i]] = 1
	}
	close(syntax)
}

function paint(style, s) { return style == "" || s == "" ? s : SGR[style] s UNSTYLE }

# Where `t` is in `s`, looking from `from` on; 0 if nowhere.
function found(s, t, from,   at) {
	at = index(substr(s, from), t)
	return at ? from + at - 1 : 0
}

function diffstyle(s) {
	if (s ~ /^(\+\+\+ |--- |diff |index )/) return "heading"
	if (s ~ /^@@/) return "hunk"
	if (s ~ /^\+/) return "inserted"
	if (s ~ /^-/) return "deleted"
	return ""
}

# One line of code in its language's colours, step for step as tokens() in
# syntax.ts takes it; a comment in a block carries on to the next line.
function highlight(s,   out, n, i, j, c, from, word, sigil) {
	if (!L) return s
	if (BYLINE[L]) return paint(diffstyle(s), s)
	out = ""; n = length(s); i = 1
	while (i <= n) {
		if (INBLOCK || (OPEN[L] != "" && substr(s, i, length(OPEN[L])) == OPEN[L])) {
			from = INBLOCK ? i : i + length(OPEN[L]); INBLOCK = 1
			j = found(s, CLOSE[L], from)
			if (!j) { out = out paint("comment", substr(s, i)); break }
			j += length(CLOSE[L])
			out = out paint("comment", substr(s, i, j - i)); i = j; INBLOCK = 0
			continue
		}
		if (COMMENT[L] != "" && substr(s, i, length(COMMENT[L])) == COMMENT[L] && (i == 1 || substr(s, i - 1, 1) ~ /[ \t]/)) {
			out = out paint("comment", substr(s, i)); break
		}
		c = substr(s, i, 1)
		if (index(QUOTES[L], c)) {
			j = i + 1
			while (j <= n && substr(s, j, 1) != c) j += substr(s, j, 1) == "\\" ? 2 : 1
			if (j > n) j = n
			out = out paint("string", substr(s, i, j - i + 1)); i = j + 1
			continue
		}
		if (c ~ /[0-9]/ && !(i > 1 && substr(s, i - 1, 1) ~ /[A-Za-z0-9_]/)) {
			j = i + 1
			while (j <= n && substr(s, j, 1) ~ /[0-9A-Za-z_.]/) j++
			out = out paint("number", substr(s, i, j - i)); i = j
			continue
		}
		sigil = index(SIGILS[L], c) && substr(s, i + 1, 1) ~ /[A-Za-z_]/
		if (c ~ /[A-Za-z_]/ || sigil) {
			j = i + 1
			while (j <= n && substr(s, j, 1) ~ /[A-Za-z0-9_]/) j++
			word = substr(s, i, j - i)
			if ((L, word) in WORD) out = out paint("keyword", word)
			else if (sigil) out = out paint("variable", word)
			else if (substr(s, j, 1) == "(") out = out paint("call", word)
			else out = out word
			i = j
			continue
		}
		out = out c; i++
	}
	return out
}

# A code block is a panel the width of the text, the language in its corner.
# Lines too long for it continue on the next row, marked ↳, never past its edge.
function code(   i, name) {
	gap("code")
	rules()
	name = lang; sub(/^ +/, "", name); sub(/[ {].*$/, "", name)
	L = LANG[tolower(name)]; INBLOCK = 0
	PANELW = width - length(MARGIN)
	print MARGIN PANEL spaces(PANELW - dwidth(lang) - 2) MUTED lang "  " RESET
	for (i = 1; i <= ncode; i++) { gsub(/\t/, "    ", codeline[i]); panel(highlight(codeline[i])) }
	print MARGIN PANEL spaces(PANELW) RESET
	ncode = 0
}

# One line of it, broken at the panel's edge: a continued row takes up the
# colour the code was in.
function panel(s,   avail, i, n, k, c, ch, w, chunk, cw, lead, hue) {
	avail = PANELW - 4
	lead = "  "; chunk = ""; cw = 0; hue = ""; n = length(s)
	for (i = 1; i <= n; i += k) {
		c = substr(s, i, 1)
		if (c == ESC) { k = length(escape_at(s, i)); hue = substr(s, i, k); chunk = chunk hue; continue }
		k = clen(c); ch = substr(s, i, k); w = cwidth(ch)
		if (cw + w > avail) {
			print MARGIN PANEL lead CODE chunk UNSTYLE spaces(PANELW - 2 - cw) RESET
			lead = MUTED "↳ "; chunk = hue; cw = 0
		}
		chunk = chunk ch; cw += w
	}
	print MARGIN PANEL lead CODE chunk UNSTYLE spaces(PANELW - 2 - cw) RESET
}

# ─── Pictures ────────────────────────────────────────────────────────────────

# A line that is only an image: the picture itself, in the iTerm2 inline-image
# sequence the page draws (src/terminal.ts), fitted to the measure and at most
# ROWS rows tall, its description beneath. One that cannot be shown from here
# (on the web, missing, or by a name the shell would trip on) is a link.
function picture(s,   mid, alt, src, path, data, cmd, n, size) {
	mid = index(s, "](")
	alt = substr(s, 3, mid - 3)
	src = substr(s, mid + 2); sub(/\) *$/, "", src)
	path = src ~ /^\// ? src : DIR src
	gap("picture")
	if (src !~ /^[a-z]+:/ && index(path, "'") == 0 && (getline data < path) >= 0) {
		close(path)
		cmd = "base64 -w0 '" path "'"
		data = ""; cmd | getline data; close(cmd)
		if (data != "") {
			# The sequence wants the picture's size in bytes: three for every
			# four characters of base64, less its padding.
			n = length(data)
			size = n / 4 * 3 - (substr(data, n) == "=") - (substr(data, n - 1, 1) == "=")
			printf "%s%s]1337;File=inline=1;size=%d;width=%d;height=%d;preserveAspectRatio=1:%s%c\n", MARGIN, ESC, size, width - length(MARGIN), ROWS, data, 7
			if (alt != "") print MARGIN MUTED alt RESET
			return
		}
	}
	print MARGIN ESC "]8;;" src ESC "\\" CYAN "▣ " (alt != "" ? alt : src) RESET ESC "]8;;" ESC "\\"
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

NR == 1 { print ""; DIR = FILENAME; sub(/[^\/]*$/, "", DIR) }
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

/^ *\|/ { if (block != "table") flush(); block = "table"; trow[++nrows] = $0; next }

/^[-*+] / { flush(); block = "ul"; buf = substr($0, 3); next }

/^[0-9]+\. / { flush(); block = "ol"; match($0, /^[0-9]+\./); marker = substr($0, 1, RLENGTH); buf = substr($0, RLENGTH + 2); next }

/^!\[[^]]*\]\([^)]+\) *$/ { flush(); picture($0); next }

/^[ \t]*$/ { flush(); next }

{
	if (block == "table") flush()
	line = $0; sub(/^[ \t]+/, "", line)
	if (block == "") block = "p"
	buf = join(buf, line)
}

END { if (mode == "code") code(); flush(); print "" }
