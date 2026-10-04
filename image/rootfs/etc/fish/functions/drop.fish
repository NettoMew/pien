function drop --description 'Bring files in from this computer, into ~/drop'
    set -l dim (set_color brblack)
    set -l n (set_color normal)
    echo waiting >/run/drop/state
    # A private escape sequence: the page opens the browser's file chooser.
    printf '\e]7337;drop\a'
    echo $dim'  Choose files in the browser. Dropping them'$n
    echo $dim'  onto the page works too, at any time.'$n
    for i in (seq 3000)
        read -l state </run/drop/state
        test "$state" != waiting; and break
        sleep 0.1
    end

    read -l state </run/drop/state
    switch $state
        case waiting none
            echo none >/run/drop/state
            echo '  None chosen.'
            return 1
    end
    for name in (cat /run/drop/names)
        printf '  ~/drop/%s  %s%s%s\n' $name $dim (ls -lhd -- ~/drop/$name | awk '{ print $5 }') $n
    end
    echo $dim'  Read from your computer as they are used: nothing is copied.'$n
end
