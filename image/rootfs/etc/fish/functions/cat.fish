function cat --description 'cat, but Markdown is typeset when it lands on a terminal'
    if test -t 1; and test (count $argv) -eq 1; and string match -q -- '*.md' $argv[1]; and test -f $argv[1]
        # A comfortable measure on wide screens; edge to edge on narrow ones.
        awk -v width=(math "min($COLUMNS - 2, 78)") -f /usr/libexec/home/md.awk -- $argv[1]
        return
    end
    command cat $argv
end
