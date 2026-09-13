import { Router, type Request, type Response } from 'express';
import type Provider from 'oidc-provider';
import type { Store } from '../store/store.js';
import { phraseFor } from '../util/hash.js';
import { ALL_SCOPES } from '../security/policy.js';
import { OWNER_ACCOUNT_ID } from './constants.js';

/**
 * Owner-consent interactions (spec §8.4).
 *
 * Flow: OAuth client starts → provider creates an interaction bound to the
 * BROWSER session cookie → the page shows a request id + phrase → the owner
 * verifies details on the terminal (`dodo auth pending`) and approves over
 * the private IPC socket (`dodo auth approve -- <id>`) → the SAME browser
 * session completes the interaction (custom-header + SameSite protected) →
 * the provider issues the code to the registered exact redirect URI.
 *
 * The public listener has NO endpoint that approves an interaction from a
 * request id alone: approval state changes only over local IPC, and the
 * complete endpoint requires the provider's own session cookie.
 */

const MAX_PENDING_OAUTH = 20;
export const OAUTH_INTERACTION_TTL_MS = 5 * 60 * 1000;

export interface InteractionRouterOptions {
  provider: Provider;
  store: Store;
  resourceUrl: string;
  /** Static binding (tests). */
  workspaceId?: string;
  epoch?: string;
  /** Per-request binding: the active workspace may be switched at runtime (ADR-019). */
  active?: () => { workspaceId: string; epoch: string };
}

interface OAuthApprovalSummary {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  phrase: string;
}

export function interactionRouter(opts: InteractionRouterOptions): Router {
  const { provider, store } = opts;
  const active = (): { workspaceId: string; epoch: string } => {
    if (opts.active) return opts.active();
    if (opts.workspaceId === undefined || opts.epoch === undefined) throw new Error('interactionRouter needs workspaceId+epoch or active()');
    return { workspaceId: opts.workspaceId, epoch: opts.epoch };
  };
  const router = Router();

  router.get('/interaction/:uid', async (req: Request, res: Response) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const params = details.params as Record<string, unknown>;
      const clientId = String(params['client_id'] ?? '');
      if (!store.getOAuthClient(clientId)) throw new Error('unknown client');
      const redirectUri = String(params['redirect_uri'] ?? '');
      const requested = typeof params['scope'] === 'string' ? (params['scope'] as string).split(' ').filter(Boolean) : [];
      const scopes = requested.filter((s) => (ALL_SCOPES as string[]).includes(s));
      const effectiveScopes = scopes.length > 0 ? scopes : [...ALL_SCOPES];
      const { workspaceId, epoch } = active();
      const existing = store.getApproval(details.uid);
      if (existing && (existing.workspaceId !== workspaceId || existing.epoch !== epoch)) {
        res.status(400).send('Workspace changed; start a fresh authorization request.'); return;
      }
      if (!existing) {
        if (store.listPendingApprovals('oauth').length >= MAX_PENDING_OAUTH) {
          res.status(429).type('text/plain').send('Too many pending authorization requests. Try again later.');
          return;
        }
        const summary: OAuthApprovalSummary = {
          clientId,
          redirectUri,
          scopes: effectiveScopes,
          phrase: phraseFor(details.uid),
        };
        store.createApproval({
          kind: 'oauth',
          workspaceId,
          epoch,
          id: details.uid,
          summary: JSON.stringify(summary),
          ttlMs: OAUTH_INTERACTION_TTL_MS,
        });
      }
      res
        .status(200)
        .type('html')
        .setHeader('Cache-Control', 'no-store')
        .setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")
        .send(interactionPage(details.uid, phraseFor(details.uid), clientId, effectiveScopes));
    } catch {
      res.status(400).type('text/plain').send('Unknown or expired authorization request.');
    }
  });

  router.get('/interaction/:uid/status', async (req: Request, res: Response) => {
    try {
      const details = await provider.interactionDetails(req, res); // session-cookie bound
      const approval = store.getApproval(details.uid);
      res.setHeader('Cache-Control', 'no-store').json({ status: approval?.status ?? 'pending' });
    } catch {
      res.status(400).json({ status: 'unknown' });
    }
  });

  router.post('/interaction/:uid/complete', async (req: Request, res: Response) => {
    try {
      const details = await provider.interactionDetails(req, res); // session-cookie bound
      // Cross-site form posts cannot set custom headers; require one.
      if (req.headers['x-dodo-interaction'] !== details.uid) {
        res.status(403).json({ error: 'bad interaction header' });
        return;
      }
      const { workspaceId, epoch } = active();
      const approval = store.getApproval(details.uid);
      if (!approval || approval.kind !== 'oauth' || approval.workspaceId !== workspaceId || approval.epoch !== epoch || approval.status !== 'approved') {
        res.status(403).json({ error: 'not approved' });
        return;
      }
      if (!store.setApprovalStatus(details.uid, 'consumed')) {
        res.status(403).json({ error: 'approval expired' });
        return;
      }
      const summary = JSON.parse(approval.summary) as OAuthApprovalSummary;
      const params = details.params as Record<string, unknown>;
      const clientId = String(params['client_id'] ?? '');
      if (clientId !== summary.clientId || !store.getOAuthClient(clientId)) {
        res.status(403).json({ error: 'client mismatch' });
        return;
      }
      const grant = new provider.Grant({ accountId: OWNER_ACCOUNT_ID, clientId });
      // Grant at both levels: OIDC scope satisfies the authorization request's
      // `scope` param; resource scope binds the token audience to /mcp.
      // OIDC clients request openid in addition to resource permissions. It
      // must be consented at the OIDC level or the provider prompts forever.
      // Never add it to the workspace's resource permissions.
      const requestedScopes = typeof params['scope'] === 'string' ? params['scope'].split(/\s+/) : [];
      const oidcScopes = [...summary.scopes, 'offline_access'];
      if (requestedScopes.includes('openid')) oidcScopes.push('openid');
      grant.addOIDCScope(oidcScopes.join(' '));
      grant.addResourceScope(opts.resourceUrl, summary.scopes.join(' '));
      const grantId = await grant.save();
      // Deletion may run while provider persistence yields. Never recreate ACLs.
      if (!store.getOAuthClient(clientId)) { await grant.destroy(); throw new Error('client was deleted'); }
      store.putGrant({
        id: grantId,
        workspaceId,
        clientId,
        accountId: OWNER_ACCOUNT_ID,
        scopes: summary.scopes,
      });
      store.setMeta(`identity-grant:${grantId}`, '2');
      store.setClientAccess(workspaceId, clientId, summary.scopes);
      const returnTo = await provider.interactionResult(
        req,
        res,
        { login: { accountId: OWNER_ACCOUNT_ID }, consent: { grantId } },
        { mergeWithLastSubmission: false },
      );
      res.setHeader('Cache-Control', 'no-store').json({ returnTo });
    } catch {
      res.status(400).json({ error: 'interaction failed' });
    }
  });

  return router;
}

function interactionPage(uid: string, phrase: string, clientId: string, scopes: string[]): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DODO authorization</title>
<body style="font-family:system-ui;max-width:38rem;margin:3rem auto;line-height:1.5;padding:0 1rem">
<h1 style="font-size:1.4rem">Authorize this connection on your terminal</h1>
<p>A client is asking for access to a DODO workspace.</p>
<table style="border-collapse:collapse">
<tr><td style="padding:.2rem .8rem .2rem 0;color:#555">Request ID</td><td><code>${esc(uid)}</code></td></tr>
<tr><td style="padding:.2rem .8rem .2rem 0;color:#555">Check phrase</td><td><strong>${esc(phrase)}</strong></td></tr>
<tr><td style="padding:.2rem .8rem .2rem 0;color:#555">Client</td><td><code>${esc(clientId)}</code></td></tr>
<tr><td style="padding:.2rem .8rem .2rem 0;color:#555">Scopes</td><td><code>${esc(scopes.join(' '))}</code></td></tr>
</table>
<p>On the machine running DODO, verify the same request ID, phrase, client, callback URL and workspace with:</p>
<pre style="background:#f4f4f4;padding:.6rem">dodo auth pending
dodo auth approve -- ${esc(uid)}</pre>
<p id="st" aria-live="polite">Waiting for local approval…</p>
<script>
(function(){
  var uid=${JSON.stringify(uid)};
  var done=false;
  function tick(){
    if(done)return;
    fetch('/interaction/'+uid+'/status',{headers:{'accept':'application/json'}}).then(function(r){return r.json()}).then(function(d){
      if(d.status==='approved'){
        done=true;
        document.getElementById('st').textContent='Approved — finishing sign-in…';
        fetch('/interaction/'+uid+'/complete',{method:'POST',headers:{'x-dodo-interaction':uid}}).then(function(r){return r.json()}).then(function(d){
          if(d.returnTo){window.location.assign(d.returnTo);}else{document.getElementById('st').textContent='Error: '+(d.error||'unknown');}
        });
      } else if(d.status==='denied'||d.status==='expired'){
        done=true;document.getElementById('st').textContent='Request '+d.status+'.';
      } else { setTimeout(tick,2000); }
    }).catch(function(){setTimeout(tick,3000)});
  }
  tick();
})();
</script>
</body>`;
}
