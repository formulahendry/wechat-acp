import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startArtifactMcpServer } from "../src/artifacts/server.js";
import { ArtifactStore } from "../src/artifacts/store.js";

async function withTempDir(
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-acp-artifact-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("ArtifactStore snapshots allowed files and consumes artifacts once", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "report.txt");
    await fs.writeFile(filePath, "version one");
    const store = await ArtifactStore.create({ rootDir: dir });
    try {
      const published = await store.publish("report.txt");
      await fs.writeFile(filePath, "version two");

      const first = await store.resolveResourceLink({
        uri: published.uri,
        name: published.name,
      });
      assert.equal(
        Buffer.from(first!.data, "base64").toString(),
        "version one",
        "the published artifact must be an immutable snapshot",
      );
      assert.equal(first!.name, "report.txt");
      assert.equal(first!.mimeType, "text/plain");
      assert.equal(
        await store.resolveResourceLink({ uri: published.uri }),
        null,
        "artifact links are one-shot",
      );
    } finally {
      store.close();
    }
  });
});

test("ArtifactStore rejects paths outside the workspace and symlink escapes", async () => {
  await withTempDir(async (dir) => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-acp-outside-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    await fs.writeFile(outsideFile, "secret");
    await fs.symlink(outsideFile, path.join(dir, "escape.txt"));
    const store = await ArtifactStore.create({ rootDir: dir });
    try {
      await assert.rejects(() => store.publish(outsideFile), /outside the allowed workspace/);
      await assert.rejects(() => store.publish("escape.txt"), /outside the allowed workspace/);
    } finally {
      store.close();
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("ArtifactStore enforces file size and expiry limits", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "large.bin"), "12345");
    await fs.writeFile(path.join(dir, "short.txt"), "ok");
    const store = await ArtifactStore.create({
      rootDir: dir,
      maxFileBytes: 4,
      ttlMs: 5,
    });
    try {
      await assert.rejects(() => store.publish("large.bin"), /byte limit/);
      const published = await store.publish("short.txt");
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(await store.resolveResourceLink({ uri: published.uri }), null);
    } finally {
      store.close();
    }
  });
});

test("ArtifactStore serializes concurrent publishes against total capacity", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "first.bin"), "1234");
    await fs.writeFile(path.join(dir, "second.bin"), "5678");
    const store = await ArtifactStore.create({
      rootDir: dir,
      maxFileBytes: 4,
      maxTotalBytes: 6,
    });
    try {
      const results = await Promise.allSettled([
        store.publish("first.bin"),
        store.publish("second.bin"),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const rejection = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      assert.match(String(rejection?.reason), /capacity exceeded/);
    } finally {
      store.close();
    }
  });
});

test("artifact MCP requires auth and returns a resolvable resource_link", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "artifact.txt"), "MCP attachment");
    const server = await startArtifactMcpServer({
      rootDir: dir,
      log: () => {},
    });
    const lease = server.createLease();
    try {
      const unauthorized = await fetch(lease.mcpServer.url, { method: "POST" });
      assert.equal(unauthorized.status, 401);

      const headers = Object.fromEntries(
        lease.mcpServer.headers.map(({ name, value }) => [name, value]),
      );
      const originRequest = await fetch(lease.mcpServer.url, {
        method: "POST",
        headers: { ...headers, Origin: "https://example.com" },
      });
      assert.equal(originRequest.status, 403);

      const transport = new StreamableHTTPClientTransport(
        new URL(lease.mcpServer.url),
        { requestInit: { headers } },
      );
      const client = new Client(
        { name: "artifact-test", version: "1.0.0" },
        { capabilities: {} },
      );
      await client.connect(transport);
      try {
        const tools = await client.listTools();
        assert.ok(tools.tools.some((tool) => tool.name === "attach_file"));

        const result = await client.callTool({
          name: "attach_file",
          arguments: { path: "artifact.txt" },
        });
        const content = result.content as Array<Record<string, unknown>>;
        assert.equal(content.length, 1);
        assert.equal(content[0].type, "resource_link");
        assert.equal(content[0].name, "artifact.txt");
        assert.equal(content[0].mimeType, "text/plain");
        assert.match(String(content[0].uri), /^wechat-acp:\/\/artifact\//);

        const resolved = await server.resolveResourceLink({
          uri: String(content[0].uri),
          name: String(content[0].name),
          mimeType: String(content[0].mimeType),
        });
        assert.equal(
          Buffer.from(resolved!.data, "base64").toString(),
          "MCP attachment",
        );

        const secondLease = server.createLease();
        const secondHeaders = Object.fromEntries(
          secondLease.mcpServer.headers.map(({ name, value }) => [name, value]),
        );
        const secondTransport = new StreamableHTTPClientTransport(
          new URL(secondLease.mcpServer.url),
          { requestInit: { headers: secondHeaders } },
        );
        const secondClient = new Client(
          { name: "artifact-test-2", version: "1.0.0" },
          { capabilities: {} },
        );
        await secondClient.connect(secondTransport);
        const secondTools = await secondClient.listTools();
        assert.ok(
          secondTools.tools.some((tool) => tool.name === "attach_file"),
          "the loopback server must support concurrent agent sessions",
        );
        await secondLease.close();
        await secondClient.close().catch(() => {});
      } finally {
        await client.close();
        await lease.close();
      }
    } finally {
      await server.close();
    }
  });
});

test("artifact MCP shutdown closes active transports before the HTTP server", async () => {
  await withTempDir(async (dir) => {
    const server = await startArtifactMcpServer({ rootDir: dir, log: () => {} });
    const lease = server.createLease();
    const headers = Object.fromEntries(
      lease.mcpServer.headers.map(({ name, value }) => [name, value]),
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(lease.mcpServer.url),
      { requestInit: { headers } },
    );
    const client = new Client(
      { name: "shutdown-test", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);

    let timeout: NodeJS.Timeout;
    try {
      await Promise.race([
        server.close(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("artifact MCP shutdown timed out")),
            500,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      clearTimeout(timeout!);
    }
    await client.close().catch(() => {});
  });
});
