complete -c moments -f
complete -c moments -n 'not __fish_seen_subcommand_from all new delete' -a all -d 'Every one'
complete -c moments -n 'not __fish_seen_subcommand_from all new delete' -a new -d 'Write one'
complete -c moments -n 'not __fish_seen_subcommand_from all new delete' -a delete -d 'Delete one'
complete -c moments -n '__fish_seen_subcommand_from delete' -a '(path change-extension "" ~/moments/*.md | path basename)'
