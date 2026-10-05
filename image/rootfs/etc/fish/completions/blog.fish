set -l verbs edit drafts publish withdraw
complete -c blog -f
complete -c blog -n "not __fish_seen_subcommand_from $verbs new" -a edit -d 'Write a post, new or not'
complete -c blog -n "not __fish_seen_subcommand_from $verbs new" -a drafts -d 'The drafts on the server'
complete -c blog -n "not __fish_seen_subcommand_from $verbs new" -a publish -d 'Put a draft on the site'
complete -c blog -n "not __fish_seen_subcommand_from $verbs new" -a withdraw -d 'Take a post down'
complete -c blog -n '__fish_seen_subcommand_from edit publish' -a '(path change-extension "" ~/drafts/*.md | path basename)' -d draft
complete -c blog -n '__fish_seen_subcommand_from edit withdraw' -a '(path change-extension "" ~/blog/*.md | path basename)' -d post
