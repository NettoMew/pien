-- On top of LazyVim's own (lazyvim/config/options.lua).

-- The terminal is a browser tab. Yanks go through it to the visitor's own
-- clipboard (OSC 52); it never hands the clipboard back, so a paste here is
-- of what was yanked here, and text from outside comes in as the terminal
-- pastes it (Ctrl+Shift+V).
local osc52 = require("vim.ui.clipboard.osc52")
local function yanked()
  return { vim.fn.split(vim.fn.getreg(""), "\n"), vim.fn.getregtype("") }
end
vim.g.clipboard = {
  name = "OSC 52",
  copy = { ["+"] = osc52.copy("+"), ["*"] = osc52.copy("*") },
  paste = { ["+"] = yanked, ["*"] = yanked },
}

vim.g.lazyvim_python_lsp = "pyright"
vim.g.lazyvim_python_ruff = "ruff"
