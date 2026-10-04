// Files dragged over the page: the screen says where they will go, and once
// they are dropped, that they went. They land in the guest's ~/drop, read
// from the visitor's disk as they are used (drop.ts).

import { AnimatePresence, m } from "motion/react";
import { useEffect, useState } from "react";
import { dropFiles } from "../session.ts";

/** How long the note that files went in stays up, in milliseconds. */
const NOTE = 3000;

const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;

/** A drop's files, folders left out. */
function filesOf(transfer: DataTransfer): File[] {
  return [...transfer.items].flatMap((item) => {
    if (item.kind !== "file" || item.webkitGetAsEntry()?.isDirectory) return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

export function Drop() {
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<{ text: string; at: number }>();

  useEffect(() => {
    // Entering a child of the page leaves its parent first: count, rather than toggle.
    let depth = 0;
    const handlers = {
      dragenter(event: DragEvent) {
        depth++;
        setOver(true);
        event.preventDefault();
      },
      dragover(event: DragEvent) {
        event.preventDefault();
        event.dataTransfer!.dropEffect = "copy";
      },
      dragleave() {
        depth = Math.max(0, depth - 1);
        if (!depth) setOver(false);
      },
      drop(event: DragEvent) {
        // Left to itself, the browser would open the file in place of the page.
        event.preventDefault();
        depth = 0;
        setOver(false);
        const files = filesOf(event.dataTransfer!);
        if (!files.length) return;
        const what = files.length === 1 ? files[0]!.name : `${files.length} files`;
        setNote({ text: dropFiles(files) ? `${what} → ~/drop` : "The machine is not up yet.", at: Date.now() });
      },
    };
    const listeners = Object.entries(handlers).map(([type, handle]) => {
      const listener = (event: DragEvent) => carriesFiles(event) && handle(event);
      window.addEventListener(type as "drop", listener);
      return () => window.removeEventListener(type as "drop", listener);
    });
    return () => listeners.forEach((remove) => remove());
  }, []);

  useEffect(() => {
    if (!note) return;
    const fade = setTimeout(() => setNote(undefined), NOTE);
    return () => clearTimeout(fade);
  }, [note]);

  return (
    <AnimatePresence>
      {over && (
        <m.div
          key="over"
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/75 p-6"
        >
          <div className="grid size-full place-content-center gap-2 rounded-[20px] border-2 border-dashed border-cyan/50 text-center">
            <p className="phosphor text-[19px] text-cyan max-sm:text-[16px]">Drop into ~/drop</p>
            <p className="phosphor text-[13px] text-faint">read from your disk as it is used, never copied</p>
          </div>
        </m.div>
      )}
      {note && (
        <m.p
          key={note.at}
          role="status"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="phosphor pointer-events-none absolute right-6 bottom-5 z-20 max-w-[80%] truncate text-[13px] text-faint"
        >
          {note.text}
        </m.p>
      )}
    </AnimatePresence>
  );
}
