function fish_prompt
    set -l last $status
    set -l arrow 4DE8FF
    test $last -ne 0; and set arrow FF6B6B

    printf '%s%s@%s %s%s %s❯%s ' \
        (set_color 7E8590) $USER $hostname \
        (set_color 4DE8FF) (prompt_pwd) \
        (set_color $arrow) (set_color normal)
end
