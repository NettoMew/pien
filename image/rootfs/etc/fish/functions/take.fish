function take --description "Saves files from here onto this computer: take <file|directory>…"
    if not set -q argv[1]
        echo 'take: usage: take <file|directory>…' >&2
        return 1
    end
    for given in $argv
        if not test -e $given
            echo "take: $given: no such file or directory" >&2
            return 1
        end
    end
    set -l work ~/.cache/take/(random 1 2147483647)
    mkdir -p $work
    __take_list $work $argv
    and begin
        # The page reads the files where they are: written lately, they may
        # still be in the guest's memory alone.
        sync
        set -l first (path resolve -- $argv[1])
        if not set -q argv[2]; and test -f $first
            __ask take $work/list file (path basename -- $first)
        else if not set -q argv[2]
            __ask take $work/list zip (path basename -- $first).zip
        else
            __ask take $work/list zip take-(date +%Y%m%d-%H%M%S).zip
        end
    end
    set -l done $status
    rm -rf $work
    return $done
end

# Lists what to take in <work>/list for the page (src/take.ts): each file,
# directory and link, by its name in the zip, with where to read it, or what
# it points to. What is not on the filesystem the page reads, 9p (/tmp, say,
# which is the guest's memory alone), is copied there first, whole.
function __take_list --argument-names work
    set -l list $work/list
    printf '' >$list
    for given in $argv[2..]
        set -l path (path resolve -- $given)
        set -l base (path basename -- $path)
        if test (stat -f -c %t $path) != 1021997
            set -l copy (mktemp -d -p $work)
            cp -a $path $copy/; or return 1
            set path $copy/$base
        end
        for entry in (find $path -print0 | string split0)
            set -l name $base(string replace -- $path '' $entry)
            if test -L $entry
                printf 'l\0%s\0%s\0' $name (readlink $entry) >>$list
            else if test -d $entry
                printf 'd\0%s/\0%s\0' $name $entry >>$list
            else if test -f $entry -a -r $entry
                printf 'f\0%s\0%s\0' $name $entry >>$list
            else
                echo "take: $entry: not a file this can read; left out" >&2
            end
        end
    end
end
