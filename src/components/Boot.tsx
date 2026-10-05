// Power on: a dot in the dark, a line, the raster opening over-bright. Then a
// boot log scrolls past (../boot-log.ts), made up but paced by the real thing:
// each line stands for its share of what the machine has to fetch, so the log
// runs out as the machine comes up, and its last service is OK once the
// machine is at its prompt. The machine loads alongside all of it, so the show
// costs a visitor nothing past its first second: a machine already up by then
// goes straight to its prompt.

import { m, useMotionValueEvent, useReducedMotion, useSpring, type Variants } from "motion/react";
import { type RefObject, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import manifest from "virtual:vm-manifest";
import { machines } from "../../vm.config.ts";
import { bootLog, type LogLine } from "../boot-log.ts";
import { cold } from "../session.ts";
import { useMachine } from "../store.ts";

/** How long the finished log stays up before the screen clears, in milliseconds. */
const SETTLE = 420;

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

export function Boot({ onDone }: { onDone: () => void }) {
  const reduced = useReducedMotion();
  const [stage, setStage] = useState<"power" | "log" | "done">(reduced ? "log" : "power");
  const done = useEffectEvent(onDone);

  // Once the raster is open: straight to the prompt if the machine is up, else its log.
  const lit = () => setStage(useMachine.getState().phase === "running" ? "done" : "log");

  useEffect(() => {
    if (stage === "done") done();
  }, [stage]);

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
        {stage !== "power" && <Log onEnd={() => setStage("done")} />}
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

/**
 * The log as far as the machine has got, printed top down until the screen
 * is full and scrolling after that. The count eases after the real progress,
 * so lines run rather than jump; `onEnd` once the last is up and OK.
 */
function Log({ onEnd }: { onEnd: () => void }) {
  const { machine, phase, progress, problem } = useMachine();
  const [lines] = useState(() =>
    bootLog({ kernel: manifest.kernel, hostname: manifest.hostname, memoryMB: machines[machine].memoryMB, cold }),
  );

  const eased = useSpring(0, { stiffness: 120, damping: 24, restDelta: 0.001 });
  const [shown, setShown] = useState(0);
  useEffect(() => eased.set(phase === "running" ? 1 : progress), [eased, phase, progress]);
  useMotionValueEvent(eased, "change", (value) => setShown(Math.min(lines.length, Math.ceil(value * lines.length))));

  const end = useEffectEvent(onEnd);
  const finished = phase === "running" && shown === lines.length;
  useEffect(() => {
    if (!finished) return;
    const settle = setTimeout(end, SETTLE);
    return () => clearTimeout(settle);
  }, [finished]);

  const screen = useRef<HTMLOListElement>(null);
  const rows = useRows(screen);
  const status = phase === "running" ? "ok" : phase === "failed" ? "failed" : "pending";
  const printed = lines.slice(0, shown).map((line, at) => (
    <Line key={at} line={line} status={at === lines.length - 1 ? status : "ok"} />
  ));
  if (problem) printed.push(<li key="problem" className="text-red">{problem}</li>);

  return (
    <>
      <ol ref={screen} aria-hidden className="gutter h-full overflow-hidden text-[15px]/[1.3em] whitespace-pre max-sm:text-[13px]/[1.3em] [&_*]:phosphor">
        {printed.slice(-rows)}
      </ol>
      {problem && <p className="sr-only">{problem}</p>}
    </>
  );
}

function Line({ line, status }: { line: LogLine; status: "ok" | "failed" | "pending" }) {
  if (line.kind === "kernel") {
    return (
      <li className={`overflow-hidden ${line.warning ? "text-yellow" : "text-white"}`}>
        <span className="text-faint">[{line.time.toFixed(6).padStart(12)}]</span> {line.text}
      </li>
    );
  }
  return (
    <li className="flex max-w-[78ch] justify-between gap-[2ch]">
      <span className="min-w-0 overflow-hidden">
        <span className="text-green"> * </span>
        {line.text}
      </span>
      {status === "ok" && (
        <span>
          [ <span className="text-green">ok</span> ]
        </span>
      )}
      {status === "failed" && (
        <span>
          [ <span className="text-red">!!</span> ]
        </span>
      )}
    </li>
  );
}

/** How many whole lines fit in `box`, kept up to date as it resizes. */
function useRows(box: RefObject<HTMLElement | null>) {
  const [rows, setRows] = useState(Infinity);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      setRows(Math.max(1, Math.floor(height / parseFloat(style.lineHeight))));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box]);
  return rows;
}
