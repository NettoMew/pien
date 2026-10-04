-- What the workbench changes in LazyVim: tools come from the toolchain disk
-- rather than from Mason, and the colours from the terminal.

local here = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, "S").source:sub(2))))

return {
  -- Grok Night, the terminal's palette, is tokyonight's night on a darker
  -- ground. The editor leaves the ground to the screen behind it.
  {
    "folke/tokyonight.nvim",
    opts = {
      style = "night",
      transparent = true,
      styles = { sidebars = "transparent", floats = "dark" },
      on_colors = function(colors)
        colors.bg_dark = "#0a0a0a"
        colors.bg_float = "#0a0a0a"
        colors.bg_popup = "#0a0a0a"
        colors.bg_statusline = "#0a0a0a"
      end,
    },
  },
  { "catppuccin/nvim", name = "catppuccin", enabled = false },

  -- Every language server, formatter, linter and debugger is on the disk
  -- already, put there by apk, npm, go and pip.
  { "mason-org/mason.nvim", enabled = false },
  { "mason-org/mason-lspconfig.nvim", enabled = false },
  { "jay-babu/mason-nvim-dap.nvim", enabled = false },

  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        bashls = {},
        -- marksman is a .NET program, and there is no .NET for this machine.
        marksman = { enabled = false },
      },
    },
  },

  -- Parsers beside the plugins, compiled when the disk was built — by
  -- build/parsers.lua, in a Neovim of its own. While the disk is being built
  -- (g:workbench_build), LazyVim only hands over the list.
  {
    "nvim-treesitter/nvim-treesitter",
    opts = function(_, opts)
      opts.install_dir = here .. "/site"
      if vim.g.workbench_build then
        vim.g.workbench_parsers = opts.ensure_installed
        opts.ensure_installed = {}
      end
    end,
  },

  -- blink.cmp's fuzzy matcher, built here for i686: no prebuilt one exists.
  { "saghen/blink.cmp", build = "cargo build --release" },

  -- There is no browser inside the machine to preview Markdown in.
  { "iamcco/markdown-preview.nvim", enabled = false },

  -- gdb speaks the Debug Adapter Protocol itself: C, C++ and Rust.
  {
    "mfussenegger/nvim-dap",
    opts = function()
      local dap = require("dap")
      dap.adapters.gdb = { type = "executable", command = "gdb", args = { "--interpreter=dap", "--quiet" } }
      for _, language in ipairs({ "c", "cpp", "rust" }) do
        dap.configurations[language] = {
          {
            name = "Launch (gdb)",
            type = "gdb",
            request = "launch",
            program = function()
              return vim.fn.input("Program: ", vim.fn.getcwd() .. "/", "file")
            end,
            cwd = "${workspaceFolder}",
          },
        }
      end
    end,
  },

  -- debugpy is installed system-wide, next to the python that runs it.
  {
    "mfussenegger/nvim-dap-python",
    config = function()
      require("dap-python").setup("python3")
    end,
  },
}
