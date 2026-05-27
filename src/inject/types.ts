export const DEFAULT_INJECTION_TARGET = "last-active-user";

export interface InjectedMessage {
  id: string;
  createdAt: string;
  target: string;
  text: string;
  source: "cli";
  contextToken?: string;
}
