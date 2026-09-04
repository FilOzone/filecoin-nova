/**
 * Worker unit tests -- pure logic, offline (no Namespace API, no KV).
 * Run via `npm test` inside workers/subname (node --test --experimental-strip-types).
 *
 * The success paths (createSubname/updateSubname/409) require live infra and are
 * covered by the manual verification steps in the plan; these guard the pure,
 * security-critical pieces: the byte-identical claim string, label validation,
 * CID normalization, and the signature-recovery ownership invariant.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildClaimMessage, toContenthash, LABEL_RE, CLAIM_MAX_SKEW } from "./index.ts";

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TEST_ADDR = privateKeyToAccount(TEST_KEY).address;

const CLAIM = {
  label: "mysite",
  parent: "fcnova.eth",
  cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  expiry: 1717000000,
  owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
};

test("buildClaimMessage matches the client's canonical format byte-for-byte", () => {
  assert.equal(
    buildClaimMessage(CLAIM),
    "Nova subname claim\n" +
      "label: mysite\n" +
      "parent: fcnova.eth\n" +
      "cid: bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi\n" +
      "expiry: 1717000000\n" +
      "owner: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  );
});

test("ownership invariant: a valid signature recovers to the signer", async () => {
  const account = privateKeyToAccount(TEST_KEY);
  const signature = await account.signMessage({ message: buildClaimMessage(CLAIM) });
  const recovered = await recoverMessageAddress({
    message: buildClaimMessage(CLAIM),
    signature,
  });
  assert.equal(recovered.toLowerCase(), TEST_ADDR.toLowerCase());
});

test("a signature over a different claim recovers to a different address", async () => {
  const account = privateKeyToAccount(TEST_KEY);
  const signature = await account.signMessage({ message: buildClaimMessage(CLAIM) });
  const recovered = await recoverMessageAddress({
    message: buildClaimMessage({ ...CLAIM, label: "evil" }),
    signature,
  });
  assert.notEqual(recovered.toLowerCase(), TEST_ADDR.toLowerCase());
});

test("LABEL_RE accepts valid labels, rejects invalid", () => {
  assert.ok(LABEL_RE.test("mysite"));
  assert.ok(LABEL_RE.test("my-site-1"));
  assert.ok(!LABEL_RE.test("My-Site"));
  assert.ok(!LABEL_RE.test("under_score"));
  assert.ok(!LABEL_RE.test(""));
  assert.ok(!LABEL_RE.test("a".repeat(64)));
});

test("toContenthash normalizes CIDv0 and CIDv1 to ipfs://<cidv1>", () => {
  // CIDv1 stays v1
  const v1 = toContenthash("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
  assert.ok(v1.startsWith("ipfs://bafybei"));
  // CIDv0 (Qm...) upgrades to v1
  const fromV0 = toContenthash("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
  assert.ok(fromV0.startsWith("ipfs://bafybei"));
});

test("toContenthash throws on an invalid CID", () => {
  assert.throws(() => toContenthash("not-a-cid"));
});

test("CLAIM_MAX_SKEW bounds the claim window to 15 minutes", () => {
  assert.equal(CLAIM_MAX_SKEW, 900);
});
