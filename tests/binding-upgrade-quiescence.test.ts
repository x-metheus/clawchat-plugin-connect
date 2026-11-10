import { expect, it } from "bun:test";
import { SessionQueue } from "../src/runtime/session-queue";
import { createUpgradeQuiescence } from "../src/service/connect-execution-modules";

it("waits for the current turn and keeps admission fenced without retiring state", async () => {
  const queue = new SessionQueue();
  let finish!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((r) => (finish = r));
  const entered = new Promise<void>((r) => (started = r));
  const turn = queue.enqueue("session", async () => {
    started();
    await waiting;
  });
  await entered;
  let releaseCalls = 0;
  const queues = {
    async quiesceBindings<T>(
      _ids: readonly string[],
      releaseSessions: () => Promise<void>,
      critical: () => Promise<T>,
    ) {
      const release = await queue.acquireBindingQuiescence();
      await releaseSessions();
      const result = await critical();
      releaseCalls++;
      await release();
      return result;
    },
  };
  let completed = false;
  const upgrade = createUpgradeQuiescence(queues);
  const drain = upgrade.suspend(["dsh"]).then(() => {
    completed = true;
  });
  await Bun.sleep(5);
  expect(completed).toBe(false);
  finish();
  await turn;
  await drain;
  expect(completed).toBe(true);
  expect(releaseCalls).toBe(0);
  expect(() => queue.submit("next", async () => {})).toThrow("lifecycle");
  await upgrade.resume();
  expect(releaseCalls).toBe(1);
  await queue.enqueue("next", async () => {});
});
