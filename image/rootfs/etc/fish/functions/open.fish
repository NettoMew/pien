function open --description 'Open a post (as a web page) or a link in a new browser tab' --argument-names target
    set -l url
    if string match -qr '^https?://\S+$' -- $target
        set url $target
    else if test -f "$target"; and string match -qr '^/home/guest/blog/[^/]+\.md$' -- (realpath -- $target)
        set url /blog/(basename -- $target .md)/
    else
        echo 'open: only posts (blog/*.md) and http(s) links' >&2
        return 1
    end
    # A private escape sequence; the page around this terminal acts on it.
    printf '\e]7337;open;%s\a' $url
end
