/**
 * Tests for the subname client module (pure, offline -- no Worker needed).
 * Run via `pnpm test` (node --test over compiled dist/**\/*.test.js).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildClaimMessage,
  normalizeLabel,
  suggestLabel,
  isValidLabel,
  ownerForKey,
  type SubnameClaim,
} from "./subname.js";

// A throwaway test key (NOT a real wallet -- deterministic for assertions).
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TEST_ADDR = privateKeyToAccount(TEST_KEY).address;

const CLAIM: SubnameClaim = {
  label: "mysite",
  parent: "fcnova.eth",
  cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  expiry: 1717000000,
  owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
};

test("buildClaimMessage produces the exact canonical format (incl. owner)", () => {
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

test("buildClaimMessage is line-based (6 lines, no trailing newline)", () => {
  const lines = buildClaimMessage(CLAIM).split("\n");
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "Nova subname claim");
  assert.equal(lines[5], "owner: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
});

test("normalizeLabel lowercases, hyphenates, collapses, and trims", () => {
  assert.equal(normalizeLabel("My Cool Site!"), "my-cool-site");
  assert.equal(normalizeLabel("  --Hello__World--  "), "hello-world");
  assert.equal(normalizeLabel("already-fine"), "already-fine");
  assert.equal(normalizeLabel("a___b   c"), "a-b-c");
});

test("normalizeLabel caps length at 63 chars", () => {
  assert.equal(normalizeLabel("a".repeat(200)).length, 63);
});

test("suggestLabel derives from a directory basename", () => {
  assert.equal(suggestLabel("/tmp/My Build Output/"), "my-build-output");
  assert.equal(suggestLabel("./dist"), "dist");
});

test("isValidLabel accepts valid labels and rejects invalid ones", () => {
  assert.ok(isValidLabel("mysite"));
  assert.ok(isValidLabel("my-site-1"));
  assert.ok(!isValidLabel("My Site"));
  assert.ok(!isValidLabel("under_score"));
  assert.ok(!isValidLabel(""));
  assert.ok(!isValidLabel("a".repeat(64)));
});

test("ownerForKey derives the signing address (with and without 0x prefix)", () => {
  assert.equal(ownerForKey(TEST_KEY).toLowerCase(), TEST_ADDR.toLowerCase());
  assert.equal(ownerForKey(TEST_KEY.slice(2)).toLowerCase(), TEST_ADDR.toLowerCase());
});

test("a claim signature recovers to the signer -- even when owner != signer", async () => {
  // Browser case: session key SIGNS, but the asserted owner is the real wallet.
  const account = privateKeyToAccount(TEST_KEY);
  const signature = await account.signMessage({ message: buildClaimMessage(CLAIM) });

  // The Worker recovers the SIGNER (session key), not the asserted owner.
  const recovered = await recoverMessageAddress({ message: buildClaimMessage(CLAIM), signature });
  assert.equal(recovered.toLowerCase(), TEST_ADDR.toLowerCase());
  assert.notEqual(recovered.toLowerCase(), CLAIM.owner.toLowerCase());
});

test("tampering with any claim field breaks recovery (forgery fails)", async () => {
  const account = privateKeyToAccount(TEST_KEY);
  const signature = await account.signMessage({ message: buildClaimMessage(CLAIM) });
  for (const tampered of [
    { ...CLAIM, cid: "bafybeih" + "a".repeat(50) },
    { ...CLAIM, owner: "0x0000000000000000000000000000000000000001" },
    { ...CLAIM, expiry: CLAIM.expiry + 1 },
  ]) {
    const recovered = await recoverMessageAddress({ message: buildClaimMessage(tampered), signature });
    assert.notEqual(recovered.toLowerCase(), TEST_ADDR.toLowerCase());
  }
});
