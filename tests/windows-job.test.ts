import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createWindowsJob } from "../src/acp/windows-job.js";

test(
  "Windows job terminates a descendant after its wrapper exits",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-acp-job-"));
    const scriptPath = path.join(dir, "wrapper.cjs");
    const pidPath = path.join(dir, "agent.pid");
    await fs.writeFile(
      scriptPath,
      [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        "setTimeout(() => {",
        '  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
        "  fs.writeFileSync(process.argv[2], String(child.pid));",
        "  child.unref();",
        "}, 100);",
      ].join("\n"),
    );
    const wrapper = spawn(process.execPath, [scriptPath, pidPath], {
      stdio: "ignore",
      windowsHide: true,
    });
    const job = createWindowsJob(wrapper.pid!);
    let agentPid: number | undefined;

    try {
      agentPid = Number(await waitForFile(pidPath));
      assert.equal(Number.isInteger(agentPid), true);
      if (wrapper.exitCode === null) {
        await once(wrapper, "exit");
      }
      assert.equal(isProcessRunning(agentPid), true);
      assert.equal(job.hasActiveProcesses(), true);

      job.terminate();
      await job.waitForEmpty(5_000);
      assert.equal(isProcessRunning(agentPid), false);
    } finally {
      job.close();
      if (agentPid !== undefined && isProcessRunning(agentPid)) {
        process.kill(agentPid, "SIGKILL");
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

async function waitForFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (
        typeof err !== "object" ||
        err === null ||
        !("code" in err) ||
        err.code !== "ENOENT"
      ) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Timed out waiting for agent process ID");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "ESRCH"
    ) {
      return false;
    }
    throw err;
  }
}
