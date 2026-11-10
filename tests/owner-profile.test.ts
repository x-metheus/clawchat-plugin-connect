import { expect, it } from "bun:test";
import { createClawChatApiClient } from "../src/clawchat/api-client";

it("loads the owner app locale from the authenticated Agent owner endpoint", async () => {
  const paths: string[] = [];
  const client = createClawChatApiClient({
    baseUrl: "https://member.example",
    deviceId: "device",
    token: "fixture",
    fetchImpl: Object.assign(
      async (url: string | URL | Request) => {
        paths.push(String(url));
        return Response.json({ code: 0, data: { id: "owner", nickname: "Owner", locale: "zh-Hant" } });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  await expect(client.getAgentOwnerProfile()).resolves.toEqual({ id: "owner", nickname: "Owner", locale: "zh-Hant" });
  expect(paths).toEqual(["https://member.example/v1/agents/me/owner"]);
});
