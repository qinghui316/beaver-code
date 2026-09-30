import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initializeCurrentWorkbenchSchema, materializeWorkbenchSchemaContract, migrateWorkbenchSchema, validateCurrentWorkbenchSchema } from "../../src/workbench/persistence/schema-migrations.js";
import { ConversationRepository } from "../../src/workbench/persistence/repositories/conversation-repository.js";
import { WORKBENCH_SCHEMA_VERSION } from "../../src/workbench/persistence/schema.js";

function seed(db: Database.Database): void {
  db.exec(`INSERT INTO conversations(project_id, conversation_id, product_mode, agent_turn_mode, title,
    selected_provider_id, created_at, updated_at) VALUES('p','c','agent','default','kept','codex','t0','t0')`);
}

describe("Agent access persistence", () => {
  it("limits delivery ownership to one unsettled operation and protects captured identity", () => {
    const db = new Database(":memory:");
    try {
      initializeCurrentWorkbenchSchema(db); seed(db);
      const insert = db.prepare(`INSERT INTO conversation_input_deliveries(project_id,conversation_id,product_mode,client_request_id,request_hash,mode,provider_id,execution_revision,phase,created_at,updated_at)
        VALUES('p','c','agent',?,'hash','steer','codex','revision',?,'t0','t0')`);
      insert.run("first", "claimed");
      expect(() => insert.run("second", "claimed")).toThrow(/UNIQUE/);
      expect(() => db.exec("UPDATE conversation_input_deliveries SET request_hash='other'")).toThrow(/immutable/);
      expect(() => db.exec("UPDATE conversation_input_deliveries SET product_mode='harness'")).toThrow(/immutable/);
      db.exec("UPDATE conversation_input_deliveries SET phase='rejected'");
      expect(() => insert.run("second", "claimed")).not.toThrow();
    } finally { db.close(); }
  });
  it.each([16, 17, 18, 19, 20] as const)("preserves historical Schema %i and defaults access without inventing evidence", (version) => {
    const db = new Database(":memory:");
    try {
      initializeCurrentWorkbenchSchema(db);
      materializeWorkbenchSchemaContract(db, version);
      seed(db);
      db.transaction(() => migrateWorkbenchSchema(db, version))();
      validateCurrentWorkbenchSchema(db);
      expect(db.pragma("user_version", { simple: true })).toBe(WORKBENCH_SCHEMA_VERSION);
      expect(new ConversationRepository(db).readConversation("p", "c")).toMatchObject({
        title: "kept", agentAccessMode: "default", agentAccessRevision: 0,
      });
    } finally { db.close(); }
  });

  it("saves by exact revision and resets atomically on service change", () => {
    const db = new Database(":memory:");
    try {
      initializeCurrentWorkbenchSchema(db);
      seed(db);
      const repo = new ConversationRepository(db);
      const input = { projectId: "p", conversationId: "c", providerId: "codex",
        expectedRevision: 0, accessMode: "full-access" as const, updatedAt: "t1" };
      expect(repo.updateAgentAccess(input)).toMatchObject({ agentAccessMode: "full-access", agentAccessRevision: 1 });
      expect(() => repo.updateAgentAccess(input)).toThrow(/concurrently/);
      repo.switchSelectedProvider("p", "c", "codex", "other", "t2");
      expect(repo.readConversation("p", "c")).toMatchObject({
        agentAccessMode: "default", agentAccessRevision: 2, selectedProviderId: "other",
      });
      repo.selectConversationProvider("p", "c", "other", "t3");
      expect(repo.readConversation("p", "c")?.agentAccessRevision).toBe(2);
      expect(() => repo.updateAgentAccess({ ...input, expectedRevision: 2 })).toThrow(/concurrently/);
    } finally { db.close(); }
  });

  it("does not allow archived conversations or AHO to change Agent access", () => {
    const db = new Database(":memory:");
    try {
      initializeCurrentWorkbenchSchema(db);
      seed(db);
      db.exec("UPDATE conversations SET state = 'archive', archive_origin = 'agent-user', archived_at = 't1'");
      expect(() => new ConversationRepository(db).updateAgentAccess({
        projectId: "p", conversationId: "c", providerId: "codex", expectedRevision: 0,
        accessMode: "full-access", updatedAt: "t2",
      })).toThrow();
    } finally { db.close(); }
  });
});
