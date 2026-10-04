import { create } from "zustand";
import type { MachineName } from "../vm.config.ts";

/** What the page knows of the machine, for whatever draws it. */
export interface MachineState {
  /** The machine on screen, or coming onto it. */
  machine: MachineName;
  /** Loading: fetching and resuming. Running: at its prompt. Failed: it could not start. */
  phase: "loading" | "running" | "failed";
  /** How much of what the machine needs has arrived, from 0 to 1. */
  progress: number;
  /** Why it could not start. */
  problem?: string;
  /** The machine the guest asked for: the screen powers down, then that one starts. */
  next?: MachineName;
}

export const useMachine = create<MachineState>()(() => ({ machine: "home", phase: "loading", progress: 0 }));
