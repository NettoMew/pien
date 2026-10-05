// Passkeys, through the browser's own dialog and press. The dialog wants the
// page to have been touched a moment before: the key press that ran the
// guest's command, or else a tap on the key the screen offers (gesture.ts).

import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from "@simplewebauthn/browser";
import { KeyRound } from "lucide-react";
import { No } from "../ask.ts";
import { gesture, NeedsTouch } from "../gesture.ts";
import { api } from "./api.ts";
import { keep, type Login } from "./login.ts";

export interface Passkey {
  id: string;
  name: string;
  /** Unix seconds. */
  created: number;
  used?: number;
}

/** Logs in with a passkey of the visitor's choosing. */
export async function logIn(): Promise<Login> {
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>("POST", "/auth/passkey/options", {});
  const response = await dialog("Continue with passkey", () => startAuthentication({ optionsJSON }));
  const login = await api<Login>("POST", "/auth/passkey/login", { response });
  keep(login);
  return login;
}

/**
 * Makes a passkey called `name` on this device, with the login or, for the
 * very first, a code from the server (`press enroll`); logged in after that.
 */
export async function add(name: string, code?: string): Promise<string> {
  const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>("POST", "/auth/passkey/register/options", { code });
  const response = await dialog("Make a passkey", () => startRegistration({ optionsJSON }));
  const { name: added, ...login } = await api<{ name: string } & Partial<Login>>("POST", "/auth/passkey/register", { response, name, code });
  if (login.token && login.key && login.expires) keep(login as Login);
  return added;
}

/** The passkeys, oldest first, and the GitHub account linked, if any. */
export const list = () => api<{ passkeys: Passkey[]; github: string | null }>("GET", "/auth/passkeys");

export const remove = (id: string) => api<{ name: string }>("DELETE", `/auth/passkeys/${encodeURIComponent(id)}`);

/** A name for a passkey made here: the system and the browser. */
export function here(): string {
  const agent = navigator.userAgent;
  const system = /iPhone|iPad|Android|Mac OS|Windows|CrOS|Linux/.exec(agent)?.[0].replace("Mac OS", "macOS").replace("CrOS", "ChromeOS");
  const browser = /Edg|Firefox|Chrome|Safari/.exec(agent)?.[0].replace("Edg", "Edge");
  return [system, browser].filter(Boolean).join(" · ") || "a browser";
}

/** The browser's dialog, offered on a key called `label` if it needs a tap; its refusals in the guest's words. */
async function dialog<T>(label: string, open: () => Promise<T>): Promise<T> {
  try {
    return await gesture(label, KeyRound, () =>
      open().catch((error: Error) => {
        // The library wraps the browser's errors, keeping their names.
        throw error.name === "NotAllowedError" ? new NeedsTouch() : error;
      }),
    );
  } catch (error) {
    if (error instanceof WebAuthnError && error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
      throw new No("This device has a passkey for the site already.");
    }
    if (error instanceof NeedsTouch) throw new No("Cancelled, or the browser said no.");
    if (error instanceof No) throw error;
    throw new No(`The browser could not: ${(error as Error).message}`);
  }
}
