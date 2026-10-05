// What the guest may ask the page about (ask.ts), each topic's module loaded
// the first time it is asked.

import type { Topics } from "./ask.ts";

export const topics: Topics = {
  net: () => import("./net/answers.ts").then((module) => module.answer),
  blog: () => import("./writing.ts").then((module) => module.blog),
  moments: () => import("./writing.ts").then((module) => module.moments),
  take: () => import("./take.ts").then((module) => module.take),
};
