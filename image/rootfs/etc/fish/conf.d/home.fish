# The guest's interactive environment.

status is-interactive; or return

set -gx LANG C.UTF-8
set -gx COLORTERM truecolor
set -gx EDITOR edit # Microsoft Edit; `set EDITOR nano` for nano
set -gx LESS -R
set -gx PATH $PATH /usr/sbin /sbin # ip, ifconfig, route: looking is allowed

# fish as it ships — its own prompt and colours, painted by the terminal's
# palette (src/theme.ts). Only the greeting goes: the screen has just shown
# the machine starting up.
set -g fish_greeting
