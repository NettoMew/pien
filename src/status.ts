// The quiet line under the terminal: machine state on the left, the latest
// on-demand file fetch in the middle, then the network (once there is one),
// and what the machine is on the right.

const $ = (id: string) => document.getElementById(id)!;

const span = (className: string, text: string) => Object.assign(document.createElement("span"), { className, textContent: text });

export const status = {
  set(state: "loading" | "running" | "error", text: string) {
    document.body.dataset.state = state;
    $("state").textContent = text;
  },

  machine(text: string) {
    $("machine").textContent = text;
  },

  /** The network, when there is one: see src/warp/session.ts. */
  net(state: "off" | "connecting" | "up" | "down", text: string) {
    const net = $("net");
    net.dataset.net = state;
    net.textContent = text;
  },

  fetched(path: string, detail: string) {
    const item = span("fetch", "");
    item.append(span("arrow", "↓"), span("path", path), span("detail", detail));
    $("activity").replaceChildren(item);
  },
};

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;
