export const MAX_AGENT_FILE_BYTES = 25 * 1024 * 1024;

export interface AgentFile {
  data: string;
  name: string;
  mimeType: string;
}

export interface AgentResourceLink {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
}
