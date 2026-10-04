import { AnimatePresence, domAnimation, LazyMotion } from "motion/react";
import { Suspense, useState } from "react";
import manifest from "virtual:vm-manifest";
import { Boot } from "./components/Boot.tsx";
import { Keys } from "./components/Keys.tsx";
import { Screen } from "./components/Screen.tsx";
import { Terminal } from "./components/Terminal.tsx";
import { useMachine } from "./store.ts";
import { term } from "./terminal.ts";

/** The site goes by its prompt's name. */
const SITE = `guest@${manifest.hostname}`;

export default function App() {
  const [booted, setBooted] = useState(false);
  const title = useMachine((machine) => machine.title);
  const failed = useMachine((machine) => machine.phase === "failed");

  return (
    <LazyMotion features={domAnimation} strict>
      <div
        data-state={failed ? "failed" : booted ? "running" : "booting"}
        className="grid h-dvh grid-rows-[minmax(0,1fr)_auto] bg-black p-2.5 font-mono pointer-coarse:p-0"
      >
        <title>{title ? `${title} — ${SITE}` : SITE}</title>
        <Screen>
          <Suspense>
            <Terminal />
          </Suspense>
          <AnimatePresence onExitComplete={() => term.focus()}>
            {!booted && <Boot key="boot" onDone={() => setBooted(true)} />}
          </AnimatePresence>
        </Screen>
        <Keys />
      </div>
    </LazyMotion>
  );
}
