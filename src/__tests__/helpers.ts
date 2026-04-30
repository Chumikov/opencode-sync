import type { ProjectScope } from "../scope.js";
import type { SessionExport, SessionInfo } from "../session.js";

export const mockSessionInfo = (overrides?: Partial<SessionInfo>): SessionInfo => ({
  id: "01JTEST00000000000000000001",
  title: "Test Session",
  projectId: "abc123",
  directory: "/home/user/project",
  created: 1700000000000,
  updated: 1700000100000,
  ...overrides,
});

export const mockSessionExport = (overrides?: Partial<SessionExport>): SessionExport => ({
  info: {
    id: "01JTEST00000000000000000001",
    projectID: "abc123",
    title: "Test Session",
    directory: "/home/user/project",
    time: { created: 1700000000000, updated: 1700000100000 },
  },
  messages: [
    {
      info: { id: "msg1", role: "user" },
      parts: [{ type: "text", text: "Hello" }],
    },
    {
      info: { id: "msg2", role: "assistant" },
      parts: [{ type: "text", text: "Hi there" }],
    },
  ],
  ...overrides,
});

export const mockConfig = () => ({
  repo: "git@github.com:user/sessions.git",
  deviceName: "test-device",
  localPath: "/tmp/opencode-sync-test",
  branch: "main",
});

export const mockScope = (overrides?: Partial<ProjectScope>): ProjectScope => ({
  type: "project",
  projectId: "abc123",
  ...overrides,
});
