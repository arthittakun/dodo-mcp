# ADR-002 — User-managed external named tunnel

**Status:** superseded in part by ADR-031; external mode remains supported

**Decision.** DODO binds `127.0.0.1:21730` and nothing else. The user runs their
own Cloudflare named tunnel (or equivalent) and owns DNS/firewall. This remains
the `external` mode. ADR-031 adds an explicit local-owner option to supervise
only `cloudflared`; DODO still never creates/deletes tunnels, manages DNS or
opens ports.

**Trade-off.** The user does more setup and holds the tunnel credentials. In
return DODO holds no cloud secrets and has no relay/SaaS to trust.

**Evidence / validation.** A named tunnel + stable hostname is the recommended
baseline because Quick Tunnels do not support SSE and lack hostname persistence
for OAuth callbacks (spec §2.4/§17, source [S11]). A local reverse-proxy fixture
([examples/reverse-proxy-fixture.mjs](../../examples/reverse-proxy-fixture.mjs))
reproduces the full-path forwarding for automated OAuth testing; real-tunnel
end-to-end is a manual gate (MAN-02). See [docs/TUNNEL.md](../TUNNEL.md).
