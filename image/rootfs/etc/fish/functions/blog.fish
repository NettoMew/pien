function blog --description 'List the posts'
    set -l dates
    set -l files
    set -l titles
    while read -l -d \t date file title
        set -a dates $date
        set -a files $file
        set -a titles $title
    end < /usr/share/home/posts

    set -l dim (set_color brblack)
    set -l hl (set_color cyan)
    set -l n (set_color normal)
    set -l column (math (string length -- $files | sort -n | tail -n1) + 3)

    echo
    for i in (seq (count $files))
        if test $COLUMNS -lt 60 # a phone: title first, the rest beneath
            printf '  %s\n  %s%s · %s%s%s\n\n' $titles[$i] $dim $dates[$i] $hl $files[$i] $n
        else
            printf '  %s%s%s  %s%s%s%s\n' $dim $dates[$i] $n $hl (string pad -r -w $column -- $files[$i]) $n $titles[$i]
        end
    end
    test $COLUMNS -lt 60; or echo
    echo '  '$dim'Read one: cat blog/<file>'$n
    echo
end
