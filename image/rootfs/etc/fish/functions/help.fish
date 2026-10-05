function help --description 'What this machine can do'
    set -l rows \
        'ls  cd  tree  grep' 'real commands, go ahead' \
        blog 'the posts' \
        'cat post.md' 'read one, typeset' \
        'open post.md' 'read it as a web page' \
        'fastfetch  htop' 'look at this machine' \
        'net on' 'go online: curl, ping, ssh, mtr' \
        drop 'bring in files from your computer' \
        'adb  fastboot' 'a phone over USB, as on any desk' \
        'serial  tio' 'a serial port from your computer'

    echo
    set -l hl (set_color cyan)
    set -l dim (set_color brblack)
    set -l n (set_color normal)
    for i in (seq 1 2 (count $rows))
        set -l about $rows[(math $i + 1)]
        if test $COLUMNS -lt 60 # a phone: one above the other
            printf '  %s%s%s\n  %s%s%s\n' $hl $rows[$i] $n $dim $about $n
        else
            printf '  %s%s%s  %s\n' $hl (string pad -r -w 18 -- $rows[$i]) $n $about
        end
    end
    echo
    set_color brblack
    echo '  Files download when first read.'
    echo '  It all lives in your browser:'
    echo '  break anything, reload to undo.'
    set_color normal
    echo
end
