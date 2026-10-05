# Asks the page around this terminal (src/ask.ts), and waits for its answer:
#
#   __ask <topic> <word> …
#
# What the page says is printed line by line, on stdout if it said yes (0)
# or asked for one thing more (3), on stderr if no; its status is ours.
# Asking takes the secret hostd keeps for the guest's own commands, so text
# that merely passes through the terminal cannot ask anything.
function __ask --description 'Ask the page around this terminal'
    set -l secret (cat /run/ask/secret 2>/dev/null)
    if test -z "$secret"
        echo '  No page around this terminal to ask.' >&2
        return 1
    end
    set -l id (random 1 2147483647)
    set -l answer /run/ask/$id
    # To the terminal itself, however this function's output is taken.
    printf '\e]7337;ask;%s;%s%s\a' $secret $id (printf ';%s' (string escape --style=url -- $argv)) >/dev/tty

    # Five minutes: a passkey, or GitHub, may take a while.
    for i in (seq 3000)
        if test -e $answer.done
            read -l code <$answer.done
            set -l lines
            test -e $answer; and set lines (cat $answer)
            rm -f $answer $answer.done
            if set -q lines[1]
                if contains -- $code 0 3
                    printf '%s\n' $lines
                else
                    printf '  %s\n' $lines >&2
                end
            end
            return $code
        end
        sleep 0.1
    end
    echo '  No answer from the page.' >&2
    return 1
end
