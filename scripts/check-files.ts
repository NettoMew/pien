// Takes files out of a machine as a visitor would, and checks what arrives,
// through the page's own src/take.ts and src/zip.ts. Only the browser is
// pretended: the save dialog of Chromium on a computer, which keeps what is
// written to it, and the download a phone gets instead. What arrives is
// dropped back into the guest, where Python's zipfile tests every CRC.
//
//   npm run check:files                  the home machine
//   npm run check:files -- workbench
//
// Checked: a file written a moment ago, saved as itself; a file in /tmp,
// which the page cannot read where it is; a directory, with one empty and a
// link in it, as a zip; several things at once; ZIP64, asked for early; a
// download, where there is no save dialog; and a visitor who saves nothing.

import { createHash } from "node:crypto";
import { ask, secret } from "../src/ask.ts";
import { put } from "../src/drop.ts";
import { take } from "../src/take.ts";
import { type Entry, zip } from "../src/zip.ts";
import { Checks, guest } from "./lib/guest.ts";
import { info, step } from "./lib/log.ts";

const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");

/** What the visitor saved last: its name, and its bytes. */
let saved: { name: string; bytes: Uint8Array<ArrayBuffer> } | undefined;
/** The same, as it stands now: a callback sets it, where the compiler cannot see. */
const last = () => saved;
/** Whether the visitor closes the save dialog without saving. */
let declines = false;

/** Chromium's save dialog on a computer: the name it suggested, and what is written to the file. */
async function showSaveFilePicker({ suggestedName = "" } = {}) {
  if (declines) throw new DOMException("The user aborted a request.", "AbortError");
  const chunks: Uint8Array[] = [];
  return {
    async createWritable() {
      return {
        async write(chunk: Uint8Array) {
          chunks.push(chunk.slice());
        },
        async close() {
          saved = { name: suggestedName, bytes: new Uint8Array(Buffer.concat(chunks)) };
        },
        async abort() {},
      };
    },
  };
}

/** A page's document, as far as a download goes: a link clicked, its blob fetched. */
const document = {
  createElement: () => ({
    href: "",
    download: "",
    click() {
      void (async () => (saved = { name: this.download, bytes: new Uint8Array(await (await fetch(this.href)).arrayBuffer()) }))();
    },
  }),
};
const window = globalThis as unknown as { showSaveFilePicker?: typeof showSaveFilePicker };
Object.assign(globalThis, { window: globalThis, document });
window.showSaveFilePicker = showSaveFilePicker;

const { name, machine, run } = await guest((verb, fields, machine) => {
  // The page knows more topics; this knows the one it checks.
  if (verb === "ask") void ask(fields, machine, { take: async () => take });
});
machine.control(`ask ${secret}`);
const checks = new Checks();
const check = checks.check.bind(checks);

/** Puts what was saved back into the guest's ~/drop, and says where. */
async function back(): Promise<string> {
  const { name, bytes } = saved!;
  await run("echo none > /run/drop/state");
  put([new File([bytes], name)], machine);
  await run("while test (cat /run/drop/state) = none; sleep 0.1; end");
  return `~/drop/${name}`;
}

step(`the ${name} machine`);
let output = await run("printf 'zutto issho' > ~/note.txt; take ~/note.txt");
check("a file written a moment ago, as itself", saved?.name === "note.txt" && new TextDecoder().decode(saved.bytes) === "zutto issho", output);
output = await run("head -c 3000000 /dev/urandom > /tmp/blob.bin; md5sum < /tmp/blob.bin; take /tmp/blob.bin");
check("a file in /tmp, the guest's memory alone", output.startsWith(md5(saved!.bytes)) && saved!.name === "blob.bin", output.split("\n").at(-1));

step("a directory, as a zip");
await run("mkdir -p ~/proj/src ~/proj/empty; echo a > ~/proj/a.txt; echo b > ~/proj/src/b.txt; ln -sf a.txt ~/proj/link");
output = await run("take ~/proj");
check("take ~/proj", saved?.name === "proj.zip", output);
let zipped = await back();
output = await run(`python3 -m zipfile -t ${zipped}; python3 -m zipfile -l ${zipped} | awk '{print $1}' | sort | string join ' '`);
check("every CRC holds", output.includes("Done testing"), output.split("\n")[0]);
check("every entry is there", output.endsWith("proj/ proj/a.txt proj/empty/ proj/link proj/src/ proj/src/b.txt"), output.split("\n").at(-1));
output = await run(
  `python3 -c "import zipfile; z = zipfile.ZipFile('${zipped.replace("~", "/home/guest")}'); print(z.read('proj/src/b.txt').decode().strip(), oct(z.getinfo('proj/link').external_attr >> 16), z.read('proj/link').decode())"`,
);
check("contents, and the link as a link", output === "b 0o120777 a.txt", output);

step("several things at once");
output = await run("take ~/note.txt /tmp/blob.bin ~/proj/src");
zipped = await back();
output = await run(`python3 -m zipfile -t ${zipped}; python3 -m zipfile -l ${zipped} | awk 'NR > 1 {print $1}' | string join ' '`);
check("one zip, named for when", /^take-\d{8}-\d{6}\.zip$/.test(saved!.name) && output.endsWith("note.txt blob.bin src/ src/b.txt"), `${saved!.name} · ${output.split("\n").at(-1)}`);

step("ZIP64, asked for early");
const data = new TextEncoder().encode("wide enough");
const entries: Entry[] = [
  { name: "big/", mode: 0o040755, mtime: 1e9, size: 0, read: async function* () {} },
  { name: "big/data.txt", mode: 0o100644, mtime: 1e9, size: data.length, read: async function* () { yield data; } },
];
const chunks: Uint8Array[] = [];
await zip(entries, async (chunk) => void chunks.push(chunk.slice()), 1);
saved = { name: "wide.zip", bytes: new Uint8Array(Buffer.concat(chunks)) };
zipped = await back();
output = await run(`python3 -m zipfile -t ${zipped}; python3 -c "import zipfile; print(zipfile.ZipFile('/home/guest/drop/wide.zip').read('big/data.txt').decode())"`);
check("Python reads it", output.includes("Done testing") && output.endsWith("wide enough"), output.split("\n").join(" · "));

step("without a save dialog: a download");
delete window.showSaveFilePicker;
saved = undefined;
output = await run("take ~/note.txt");
await new Promise((resolve) => setTimeout(resolve, 200));
const downloaded = last();
check("downloaded as itself", downloaded?.name === "note.txt" && new TextDecoder().decode(downloaded.bytes) === "zutto issho", output);
window.showSaveFilePicker = showSaveFilePicker;

step("a visitor who saves nothing");
declines = true;
output = await run("take ~/note.txt; echo status $status; ls ~/.cache/take | count");
check("not saved, said so, and nothing left behind", output.includes("Not saved.") && output.includes("status 1") && output.endsWith("0"), output.split("\n").join(" · "));
info("every save went through src/take.ts, as the page runs it");

await machine.destroy();
checks.done();
