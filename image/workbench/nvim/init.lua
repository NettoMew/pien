-- The workbench's Neovim: LazyVim, with every plugin, parser and language
-- server put on the toolchain disk ahead of time (image/workbench/Dockerfile),
-- so nothing is fetched or compiled when someone opens it. The disk is
-- read-only underneath; what Neovim writes goes to ~/.local and ~/.cache.

local here = vim.fs.dirname(debug.getinfo(1, "S").source:sub(2))
local lazypath = here .. "/lazy/lazy.nvim"

-- Only ever missing while the disk is being built.
if not vim.uv.fs_stat(lazypath) then
  local out = vim.fn.system({ "git", "clone", "--filter=blob:none", "--branch=stable", "https://github.com/folke/lazy.nvim.git", lazypath })
  if vim.v.shell_error ~= 0 then
    error("could not fetch lazy.nvim:\n" .. out)
  end
end

vim.opt.rtp:prepend(here)
vim.opt.rtp:prepend(lazypath)

-- lazy.nvim times itself with clock_gettime through LuaJIT's FFI, declaring
-- a 32-bit time_t. musl on i686 has a 64-bit one, so the call writes past
-- the struct and Neovim falls over moments later. libuv tells the same CPU
-- time without guessing at the layout.
require("lazy.stats").cputime = function()
  local usage = vim.uv.getrusage()
  return (usage.utime.sec + usage.stime.sec) * 1e3 + (usage.utime.usec + usage.stime.usec) / 1e3
end

require("lazy").setup({
  root = here .. "/lazy",
  lockfile = here .. "/lazy-lock.json",
  spec = {
    { "LazyVim/LazyVim", import = "lazyvim.plugins" },
    { import = "lazyvim.plugins.extras.lang.clangd" },
    { import = "lazyvim.plugins.extras.lang.rust" },
    { import = "lazyvim.plugins.extras.lang.go" },
    { import = "lazyvim.plugins.extras.lang.python" },
    { import = "lazyvim.plugins.extras.lang.typescript" },
    { import = "lazyvim.plugins.extras.lang.json" },
    { import = "lazyvim.plugins.extras.lang.yaml" },
    { import = "lazyvim.plugins.extras.lang.toml" },
    { import = "lazyvim.plugins.extras.lang.markdown" },
    { import = "lazyvim.plugins.extras.lang.git" },
    { import = "lazyvim.plugins.extras.dap.core" },
    { import = "lazyvim.plugins.extras.formatting.prettier" },
    { import = "plugins" },
  },
  defaults = { lazy = false, version = false },
  -- Installs what is missing — which, once the disk is built, is nothing.
  install = { missing = true, colorscheme = { "tokyonight" } },
  checker = { enabled = false },
  change_detection = { enabled = false },
  rocks = { enabled = false },
  performance = {
    -- lazy.nvim resets the runtimepath; this directory, with lua/plugins in
    -- it, has to stay.
    rtp = { paths = { here }, disabled_plugins = { "gzip", "tarPlugin", "tohtml", "tutor", "zipPlugin" } },
  },
})
