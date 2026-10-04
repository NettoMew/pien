import { use } from "react";
import { fonts, mount } from "../terminal.ts";

/**
 * Where the terminal sits on the screen, every glyph of it phosphor. The
 * margin goes on a frame around it: xterm.js fits itself to its parent's
 * height, padding and all.
 */
export function Terminal() {
  use(fonts);
  return (
    <div className="gutter h-full pb-2.5">
      <div
        ref={mount}
        className="h-full [&_.xterm]:h-full [&_.xterm-rows_span]:phosphor [&_.xterm-scrollable-element]:bg-transparent! [&_.xterm-viewport]:bg-transparent!"
      />
    </div>
  );
}
