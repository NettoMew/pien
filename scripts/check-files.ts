// Takes files out of a machine as a visitor would, and shares a folder into
// it, through the page's own src/take.ts, src/zip.ts and src/share/. Only
// the browser is pretended: the save dialog of Chromium on a computer, which
// keeps what is written to it, and the download a phone gets instead; and a
// folder the visitor chooses, kept in memory as the origin private file
// system keeps one (scripts/lib/folder.ts). What is taken is dropped back
// into the guest, where Python's zipfile tests every CRC.
//
//   npm run check:files                  the home machine
//   npm run check:files -- workbench
//
// Checked: a file written a moment ago, saved as itself; a file in /tmp,
// which the page cannot read where it is; a directory, with one empty and a
// link in it, as a zip; several things at once; ZIP64, asked for early; a
// download, where there is no save dialog; and a visitor who saves nothing.
// Then a shared folder: listed and read; written, appended to, truncated,
// replaced as an editor saves; made in, moved within and removed from;
// moved into and out of; committed while still open; let go of, with every
// file of the folder still there; and one the browser lets only be read.

import { createHash } from "node:crypto";
import { ask, secret } from "../src/ask.ts";
import { put } from "../src/drop.ts";
import { share } from "../src/share/index.ts";
import { take } from "../src/take.ts";
import { type Entry, zip } from "../src/zip.ts";
import { PretendDirectory, PretendFile } from "./lib/folder.ts";
import { Checks, guest, sleep } from "./lib/guest.ts";
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
/** The folder the visitor chooses when the page asks for one. */
let folder = new PretendDirectory("proj-folder", { "a.txt": "alpha\n", "b.txt": "beta\n", sub: { "c.txt": "gamma\n" }, empty: {} });
const window = globalThis as unknown as { showSaveFilePicker?: typeof showSaveFilePicker; showDirectoryPicker?: () => Promise<PretendDirectory> };
Object.assign(globalThis, { window: globalThis, document, FileSystemHandle: class { move() {} } });
window.showSaveFilePicker = showSaveFilePicker;
window.showDirectoryPicker = async () => folder;

const { name, machine, run } = await guest((verb, fields, machine) => {
  // The page knows more topics; this knows the one it checks.
  if (verb === "ask") void ask(fields, machine, { take: async () => take });
  if (verb === "share") void share(fields[0] ?? "", machine, fields[1]);
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
declines = false;

step("a folder of the visitor's, shared");
const text = (path: string) => (folder.at(path) as PretendFile | undefined)?.text;
output = await run("share");
check("share", output.includes("/mnt/proj-folder") && output.includes("to read and to write"), output.split("\n")[0]);
output = await run("find /mnt/proj-folder | sort | string join ' '; cat /mnt/proj-folder/sub/c.txt");
check("listed, and read", output === "/mnt/proj-folder /mnt/proj-folder/a.txt /mnt/proj-folder/b.txt /mnt/proj-folder/empty /mnt/proj-folder/sub /mnt/proj-folder/sub/c.txt\ngamma", output.split("\n").join(" · "));

step("written back as the guest writes");
await run("echo hello > /mnt/proj-folder/new.txt; echo again > /mnt/proj-folder/a.txt; echo more >> /mnt/proj-folder/a.txt");
check("a new file, one overwritten, one appended to", text("new.txt") === "hello\n" && text("a.txt") === "again\nmore\n", JSON.stringify([text("new.txt"), text("a.txt")]));
output = await run("head -c 3000000 /dev/urandom > /tmp/big; cp /tmp/big /mnt/proj-folder/big.bin; md5sum < /tmp/big");
const big = folder.at("big.bin") as PretendFile | undefined;
check("3 MB, written as it comes", !!big && output.startsWith(md5(big.bytes)), `${big?.bytes.length ?? 0} bytes, committed ${big?.commits ?? 0} times`);
await run(": > /mnt/proj-folder/b.txt");
check("truncated", text("b.txt") === "", JSON.stringify(text("b.txt")));
// As an editor saves: the new text beside the old, then over it.
await run("printf 'saved anew' > /mnt/proj-folder/.a.txt.tmp; mv /mnt/proj-folder/.a.txt.tmp /mnt/proj-folder/a.txt");
await sleep(300);
check("replaced, as an editor saves", text("a.txt") === "saved anew" && !folder.at(".a.txt.tmp"), JSON.stringify(text("a.txt")));

step("made in, moved within, removed from");
await run("mkdir /mnt/proj-folder/d; mv /mnt/proj-folder/new.txt /mnt/proj-folder/d/moved.txt; mv /mnt/proj-folder/d /mnt/proj-folder/d2; rm /mnt/proj-folder/b.txt; rmdir /mnt/proj-folder/empty");
await sleep(300);
check("a directory made, a file moved into it, the directory renamed", text("d2/moved.txt") === "hello\n" && !folder.at("new.txt") && !folder.at("d"), [...folder.children.keys()].join(" "));
check("a file and a directory removed", !folder.at("b.txt") && !folder.at("empty"), [...folder.children.keys()].join(" "));

step("moved into it, and out of it");
output = await run("printf outside > ~/outside.txt; mv ~/outside.txt /mnt/proj-folder/; mv /mnt/proj-folder/sub/c.txt ~/; cat ~/c.txt");
await sleep(300);
check("in, and out, as between filesystems", text("outside.txt") === "outside" && !folder.at("sub/c.txt") && output === "gamma", JSON.stringify([text("outside.txt"), output]));

step("committed while still open");
// Written, and kept open: the guest's writeback brings it out in two
// seconds or so, and two more without a write commit it.
await run("sh -c 'exec 3> /mnt/proj-folder/live.txt; printf one >&3; sleep 12' &; disown");
await sleep(500);
const early = text("live.txt");
await sleep(7000);
check("after a quiet while, though still open", early === "" && text("live.txt") === "one", JSON.stringify([early, text("live.txt")]));
await sleep(5000);

step("let go of");
output = await run("share off; test -e /mnt/proj-folder; or echo gone");
check("share off: gone from the guest", output.endsWith("gone"), output.split("\n").join(" · "));
check("and every file of the folder still there", text("a.txt") === "saved anew" && text("d2/moved.txt") === "hello\n" && text("outside.txt") === "outside" && !!folder.at("big.bin") && text("live.txt") === "one", [...folder.children.keys()].join(" "));

step("a folder the browser lets only be read");
folder = new PretendDirectory("read-only", { "r.txt": "read me\n" });
folder.allows = "read";
output = await run("share; cat /mnt/read-only/r.txt; touch /mnt/read-only/x 2>&1; share off");
check("read, not written", output.includes("to read: this browser") && output.includes("read me") && output.includes("Permission denied") && !folder.at("x"), output.split("\n").slice(0, 3).join(" · "));

await machine.destroy();
checks.done();
