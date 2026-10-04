// Power on: a dot in the dark, a line, the raster opening over-bright. Then
// the machine reports in while its memory arrives, and the screen clears to
// the prompt. The machine loads alongside all of it, so the show costs a
// visitor nothing past its first second: a machine already up by then goes
// straight to its prompt.

import { m, useReducedMotion, useSpring, useTransform, type Variants } from "motion/react";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import manifest from "virtual:vm-manifest";
import { usableMemoryMB } from "../../vm.config.ts";
import { cold } from "../session.ts";
import { useMachine } from "../store.ts";

/** How long OK stays up before the screen clears, in milliseconds. */
const SETTLE = 400;

/** When the beam has swept to both edges and the raster starts to open, in seconds. */
const OPEN = 0.63;

/** The dot of light at the centre, before the beam sweeps out of it. */
const dot: Variants = {
  off: { opacity: 0, scale: 0 },
  on: { opacity: [0, 1, 1, 0], scale: [0, 1, 1, 0.5], transition: { delay: 0.15, duration: 0.25, times: [0, 0.15, 0.7, 1] } },
};

/** The beam: a sweep out of the dot to both edges by OPEN; then it opens out and is gone. */
const beam: Variants = {
  off: { scaleX: 0, opacity: 0 },
  on: {
    scaleX: [0, 1, 1],
    scaleY: [1, 1, 40],
    opacity: [1, 1, 0],
    transition: { delay: 0.3, duration: 0.66, times: [0, 0.5, 1], ease: "easeIn" },
  },
};

/** The raster, opening from the beam's line, over-bright until the phosphor settles. */
const raster: Variants = {
  off: { opacity: 0, scaleY: 0.004, filter: "brightness(3)" },
  on: {
    opacity: 1,
    scaleY: 1,
    filter: ["brightness(3)", "brightness(1.9)", "brightness(1)"],
    // A transition per value replaces the shared one whole, delay included.
    transition: {
      opacity: { delay: OPEN, duration: 0.01 },
      scaleY: { delay: OPEN, duration: 0.32, ease: "easeOut" },
      filter: { delay: OPEN, duration: 1.2, times: [0, 0.27, 1] },
    },
  },
};

/** Lines come up one after another, the way a terminal prints them. */
const report: Variants = { hidden: {}, shown: { transition: { staggerChildren: 0.06 } } };
const line: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: 0 } } };

export function Boot({ onDone }: { onDone: () => void }) {
  const running = useMachine((machine) => machine.phase === "running");
  const reduced = useReducedMotion();
  const [stage, setStage] = useState<"power" | "report" | "done">(reduced ? "report" : "power");
  const done = useEffectEvent(onDone);

  // Once the raster is open: straight to the prompt if the machine is up, else its report.
  const lit = () => setStage(useMachine.getState().phase === "running" ? "done" : "report");

  useEffect(() => {
    if (stage === "done") {
      done();
    } else if (stage === "report" && running) {
      const settle = setTimeout(() => setStage("done"), SETTLE);
      return () => clearTimeout(settle);
    }
  }, [stage, running]);

  return (
    <m.div
      role="status"
      aria-label="Starting the machine"
      className="absolute inset-0 z-10 bg-black"
      initial="off"
      animate="on"
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
    >
      <m.div variants={reduced ? undefined : raster} className="crt-screen absolute inset-0">
        {stage !== "power" && <Report />}
      </m.div>
      {!reduced && (
        <>
          <m.div variants={dot} className="crt-beam absolute top-1/2 left-1/2 size-1.5 -translate-1/2 rounded-full" />
          <m.div
            variants={beam}
            onAnimationComplete={(definition) => definition === "on" && lit()}
            className="crt-beam absolute inset-x-0 top-1/2 -mt-px h-0.5"
          />
        </>
      )}
    </m.div>
  );
}

/** What the machine is, then how far along its memory is. */
function Report() {
  const { phase, progress, missing } = useMachine();
  const facts: [string, ReactNode][] = [
    ["Kernel", `Linux ${manifest.kernel} · Alpine ${manifest.alpine}`],
    ["Memory", `${usableMemoryMB} MB`],
    ["Disk", "9p over HTTP, read on demand"],
    [
      "Network",
      <>
        off · <span className="text-cyan">net on</span>
      </>,
    ],
    ["Shell", `fish ${manifest.fish}`],
  ];

  return (
    <m.ol
      variants={report}
      initial="hidden"
      animate="shown"
      className="gutter text-[15px]/[1.3] whitespace-pre max-sm:text-[13px]/[1.3] [&_*]:phosphor"
    >
      <m.li variants={line} className="ps-[2ch] font-semibold">
        {manifest.hostname.toUpperCase()}
      </m.li>
      <m.li variants={line} className="ps-[2ch] text-faint">
        v86 · {manifest.arch} · WebAssembly
      </m.li>
      <m.li variants={line} className="h-[1.3em]" />
      {facts.map(([label, value]) => (
        <m.li key={label} variants={line} className="ps-[2ch]">
          <span className="inline-block w-[10ch] text-faint">{label}</span>
          {value}
        </m.li>
      ))}
      <m.li variants={line} className="h-[1.3em]" />
      <m.li variants={line} className="flex items-center gap-[2ch] ps-[2ch]">
        <span className="w-[18ch] text-faint">{cold ? "Loading the kernel" : "Restoring memory"}</span>
        <Meter value={progress} />
        {phase === "running" && <span className="text-green">OK</span>}
      </m.li>
      {missing && (
        <m.li variants={line} className="ps-[2ch] text-red">
          Could not load {missing}. Try reloading.
        </m.li>
      )}
    </m.ol>
  );
}

/** A bar of character cells and a percentage, both easing after the real count. */
function Meter({ value }: { value: number }) {
  const progress = useSpring(value, { stiffness: 120, damping: 24, restDelta: 0.001 });
  useEffect(() => progress.set(value), [progress, value]);
  const reveal = useTransform(progress, (p) => `inset(0 ${100 - p * 100}% 0 0)`);
  const percent = useTransform(progress, (p) => `${Math.round(p * 100)}%`);

  return (
    <>
      <span className="cells relative h-[11px] w-[40ch] text-line max-sm:w-[16ch]">
        <span className="phosphor-stroke absolute inset-0 text-yellow">
          <m.span style={{ clipPath: reveal }} className="cells absolute inset-0" />
        </span>
      </span>
      <m.span aria-hidden className="w-[4ch] text-yellow">
        {percent}
      </m.span>
    </>
  );
}
