-- Run with the workbench's configuration once the plugins are in (Dockerfile):
-- checks that every one arrived and built, and writes out the parsers LazyVim
-- and its extras ask for, for parsers.lua to compile. Any failure fails the
-- build: Neovim leaves with a non-zero status.

local function check()
  local plugins = require("lazy.core.config").plugins
  local missing = vim.tbl_filter(function(name)
    return not plugins[name]._.installed
  end, vim.tbl_keys(plugins))
  assert(#missing == 0, "plugins not installed: " .. table.concat(missing, ", "))

  -- blink.cmp's matcher is the one plugin compiled here rather than fetched.
  local blink = plugins["blink.cmp"]
  assert(
    not blink or #vim.fn.glob(blink.dir .. "/target/release/libblink_cmp_fuzzy.*", true, true) > 0,
    "blink.cmp's fuzzy matcher was not built"
  )

  -- Working out nvim-treesitter's options hands over the list (see
  -- lua/plugins/workbench.lua).
  LazyVim.opts("nvim-treesitter")
  local parsers = vim.fn.uniq(vim.fn.sort(vim.g.workbench_parsers or {}))
  assert(#parsers > 0, "LazyVim asked for no parsers")
  vim.fn.writefile({ vim.json.encode(parsers) }, "/tmp/parsers.json")
  print(("%d plugins in place, %d parsers to build"):format(vim.tbl_count(plugins), #parsers))
end

local ok, problem = xpcall(check, debug.traceback)
if not ok then
  io.stderr:write(problem .. "\n")
  vim.cmd.cquit(1)
end
