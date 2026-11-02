import assert from "node:assert/strict";
import test from "node:test";
import { policyRelay } from "../browser/policy-relay.mjs";

test("outbound ephemeral fanout drops without subscribers while inbound injection stays strict", () => {
  const report = { unexpected: [] };
  const relay = policyRelay({ report });
  const event = { kind: 20002, content: "", tags: [["h", "alpha"]] };
  assert.doesNotThrow(() =>
    relay.publish("primary", event, { requireSubscriber: false }),
  );
  assert.throws(
    () => relay.publish("primary", event),
    /explicit production channel REQ/,
  );
  const socket = relay.socket("wss://primary.test");
  socket.routes.set("typing", [{ kinds: [20002], "#h": ["alpha"] }]);
  relay.publish("primary", event, { requireSubscriber: false });
  assert.deepEqual(report.wireFrames, [["EVENT", "typing", event]]);
  socket.close();
  assert.doesNotThrow(() =>
    relay.publish("primary", event, { requireSubscriber: false }),
  );
  assert.throws(
    () => relay.publish("primary", event),
    /explicit production channel REQ/,
  );
  assert.equal(report.wireFrames.length, 1);
});
