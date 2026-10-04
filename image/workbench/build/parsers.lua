-- Run with nvim --clean -l (Dockerfile): compiles the tree-sitter parsers
-- plugins.lua listed into the workbench's site directory, so none is built
-- on first use. Started clean, nothing else installs anything meanwhile.

local workbench = "/usr/share/nvim/workbench"
vim.opt.rtp:prepend(workbench .. "/lazy/nvim-treesitter")

local ts = require("nvim-treesitter")
ts.setup({ install_dir = workbench .. "/site" })

local wanted = vim.json.decode(table.concat(vim.fn.readfile("/tmp/parsers.json"), "\n"))
if not ts.install(wanted, { summary = true }):wait(30 * 60 * 1000) then
  error("tree-sitter parsers did not finish building")
end

local built = ts.get_installed()
local missing = vim.tbl_filter(function(language)
  return not vim.list_contains(built, language)
end, wanted)
if #missing > 0 then
  error("tree-sitter parsers missing: " .. table.concat(missing, ", "))
end
print(("%d tree-sitter parsers built"):format(#wanted))
