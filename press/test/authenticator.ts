// A passkey in software, for tests: makes and uses one the way a browser and
// an authenticator would, with "none" attestation, so press can be tested
// without either.

import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

/** Flags in authenticator data: the user was present, verified; a credential follows. */
const PRESENT = 0x01;
const VERIFIED = 0x04;
const ATTESTED = 0x40;

export class Authenticator {
  readonly id = randomBytes(16);
  private readonly key: KeyObject;
  private readonly cose: Uint8Array;
  private count = 0;
  private user = "";

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    const { x, y } = publicKey.export({ format: "jwk" });
    // COSE_Key: EC2 (1: 2), ES256 (3: -7), P-256 (-1: 1), x (-2), y (-3).
    this.cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(x!, "base64url")],
        [-3, Buffer.from(y!, "base64url")],
      ]),
    );
  }

  /** What navigator.credentials.create() would give the page, as JSON. */
  create(options: PublicKeyCredentialCreationOptionsJSON, origin: string): RegistrationResponseJSON {
    this.user = options.user.id;
    const clientData = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false });
    const length = Buffer.alloc(2);
    length.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([
      sha256(options.rp.id!),
      Buffer.of(PRESENT | VERIFIED | ATTESTED),
      Buffer.alloc(4),
      Buffer.alloc(16), // no AAGUID
      length,
      this.id,
      this.cose,
    ]);
    const attestation = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: "public-key",
      response: { clientDataJSON: b64(Buffer.from(clientData)), attestationObject: b64(attestation), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** What navigator.credentials.get() would give the page, as JSON. */
  get(options: PublicKeyCredentialRequestOptionsJSON, origin: string, rpId = options.rpId!): AuthenticationResponseJSON {
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.count);
    const authData = Buffer.concat([sha256(rpId), Buffer.of(PRESENT | VERIFIED), counter]);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), this.key);
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: "public-key",
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature), userHandle: this.user },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
