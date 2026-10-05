function moments --description 'What has been happening'
    set -l dim (set_color brblack)
    set -l hl (set_color cyan)
    set -l n (set_color normal)

    switch "$argv[1]"
        case '' all
            # Newest first: their names are when they were posted.
            set -l files ~/moments/*.md
            set files (path sort -r -- $files)
            if not set -q files[1]
                echo $dim'  Nothing yet.'$n
                return
            end
            set -l shown $files
            test "$argv[1]" = all; or set shown $files[1..10]
            for file in $shown
                awk -v width=(math "min($COLUMNS - 2, 78)") -f /usr/libexec/home/md.awk -- $file
            end
            set -l more (math (count $files) - (count $shown))
            if test $more -gt 0
                echo $dim'  '$more' more: moments all'$n
                echo
            end
        case new
            # Written in ~/drafts/moment.md, and posted when the editor closes.
            set -l file ~/drafts/moment.md
            mkdir -p ~/drafts
            touch $file
            set -l editor $EDITOR
            set -q editor[1]; or set editor edit
            $editor $file; or return 1
            if not string length -q -- (string trim -- (cat $file))
                rm -f $file
                echo $dim'  Nothing to post.'$n
                return
            end
            read -l -P '  Post it? [Y/n] ' answer; or return 1
            if string match -qi 'n*' -- $answer
                echo $dim'  Kept in ~/drafts/moment.md; moments new goes on with it.'$n
                return
            end
            sync
            set -l id (__ask moments post); or return 1
            rm -f $file
            echo '  '$hl'Posted'$n': moments/'$id'.md'
        case delete
            set -l id $argv[2]
            if not test -e ~/moments/$id.md
                echo 'moments: usage: moments delete <name in ~/moments, without .md>' >&2
                return 1
            end
            __ask moments delete $id; or return 1
            echo $dim'  Deleted.'$n
        case '*'
            echo 'moments: usage: moments [all | new | delete <name>]' >&2
            return 1
    end
end
