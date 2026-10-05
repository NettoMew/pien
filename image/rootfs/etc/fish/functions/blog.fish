function blog --description 'The posts; and, for the owner, writing them'
    set -l dim (set_color brblack)
    set -l hl (set_color cyan)
    set -l n (set_color normal)
    set -l name $argv[2]

    switch "$argv[1]"
        case ''
            __blog_list
        case new edit
            __blog_name $name; or return 1
            __blog_edit $name
        case drafts
            set -l rows (__ask blog drafts); or return 1
            if not set -q rows[1]
                echo $dim'  No drafts.'$n
                return
            end
            echo
            for row in $rows
                set -l field (string split \t -- $row)
                printf '  %s%s%s  %s%s  saved %s%s\n' $hl $field[1] $n $field[2] $dim $field[3] $n
            end
            echo
        case publish
            __blog_name $name; or return 1
            sync
            echo $dim'  Publishing '$name' …'$n
            set -l url (__ask blog publish $name); or return 1
            rm -f ~/drafts/$name.md
            echo '  '$hl'Published'$n': blog/'$name'.md, and on the web at'
            echo '  '$url
        case withdraw
            __blog_name $name; or return 1
            __ask blog withdraw $name; or return 1
            echo $dim'  Taken down; a draft again: blog edit '$name$n
        case '*'
            echo 'blog: usage: blog [edit <name> | drafts | publish <name> | withdraw <name>]' >&2
            return 1
    end
end

# The posts, newest first, as /usr/share/home/posts lists them.
function __blog_list
    set -l dates
    set -l files
    set -l titles
    while read -l -d \t date file title
        set -a dates $date
        set -a files $file
        set -a titles $title
    end </usr/share/home/posts

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

# A post's name: what its file and its address on the web are called.
function __blog_name --argument-names name
    if not string match -qr '^[a-z0-9][a-z0-9-]*$' -- "$name"
        echo 'blog: a post'"'"'s name is lower-case letters, digits and dashes: blog edit my-post' >&2
        return 1
    end
end

# Writes ~/drafts/<name>.md in the editor: the draft here, or else the one on
# the server, or else the post, or else a new one; then keeps it on the
# server, with any pictures it shows.
function __blog_edit --argument-names name
    set -l dim (set_color brblack)
    set -l n (set_color normal)
    set -l file ~/drafts/$name.md
    mkdir -p ~/drafts
    if not test -e $file
        set -l text (__ask blog fetch $name)
        switch $status
            case 0
                printf '%s\n' $text | base64 -d >$file
            case 3 # a new one
                printf '%s\n' --- 'title: ' 'date: '(date +%F) 'tags: []' --- '' >$file
            case '*'
                return 1
        end
    end
    set -l editor $EDITOR
    set -q editor[1]; or set editor edit
    $editor $file; or return 1

    sync
    echo $dim'  Keeping the draft on the server …'$n
    set -l sent (__ask blog save $name); or return 1
    # Its pictures went too, and are shown as ../media/<name> from now on.
    set -q sent[1]; and printf '%s\n' $sent | base64 -d >$file
    echo '  Kept. '$dim'blog publish '$name' puts it on the site.'$n
end
