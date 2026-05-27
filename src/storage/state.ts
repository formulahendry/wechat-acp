import fs from "node:fs/promises";
import path from "node:path";

const STATE_DIR_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
const MAX_STORED_USERS = 100;

export interface UserState {
  contextToken: string;
  lastSeenAt: string;
}

export interface BridgeState {
  lastActiveUserId?: string;
  users?: Record<string, UserState>;
}

export interface ResolvedUserTarget {
  userId: string;
  contextToken: string;
}

export async function loadState(stateFile: string): Promise<BridgeState> {
  try {
    const content = await fs.readFile(stateFile, "utf-8");
    return JSON.parse(content) as BridgeState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export async function saveState(stateFile: string, state: BridgeState): Promise<void> {
  await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: STATE_DIR_MODE });
  await fs.chmod(path.dirname(stateFile), STATE_DIR_MODE).catch(() => {});
  const tmp = path.join(path.dirname(stateFile), `.state-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", {
    encoding: "utf-8",
    mode: STATE_FILE_MODE,
  });
  await fs.chmod(tmp, STATE_FILE_MODE).catch(() => {});
  await replaceFile(tmp, stateFile);
}

export async function updateLastActiveUser(
  stateFile: string,
  userId: string,
  contextToken: string,
): Promise<void> {
  const state = await loadState(stateFile);
  state.lastActiveUserId = userId;
  state.users = {
    ...(state.users ?? {}),
    [userId]: {
      contextToken,
      lastSeenAt: new Date().toISOString(),
    },
  };
  state.users = pruneUsers(state.users);
  await saveState(stateFile, state);
}

export async function resolveUserTarget(
  stateFile: string,
  target: string | undefined,
  contextToken?: string,
): Promise<ResolvedUserTarget> {
  const state = await loadState(stateFile);
  const userId = !target || target === "last-active-user" ? state.lastActiveUserId : target;
  if (!userId) {
    throw new Error("No last active user found. Send any message to this WeChat bot once, then retry.");
  }

  const stored = state.users?.[userId];
  const resolvedContextToken = contextToken ?? stored?.contextToken;
  if (!resolvedContextToken) {
    throw new Error(`No context token found for target user ${userId}. Ask the user to send a new message first.`);
  }

  return {
    userId,
    contextToken: resolvedContextToken,
  };
}

async function replaceFile(tmp: string, target: string): Promise<void> {
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EEXIST" && code !== "EPERM")) {
      throw err;
    }
    await fs.rm(target, { force: true });
    await fs.rename(tmp, target);
  }
}

function pruneUsers(users: Record<string, UserState>): Record<string, UserState> {
  const entries = Object.entries(users);
  if (entries.length <= MAX_STORED_USERS) return users;

  return Object.fromEntries(
    entries
      .sort(([, left], [, right]) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, MAX_STORED_USERS),
  );
}
