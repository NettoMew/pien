// This browser's adb key. A phone told to always allow this computer
// remembers the key, so it is made once and kept: in IndexedDB, by Tango's
// own credential store, which names it guest@ this site.

import { adbGeneratePublicKey } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";

const store = new AdbWebCredentialStore("guest");

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function kept() {
  for await (const key of store.iterateKeys()) return key;
}

/** The key, in base64: the private half as PKCS#8, the public half in Android's own form. */
export async function adbKey() {
  const key = (await kept()) ?? (await store.generateKey());
  return {
    private: base64(key.buffer),
    public: base64(adbGeneratePublicKey(key.buffer)),
    name: key.name ?? "guest",
  };
}
