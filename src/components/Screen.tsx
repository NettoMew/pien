import type { ReactNode } from "react";

/** The tube and the glass in front of it; whatever is on screen sits between the two. */
export function Screen({ children }: { children: ReactNode }) {
  return (
    <main
      aria-label="Terminal"
      className="crt-screen relative isolate overflow-clip rounded-[28px] pointer-coarse:rounded-t-none pointer-coarse:rounded-b-[22px]"
    >
      {children}
      <div aria-hidden className="crt-glass pointer-events-none absolute inset-0 rounded-[inherit]" />
    </main>
  );
}
