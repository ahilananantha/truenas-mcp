# Development Notes

This is a maintained fork of [spranab/truenas-mcp](https://github.com/spranab/truenas-mcp).
The upstream package appears unmaintained (single release, no activity since March 2026).

---

## API Migration: REST v2.0 → JSON-RPC 2.0 over WebSocket

### Why

TrueNAS SCALE 25.10 began emitting a `WARNING` alert for any use of the legacy REST API:

> The deprecated REST API was used to authenticate N times in the last 24 hours.
> The REST API will be removed in version 26.04.

The upstream package used `fetch()` against `https://<host>/api/v2.0/` with
`Authorization: Bearer <api_key>` headers. This triggers the deprecation alert on every MCP call.

### What changed

`src/client.ts` was rewritten to connect via WebSocket to `wss://<host>/api/current`
and speak JSON-RPC 2.0, which is the supported API going forward.

The public interface (`get`, `post`, `put`, `delete`, `waitForJob`, `ping`) is unchanged —
all tool files work without modification.

A `call(method, params)` method was also added for direct WebSocket method invocation.

### How path-to-method translation works

The client translates REST-style paths into JSON-RPC method names automatically:

| Verb | Path | WebSocket method | Params |
|------|------|-----------------|--------|
| GET | `/pool` | `pool.query` | `[]` |
| GET | `/pool/id/3` | `pool.get_instance` | `[3]` |
| POST | `/pool` | `pool.create` | `[body]` |
| PUT | `/pool/id/3` | `pool.update` | `[3, body]` |
| DELETE | `/pool/id/3` | `pool.delete` | `[3]` |
| POST | `/pool/id/3/export` | `pool.export` | `[3, body]` |
| POST | `/pool/id/3/get_disks` | `pool.get_disks` | `[3]` |

Sub-resources follow the same rules with dot-notation namespacing:

| Verb | Path | WebSocket method |
|------|------|-----------------|
| GET | `/pool/snapshot` | `pool.snapshot.query` |
| POST | `/pool/snapshot` | `pool.snapshot.create` |
| GET | `/pool/dataset/id/tank%2Fdata` | `pool.dataset.get_instance` |

Query string params on GET calls are converted to filter lists:
`GET /disk?name=sdi` → `disk.query [[["name","=","sdi"]]]`

### Authentication

Old: `Authorization: Bearer <api_key>` HTTP header on every request.

New: One-time JSON-RPC call at connection time:
```json
{ "jsonrpc": "2.0", "id": 1, "method": "auth.login_with_api_key", "params": ["<api_key>"] }
```

### References

- TrueNAS JSON-RPC 2.0 docs: https://api.truenas.com/v25.10/jsonrpc.html
- WebSocket endpoint: `wss://<host>/api/current`

---

## Issue #1 Fix (upstream): App Lifecycle Endpoints

[spranab/truenas-mcp#1](https://github.com/spranab/truenas-mcp/issues/1) reports that
`POST /app/id/{name}/start` (and stop/redeploy/upgrade/rollback) return HTTP 404 on
TrueNAS SCALE 25.10 because the REST paths changed.

**This issue does not affect this fork.** Because we use WebSocket directly, the path
`/app/id/dozzle/start` translates to `app.start ["dozzle"]` — which is the underlying
middleware method and has not changed. The REST path change is irrelevant.

---

## Coverage Gaps

These TrueNAS API namespaces exist on 25.10 but have no tools in this package.

### High priority

**`virt.*`** — Incus/LXC containers, introduced as a flagship feature in TrueNAS SCALE 25.x.
The package has full `vm.*` coverage for QEMU/KVM VMs but no coverage for the newer
container runtime. Methods available:

- `virt.global` — config, pool choices, network config, update
- `virt.instance` — create, delete, start, stop, restart, query, get_instance, update,
  device_add, device_delete, device_list, device_update, image_choices, set_bootable_disk
- `virt.device` — disk_choices, gpu_choices, nic_choices, pci_choices, usb_choices,
  export_disk_image, import_disk_image
- `virt.volume` — create, delete, query, get_instance, import_iso, import_zvol, update

**`alertclasses`** — configure severity level per alert type (e.g. demote a noisy alert
from WARNING to INFO). Methods: `config`, `update`.

**`catalog`** — manage app catalogs: sync, add custom catalogs, browse available apps.
Methods: `apps`, `config`, `get_app_details`, `sync`, `trains`, `update`.

**`app.image`** — Docker image management: pull, delete, query, DockerHub rate limit status.

### Medium priority

**`auth`** — session management. Useful for: listing active sessions
(`auth.sessions`), revoking sessions (`auth.terminate_session`), and checking the
currently authenticated identity (`auth.me`).

**`support`** — submit/attach TrueNAS support tickets directly from the MCP.

**`systemdataset`** — view and change which pool hosts the system dataset
(syslog, reporting DB, etc.).

**`truenas`** — system identity methods: `product_type`, `is_ix_hardware`,
`get_chassis_hardware`, `is_production`. Useful for multi-system management.

### Low priority / out of scope

| Namespace | Reason |
|-----------|--------|
| `nvmet.*` | NVMe over TCP — enterprise SAN, niche |
| `tn_connect` / `truecommand` | iXsystems cloud products |
| `enclosure.label` | Enterprise storage enclosure hardware |
| `vmware` | VMware snapshot quiescing |
| `zfs.resource` | Low-level read-only ZFS resource queries |
| `dns` / `route` | Single read-only queries, nothing to manage |
| `hardware.virtualization` | Single read-only method |
| `auth.twofactor` | Edge case; manageable in UI |

---

## Dependency Notes

- Added `ws` (`^8.18.0`) and `@types/ws` (`^8.5.0`) for WebSocket support.
- Node.js `ws` is used instead of the browser `WebSocket` API since this runs in Node.
- `TRUENAS_VERIFY_SSL=false` is handled at the `ws` connection options level instead of
  the previous `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` global override.
  This is scoped to TrueNAS connections only rather than affecting the entire process.
