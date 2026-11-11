# DODO MCP 1.4.3 — Dependency security updates & raster image signature hardening

## Summary

- **Direct & Runtime Dependency Security Updates:**
  - `@modelcontextprotocol/server` `2.0.0` → `2.4.0` (`GHSA-jm63-cq47-j5jp`, `GHSA-46jr-4wx8-v453`, `GHSA-rvq5-wwqv-78pq`, `GHSA-f897-62hf-6gxq`)
  - `@modelcontextprotocol/node` `2.0.0` → `2.1.2` (`GHSA-f897-62hf-6gxq`, plus transitive `hono` / `@hono/node-server` updates)
  - `@modelcontextprotocol/express` `2.0.0` → `2.0.2` (`GHSA-rvq5-wwqv-78pq`)
  - `express` `5.2.1` → `5.3.0` (resolving transitive `proxy-addr` `GHSA-jqcg-44mw-7w3h`, `body-parser` `GHSA-27r3-jxmh-p828`, and `qs` `GHSA-6pq8-jhm2-2vcw`)
  - `sharp` & `@img/sharp-wasm32` `0.35.4` → `0.35.5` (`GHSA-wq5f-xc86-pv6w` / `CVE-2026-96889`)
  - `zod` `^4.2.0` → `^4.6.7` (`GHSA-mrhx-c7xc-m3w5`)
- **Defense-in-Depth Raster Image Header Verification:**
  - `imageView`, `inspectResourceFile`, and `imagePreview` now verify PNG/JPEG/GIF/WebP magic-byte signatures before invoking `sharp` / `libvips`, preventing disguised SVG/XML payloads from reaching native vector decoders.
- **Development Toolchain Audit Hygiene:**
  - Updated `@modelcontextprotocol/client` (`2.4.0`), `vitest` (`5.1.0`), `typescript-eslint` (`^8.72.2`), and transitive `minimatch` / `brace-expansion` resolutions (`npm audit` reports `0 vulnerabilities` across both production and development trees).

## Upgrade

```sh
npm install -g dodo-mcp@1.4.3
dodo --version
```
