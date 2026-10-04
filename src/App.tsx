import { AnimatePresence, domAnimation, LazyMotion, m, type Variants } from "motion/react";
import { Suspense, useState } from "react";
import type { MachineName } from "../vm.config.ts";
import { Boot } from "./components/Boot.tsx";
import { Drop } from "./components/Drop.tsx";
import { Keys } from "./components/Keys.tsx";
import { Screen } from "./components/Screen.tsx";
import { Terminal } from "./components/Terminal.tsx";
import { start, stop } from "./session.ts";
import { useMachine } from "./store.ts";
import { term } from "./terminal.ts";

/** Powering down: the picture collapses to a line, the line to a dot, and the dot fades. */
const picture: Variants = {
  on: { scaleX: 1, scaleY: 1, opacity: 1, filter: "brightness(1)", transition: { duration: 0 } },
  off: {
    scaleY: [1, 0.004, 0.004, 0.004],
    scaleX: [1, 1, 0.006, 0],
    filter: ["brightness(1)", "brightness(3)", "brightness(3)", "brightness(3)"],
    opacity: [1, 1, 1, 0],
    transition: { duration: 0.7, times: [0, 0.35, 0.75, 1], ease: "easeIn" },
  },
};

export default function App() {
  const machine = useMachine((state) => state.machine);
  const next = useMachine((state) => state.next);
  const failed = useMachine((state) => state.phase === "failed");
  const [booted, setBooted] = useState<MachineName>();

  // The guest asked for the other machine; once the picture is gone, switch.
  const switchOver = async () => {
    if (!next) return;
    await stop();
    start(next);
  };

  return (
    <LazyMotion features={domAnimation} strict>
      <div
        data-state={failed ? "failed" : booted === machine && !next ? "running" : "booting"}
        className="grid h-dvh grid-rows-[minmax(0,1fr)_auto] bg-black p-2.5 font-mono pointer-coarse:p-0"
      >
        <Screen>
          <m.div
            variants={picture}
            animate={next ? "off" : "on"}
            onAnimationComplete={(definition) => definition === "off" && void switchOver()}
            className="h-full"
          >
            <Suspense>
              <Terminal />
            </Suspense>
          </m.div>
          <AnimatePresence onExitComplete={() => term.focus()}>
            {booted !== machine && <Boot key={machine} onDone={() => setBooted(machine)} />}
          </AnimatePresence>
          <Drop />
        </Screen>
        <Keys />
      </div>
    </LazyMotion>
  );
}
