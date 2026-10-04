function fish_right_prompt
    # Only worth mentioning when a command took a while.
    set -q CMD_DURATION; and test $CMD_DURATION -gt 1000; or return
    set_color 5C636E
    printf '%ss' (math -s1 $CMD_DURATION / 1000)
    set_color normal
end
