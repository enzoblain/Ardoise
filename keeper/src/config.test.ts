import assert from "node:assert/strict";
import { test } from "node:test";

import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

import { loadConfig } from "./config.js";

const FACTORY = "0x00000000000000000000000000000000000000f1";
/** Throwaway key made for this run, so that no key is written in the repository. */
const TEST_KEY = generatePrivateKey();

test("an empty environment means no factory, no key, no standing orders, no defense relay and the public RPC", () => {
  assert.deepEqual(loadConfig({}), {
    rpcUrl: undefined,
    factory: null,
    factoryDeployBlock: null,
    keeperAccount: null,
    gatewayOrdersFile: null,
    intakePort: null,
    appOrigin: "http://localhost:3000",
    baseRpcUrl: undefined,
    defenseAlarm: null,
  });
});

test("reads the order intake settings and needs an orders file for it", () => {
  const config = loadConfig({ GATEWAY_ORDERS_FILE: "orders.json", GATEWAY_INTAKE_PORT: "8787", APP_ORIGIN: "https://ardoise.app" });
  assert.equal(config.intakePort, 8787);
  assert.equal(config.appOrigin, "https://ardoise.app");
  assert.throws(() => loadConfig({ GATEWAY_INTAKE_PORT: "8787" }), /GATEWAY_ORDERS_FILE/);
  assert.throws(() => loadConfig({ GATEWAY_ORDERS_FILE: "o.json", GATEWAY_INTAKE_PORT: "http" }), /GATEWAY_INTAKE_PORT/);
});

test("reads the Gateway standing orders file", () => {
  assert.equal(loadConfig({ GATEWAY_ORDERS_FILE: " orders.json " }).gatewayOrdersFile, "orders.json");
});

test("reads the factory, its deploy block and the keeper wallet", () => {
  const config = loadConfig({
    ARDOISE_FACTORY_ADDRESS: FACTORY,
    ARDOISE_FACTORY_DEPLOY_BLOCK: " 31770000 ",
    KEEPER_PRIVATE_KEY: TEST_KEY,
  });
  assert.equal(config.factory, FACTORY);
  assert.equal(config.factoryDeployBlock, 31_770_000n);
  assert.equal(config.keeperAccount?.address, privateKeyToAddress(TEST_KEY));
});

test("reads the defense alarm, which turns the defense relay on", () => {
  assert.equal(loadConfig({ DEFENSE_ALARM_ADDRESS: ` ${FACTORY} ` }).defenseAlarm, FACTORY);
  assert.throws(() => loadConfig({ DEFENSE_ALARM_ADDRESS: "0x123" }), /DEFENSE_ALARM_ADDRESS/);
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
