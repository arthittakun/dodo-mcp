import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import { decodeAccessScopes } from '../../src/store/scopeEncoding.js';
import { formatTerminalLine } from '../../src/cli/terminal.js';

describe('workspace access migration', () => {
  it.each([2,3])('upgrades schema %s preserving scopes, revocations and workspace separation', version => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'dodo-migrate-'));
    const file = path.join(dir,'state.db');
    let db = openDatabase(file);
    try {
      const store = new Store(db);
      store.putGrant({id:'g',workspaceId:'a',clientId:'client',accountId:'owner',scopes:['dodo:read','dodo:write']});
      store.putGrant({id:'revoked',workspaceId:'b',clientId:'client',accountId:'owner',scopes:['dodo:exec']});
      store.revokeGrant('revoked');
      // Restore the actual old schema, including tables added after v4.
      db.exec('DROP TABLE recovery_deployment_reviews; DROP TABLE recovery_deployment_maintenance; DROP TABLE recovery_production_pointers; DROP TABLE recovery_deployment_jobs; DROP TABLE recovery_deployments; DROP TABLE recovery_deployment_targets; DROP TABLE recovery_pointer_events; DROP TABLE recovery_pointers; DROP TABLE recovery_verifications; DROP TABLE recovery_git_copies; DROP TABLE recovery_git_destinations; DROP TABLE recovery_drift; DROP TABLE recovery_plan_refs; DROP TABLE recovery_restore_plans; DROP TABLE recovery_events; DROP TABLE recovery_sessions; DROP TABLE recovery_refs; DROP TABLE recovery_reservations; DROP TABLE recovery_objects; DROP TABLE recovery_snapshots; DROP TABLE recovery_policies; DROP TABLE ai_events; DROP TABLE ai_runs; DROP TABLE ai_settings; DROP TABLE agent_skills; DROP TABLE agent_skill_proposals; DROP TABLE agent_judgements; DROP TABLE agent_snapshots; DROP TABLE agent_actions; DROP TABLE agent_intents; DROP TABLE agent_hypotheses; DROP TABLE agent_plans; DROP TABLE agent_runs; DROP TABLE runtime_evidence; DROP TABLE runtime_tasks; DROP TABLE runtime_sessions; DROP TABLE memory_visibility; DROP TABLE memories; DROP TABLE memory_learning_proposals; DROP TABLE memory_proposals; DROP TABLE context_metrics; DROP TABLE context_evidence; DROP TABLE context_cache; DROP TABLE brain_edges; DROP TABLE brain_nodes; DROP TABLE brain_file_cache; DROP TABLE brain_runs; DROP TABLE brain_index_state; DROP TABLE resource_refs; DROP TABLE resource_objects; DROP TABLE project_registry; DROP TABLE chat_permissions; DROP TABLE usage_consents; DROP TABLE schedules; DROP TABLE schedule_runs');
      if (version === 2) db.exec('DROP TABLE workspace_clients; DELETE FROM schema_migrations WHERE version >= 3');
      else {
        db.exec('DELETE FROM schema_migrations WHERE version >= 4');
        db.prepare('INSERT INTO workspace_clients VALUES (?,?,?)').run('a','client','dodo:read dodo:write');
        store.setClientAccess('b','client',[]);
        store.setClientAccess('c','other',['dodo:exec']);
      }
      db.close();
      db = openDatabase(file);
      const next = new Store(db);
      expect(next.clientAccess('a','client')).toEqual(['dodo:read','dodo:write']);
      expect(next.clientAccess('b','client')).toEqual([]);
      expect(next.clientAccess('a','other')).toEqual([]);
      if (version === 3) expect(next.clientAccess('c','other')).toEqual(['dodo:exec']);
      const row = db.prepare('SELECT scopes FROM workspace_clients WHERE workspace_id=?').get('a') as {scopes:string};
      expect(JSON.parse(row.scopes)).toEqual(['dodo:read','dodo:write']);
      // Reopen must not re-grant access the owner has revoked.
      next.setClientAccess('a','client',[]);
      db.close(); db = openDatabase(file);
      expect(new Store(db).clientAccess('a','client')).toEqual([]);
    } finally { db.close(); fs.rmSync(dir,{recursive:true,force:true}); }
  });

  it('upgrades schema 5 without converting old usage consent into a standing chat permission', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dodo-migrate-chat-'));
    const file=path.join(dir,'state.db');let db=openDatabase(file);
    try {
      db.exec('DROP INDEX idx_usage_chat; ALTER TABLE usage_consents DROP COLUMN chat_permission_id; DROP TABLE chat_permissions; DELETE FROM schema_migrations WHERE version=6');
      db.prepare('INSERT INTO usage_consents VALUES (?,?,?,?,?,?,?,?,?)').run('use_old','ws','boot','client','grant','existing approval','approved',Date.now(),Date.now()+60000);
      db.close();db=openDatabase(file);
      expect(db.prepare('SELECT * FROM usage_consents WHERE id=?').get('use_old')).toMatchObject({status:'approved',chat_permission_id:null});
      expect(db.prepare('SELECT * FROM chat_permissions').all()).toEqual([]);
    } finally {db.close();fs.rmSync(dir,{recursive:true,force:true});}
  });

  it('fails closed for corrupt/unknown scopes instead of throwing or granting permissions', () => {
    for (const raw of ['broken','{"dodo:exec":true}','["admin"]','["dodo:read",42]','null']) expect(decodeAccessScopes(raw,true)).toEqual([]);
    expect(decodeAccessScopes('dodo:read')).toEqual([]);
    expect(decodeAccessScopes('dodo:read dodo:exec',true)).toEqual(['dodo:read','dodo:exec']);
  });
});

describe('terminal colors', () => {
  it('keeps plain logs unchanged, colors status and never changes the private URL', () => {
    const text = 'Exec: allowed by trusted mode | OS sandbox: NOT enabled';
    expect(formatTerminalLine(text,false)).toBe(text);
    expect(formatTerminalLine(text,true)).toContain('\x1b[33m');
    expect(formatTerminalLine('Auth: OAuth enabled',true)).toContain('\x1b[32m');
    const url = 'http://127.0.0.1:21731/#fixture-token';
    expect(formatTerminalLine(`[dodo] Private config (expires in 8h): ${url}`,true)).toContain(url);
  });
});
