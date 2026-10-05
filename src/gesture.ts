// What a browser lets a page do only as the visitor touches it: open a
// window, pick files or a folder, choose a device, use a passkey. The guest
// asks for these, and its command reaches the page a moment after the key
// press that ran it. Desktop browsers still count that moment as the
// visitor's doing; phones do not. So an action runs at once if it can, and
// otherwise waits on a key the screen offers (components/Offer.tsx): the tap
// on it is the touch it needs.

import type { LucideIcon } from "lucide-react";
import { create } from "zustand";
import { No } from "./no.ts";

/** An action waiting for the visitor's tap. */
export interface Offer {
  /** What the key says: "Continue with GitHub". */
  label: string;
  icon: LucideIcon;
  /** Runs the action: called from the tap itself, so it counts as the visitor's. */
  accept(): void;
  decline(): void;
}

export const useOffer = create<{ offer?: Offer }>()(() => ({}));

/** Thrown by an action the browser refused for want of a touch, where it says nothing itself. */
export class NeedsTouch extends Error {}

/** Throws NeedsTouch unless the visitor touched the page a moment ago: for actions that would otherwise fail silently. */
export function touched() {
  if (navigator.userActivation && !navigator.userActivation.isActive) throw new NeedsTouch();
}

/** Whether `error` is the browser's no to an action it wanted a touch for. */
const forWantOfTouch = (error: unknown) =>
  error instanceof NeedsTouch || (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError"));

/**
 * Runs `action` now; or, if the browser wants the visitor's touch for it and
 * did not have one, offers it on a key called `label` and runs it when tapped.
 * A refusal that came with a touch is a real refusal, and stands.
 */
export async function gesture<T>(label: string, icon: LucideIcon, action: () => T | Promise<T>): Promise<T> {
  const fresh = navigator.userActivation?.isActive ?? false;
  try {
    return await action();
  } catch (error) {
    if (fresh || !forWantOfTouch(error)) throw error;
  }
  // One offer at a time: a new one takes the place of any still waiting.
  useOffer.getState().offer?.decline();
  return new Promise<T>((resolve, reject) => {
    const done = () => useOffer.setState({ offer: undefined });
    useOffer.setState({
      offer: {
        label,
        icon,
        accept() {
          done();
          // Started within the tap itself, not a moment after: some browsers
          // count only what happens there as the visitor's.
          let started: T | Promise<T>;
          try {
            started = action();
          } catch (error) {
            return reject(error);
          }
          Promise.resolve(started).then(resolve, reject);
        },
        decline() {
          done();
          reject(new No("Cancelled."));
        },
      },
    });
  });
}
