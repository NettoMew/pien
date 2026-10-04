" The workbench's Neovim (image/workbench/nvim/): LazyVim, set up ahead of
" time, for anyone who has no configuration of their own.
let s:config = stdpath('config')
if !filereadable(s:config . '/init.lua') && !filereadable(s:config . '/init.vim')
  lua dofile('/usr/share/nvim/workbench/init.lua')
endif
