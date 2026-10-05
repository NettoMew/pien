function share --description "A folder on this computer, in here at /mnt, to read and to write: share | share off [<folder>]"
    set -l dim (set_color brblack)
    set -l hl (set_color cyan)
    set -l n (set_color normal)
    switch "$argv[1]"
        case ''
            # up <rw|ro> <path>, the path last: a folder's name may have spaces.
            set -l state (string split -m 2 ' ' -- (__lend --again share))
            if test $state[1] != up
                __share_why $state[2..]
                return 1
            end
            set -l can 'to read and to write'
            test $state[2] = ro; and set can 'to read: this browser would not let it be written'
            echo '  '$hl$state[3]$n"  $can"
            echo $dim'  share off: let go of it; the folder stays as it is'$n
        case off
            set -l which
            if set -q argv[2]
                set -l asked (path resolve -- $argv[2])
                for file in /run/share/[0-9]*
                    read -l line <$file
                    test (string split -m 2 ' ' -- $line)[3] = $asked; and set which (path basename -- $file)
                end
                if not set -q which[1]
                    echo "share: $argv[2]: not a shared folder" >&2
                    return 1
                end
            end
            __let_go share $which
            echo $dim'  Let go.'$n
        case '*'
            echo 'share: usage: share [off [<folder>]]' >&2
            return 1
    end
end

function __share_why --argument-names why
    set -l text "Share error ($argv[2..])."
    switch $why
        case unsupported
            set text 'This browser cannot share a folder: Chrome and Edge can, on a computer.'
        case cancelled
            set text 'No folder was chosen.'
        case big
            set text 'That folder holds more than 100,000 things: share a part of it.'
        case silent
            set text 'No answer from the page.'
        case off
            set text 'Let go of the folder.'
    end
    echo '  '$text >&2
end
