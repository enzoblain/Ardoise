import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "./config.js";

const FACTORY = "0x00000000000000000000000000000000000000f1";
/** Well-known first test key of local development nodes; it guards nothing. */
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // secret-scan:allow

test("an empty environment means no factory, no key and the public RPC", () => {
  assert.deepEqual(loadConfig({}), {
    rpcUrl: undefined,
    factory: null,
    factoryDeployBlock: null,
    keeperAccount: null,
  });
});

test("reads the factory, its deploy block and the keeper wallet", () => {
  const config = loadConfig({
    ARDOISE_FACTORY_ADDRESS: FACTORY,
    ARDOISE_FACTORY_DEPLOY_BLOCK: " 31770000 ",
    KEEPER_PRIVATE_KEY: TEST_KEY,
  });
  assert.equal(config.factory, FACTORY);
  assert.equal(config.factoryDeployBlock, 31_770_000n);
  assert.equal(config.keeperAccount?.address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
});

test("rejects an invalid factory address or deploy block", () => {
  assert.throws(() => loadConfig({ ARDOISE_FACTORY_ADDRESS: "0x123" }), /ARDOISE_FACTORY_ADDRESS/);
  assert.throws(() => loadConfig({ ARDOISE_FACTORY_DEPLOY_BLOCK: "0x10" }), /ARDOISE_FACTORY_DEPLOY_BLOCK/);
});

test("rejects an invalid key without repeating it", () => {
  const zeroKey = `0x${"00".repeat(32)}`;
  for (const key of ["not-a-key", "0x1234", zeroKey, `0x${"ff".repeat(32)}`]) {
    assert.throws(
      () => loadConfig({ KEEPER_PRIVATE_KEY: key }),
      (error: Error) => error.message.startsWith("KEEPER_PRIVATE_KEY") && !error.message.includes(key.slice(2)),
    );
  }
});
