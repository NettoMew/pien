# The guest's interactive environment.

status is-interactive; or return

set -gx LANG C.UTF-8
set -gx COLORTERM truecolor
set -gx EDITOR vi
set -gx LESS -R
set -gx PATH $PATH /usr/sbin /sbin # ip, ifconfig, route: looking is allowed

# Palette — mirrors src/theme.ts
set -g fish_color_normal E7E9EE
set -g fish_color_command 4DE8FF
set -g fish_color_keyword C792EA
set -g fish_color_param E7E9EE
set -g fish_color_option A9AFBA
set -g fish_color_quote FFB547
set -g fish_color_escape FFB547
set -g fish_color_redirection C792EA
set -g fish_color_end C792EA
set -g fish_color_operator C792EA
set -g fish_color_error FF6B6B
set -g fish_color_comment 5C636E
set -g fish_color_autosuggestion 5C636E
set -g fish_color_valid_path --underline
set -g fish_color_selection --background=2A2F38
set -g fish_color_search_match --background=2A2F38
set -g fish_pager_color_prefix 4DE8FF --bold
set -g fish_pager_color_completion E7E9EE
set -g fish_pager_color_description 7E8590
set -g fish_pager_color_progress 7E8590
set -g fish_pager_color_selected_background --background=1F232B
