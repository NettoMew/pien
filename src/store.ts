import { create } from "zustand";

/** What the page knows of the machine, for whatever draws it. */
export interface MachineState {
  /** Loading: fetching and resuming. Running: at its prompt. Failed: a file did not arrive. */
  phase: "loading" | "running" | "failed";
  /** How much of what the machine needs has arrived, from 0 to 1. */
  progress: number;
  /** The file that did not arrive. */
  missing?: string;
  /** The window title the guest last set. */
  title: string;
}

export const useMachine = create<MachineState>()(() => ({ phase: "loading", progress: 0, title: "" }));
