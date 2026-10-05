// Just enough of apk to install Alpine packages without running Alpine:
// read the repository index, resolve dependencies, download and unpack.

import { gunzipSync } from "node:zlib";
import { readTar, type TarEntry } from "./tar.ts";
import { cached } from "./fetch.ts";

export interface Package {
  name: string;
  version: string;
  repo: string;
  size: number;
  priority: number;
  depends: string[];
  provides: string[];
  /** Installed of itself once all of these are (apk's install_if): a package's -pyc, say, with pyc. */
  installIf: string[];
}

function parseIndex(text: string, repo: string): Package[] {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const pkg: Package = { name: "", version: "", repo, size: 0, priority: 0, depends: [], provides: [], installIf: [] };
      for (const line of block.split("\n")) {
        const value = line.slice(2);
        switch (line[0]) {
          case "P": pkg.name = value; break;
          case "V": pkg.version = value; break;
          case "S": pkg.size = Number(value); break;
          case "k": pkg.priority = Number(value); break;
          case "D": pkg.depends = value.split(" "); break;
          case "p": pkg.provides = value.split(" "); break;
          case "i": pkg.installIf = value.split(" "); break;
        }
      }
      return pkg;
    });
}

const bareName = (dep: string) => dep.split(/[<>=~]/)[0]!;

export class Repository {
  readonly base: string;
  readonly arch: string;
  private byName = new Map<string, Package>();
  private byProvide = new Map<string, Package>();
  private conditional: Package[] = [];

  constructor(mirror: string, branch: string, arch: string) {
    this.base = `${mirror}/${branch}`;
    this.arch = arch;
  }

  async load(repos: string[]): Promise<this> {
    for (const repo of repos) {
      const archive = await cached(`${this.base}/${repo}/${this.arch}/APKINDEX.tar.gz`, { maxAge: 6 * 3600e3 });
      const index = [...readTar(gunzipSync(archive))].find((e) => e.name === "APKINDEX");
      if (!index) throw new Error(`apk: ${repo} has no APKINDEX`);

      for (const pkg of parseIndex(index.data.toString("utf8"), repo)) {
        if (!this.byName.has(pkg.name)) {
          this.byName.set(pkg.name, pkg);
          if (pkg.installIf.length) this.conditional.push(pkg);
        }
        for (const provide of pkg.provides) {
          const key = bareName(provide);
          const prev = this.byProvide.get(key);
          if (!prev || pkg.priority > prev.priority) this.byProvide.set(key, pkg);
        }
      }
    }
    return this;
  }

  lookup(dep: string): Package {
    const name = bareName(dep);
    const pkg = this.byName.get(name) ?? this.byProvide.get(name);
    if (!pkg) throw new Error(`apk: nothing provides "${dep}"`);
    return pkg;
  }

  /**
   * The transitive closure of `names`, honouring `replace` substitutions,
   * and with what install_if brings in once its conditions are met, as apk
   * does. Versions in either are not compared: the index has one of each.
   */
  resolve(names: string[], replace: Record<string, string> = {}): Package[] {
    const selected = new Map<string, Package>();
    const present = new Set<string>();
    const visit = (dep: string) => {
      if (dep.startsWith("!")) return;
      const pkg = this.lookup(replace[bareName(dep)] ?? dep);
      if (selected.has(pkg.name)) return;
      selected.set(pkg.name, pkg);
      for (const name of [pkg.name, ...pkg.provides]) present.add(bareName(name));
      pkg.depends.forEach(visit);
    };
    names.forEach(visit);
    const met = (condition: string) => (condition.startsWith("!") ? !present.has(bareName(condition.slice(1))) : present.has(bareName(condition)));
    for (let more = true; more; ) {
      const due = this.conditional.filter((pkg) => !selected.has(pkg.name) && pkg.installIf.every(met));
      due.forEach((pkg) => visit(pkg.name));
      more = due.length > 0;
    }
    return [...selected.values()];
  }

  async unpack(pkg: Package): Promise<TarEntry[]> {
    const data = await cached(`${this.base}/${pkg.repo}/${this.arch}/${pkg.name}-${pkg.version}.apk`);
    if (data.length !== pkg.size) throw new Error(`apk: size mismatch for ${pkg.name}`);
    // An .apk is three gzip streams (signature, control, data) of tar
    // segments. Control files sit at the top level and start with a dot.
    return [...readTar(gunzipSync(data))].filter((e) => !/^\.[^/]*$/.test(e.name));
  }
}
