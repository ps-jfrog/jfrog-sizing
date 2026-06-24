# /sizing-review

Review the jpd-sizing calculator for correctness based on feedback or a diff, then apply fixes.

## Codebase map

- **`index.html`** — form fields only. Each `<input name="X">` maps to a `document.querySelector('input[name="X"]:checked')` read in `common.js`. SheetJS is loaded from CDN (`xlsx@0.18.5`) for XLSX export. Every field label ends with a `<span class="tip-icon" data-tip="...">i</span>` — the tooltip text lives in the `data-tip` attribute; there are no `<div class="hint">` elements. The CSP meta tag (`script-src 'self' https://cdn.jsdelivr.net; connect-src 'none'; ...`) and SRI hash on the SheetJS `<script>` tag are security-critical — do not remove them.
- **`common.js`** — everything else: `calculate()`, rendering, artifact generators.
  - `toggleConditionalFields()` — shows/hides conditional inputs; must stay in sync with the fields in `index.html`.
  - `calculate()` — reads all form inputs, builds `components[]`, computes `r` (the result object), calls `render(r)`.
  - `buildRow(key, displayName, opts)` — looks up instance/cpu/memGB from `REF_ARCH[cloud][key][tier]`; returns a plain object that can have `.cpu` / `.memGB` mutated after the call for co-located overhead.
  - `buildSizingXlsx(r)` — builds a multi-sheet SheetJS workbook (7 sheets: Inputs, Summary, Components, Databases, Binary Store, Licensing, External Services).
  - `downloadXlsx(r)` — calls `XLSX.writeFile()` to download the workbook as `.xlsx`.
  - `buildHelmValues(r)` — generates `values.yaml` for Kubernetes.
  - `buildAnsibleInventory(r)` / `buildAnsiblePlaybook(r)` / `buildAnsibleVarsFile(r)` — generates the VM Ansible bundle.
  - `buildArtifactPanel(r)` — assembles the Deployment artifacts UI panel.
  - `buildPortsPanel(r)`, `buildNetworkPanel(r)`, etc. — other result panels.
  - `initTooltips()` IIFE at the bottom — creates a single `#tooltip-bubble` div, wires `mouseenter`/`mousemove`/`mouseleave` on every `.tip-icon`, and positions the bubble to follow the cursor (flips left when near the right viewport edge). Uses `textContent` (not `innerHTML`) — tooltip text must be plain text only.

## Key data structures

- **`REF_ARCH[cloud][key][tier]`** — per-cloud instance types and CPU/RAM for each service role (artifactory, nginx, xray, rabbitmq, jas, artifactoryDb, xrayDb). No entry for distribution (it's a co-located add-on).
- **`STORAGE[key][tier]`** — disk GB / IOPS / throughput per service role.
- **`REPLICAS[key][tier]`** — HA replica counts by tier.
- **`COLOCATION_RULES[]`** — verbatim JFrog reference architecture quotes, rendered in the UI.
- **`components[]`** — assembled inside `calculate()`, consumed by `buildSizingXlsx`, `k8sPlan`, VM totals, and all rendering functions. Each entry: `{ name, replicas, instance, cpu, memGB, diskGB, iops, mbps, note }`.

## Co-located services — the pattern

Co-location is deployment-model-specific. Always split the handling:

| Service | VMs | Kubernetes |
|---|---|---|
| **Distribution** | Co-locates on Artifactory VMs: add +2 CPU / +2 GB / +200 GB directly to `artiComp.cpu` / `.memGB` / `artiDisk` | Separate StatefulSet pod with its own PVC — push a distinct `components` entry with `instance: arch.nginx[tier].instance`, `cpu: 1`, `memGB: 2`, `diskGB: ha ? 20 : 5` |
| **AppTrust** | Co-locates on Artifactory VMs: add +2 CPU / +1 GB / +50 GB to `artiExtraCpu` / `artiExtraMem` / `artiDisk` | Separate pod on the Artifactory node pool: push with `instance: arch.artifactory[tier].instance`, `cpu: 1`, `memGB: 2` (pod limits from Helm chart) |
| **UnifiedPolicy** | Co-locates on Artifactory VMs: add +2 CPU / +1 GB / +50 GB to `artiExtraCpu` / `artiExtraMem` / `artiDisk` | Separate pod on the Artifactory node pool: push with `instance: arch.artifactory[tier].instance`, `cpu: 1`, `memGB: 1` |
| **Mission Control** | Bundled into Artifactory router — no extra CPU/RAM/disk on any deployment model | Same |

**K8s pool grouping rule**: `k8sPlan()` groups components by `instance` string. Giving AppTrust/UnifiedPolicy `instance: arch.artifactory[tier].instance` puts them in the Artifactory pool. Giving Distribution `instance: arch.nginx[tier].instance` puts it in the general pool. Use this deliberately.

**VM overhead pattern**:
```js
let artiExtraCpu = 0, artiExtraMem = 0;
// ... set artiExtraCpu / artiExtraMem for each co-located service ...
const artiComp = buildRow("artifactory", "Artifactory", { storage: ..., note: artiNote });
if (artiExtraCpu > 0) { artiComp.cpu += artiExtraCpu; artiComp.memGB += artiExtraMem; }
components.push(artiComp);
```

**Always update these three places** when a service's co-location model changes:
1. The `artiDisk` / `artiExtraCpu` / `artiExtraMem` block inside `calculate()` (Artifactory section)
2. The K8s components push block below it
3. The `applied.push(...)` entries and footnote paragraphs in `buildSizingPanel()`

## What to check

### 1. Form field accuracy
Each field should represent one orthogonal concept. Flags to watch:
- Fields that mix two independent concerns into one selector — split into two separate fields.
- Label names that use K8s-specific terminology for a tool that covers both VMs and Kubernetes.
- Options only valid in combination with another field — enable/disable in `toggleConditionalFields()`.
- The `lb` and `nginx_rp` fields are independent: `lb` (none / external) controls whether an external LB exists; `nginx_rp` (provision / skip) controls whether NGINX is deployed. Skipping NGINX is only possible when `lb === "external"` — enforce this in `toggleConditionalFields()`.

**Adding or editing a field:**
1. In `index.html`: add the field markup with a `<span class="tip-icon" data-tip="...">i</span>` on the label. No `<div class="hint">` — tooltip text only. Keep `data-tip` values as **plain text** (no HTML tags; `initTooltips` uses `textContent`).
2. In `common.js`: wire the read in `calculate()` and, if conditional, in `toggleConditionalFields()`.
3. Update the Inputs sheet in `buildSizingXlsx(r)`.
4. Run the consistency grep (see §5 below).

### 2. Deployment artifact accuracy — Ansible (VM path)
The Ansible bundle uses the **official `jfrog.platform` collection** (`ansible-galaxy collection install jfrog.platform community.general community.postgresql`).
- Inventory group names: `artifactory_servers`, `xray_servers`, `nginx_servers`, `postgres_servers`, `rabbitmq_servers`, `catalog_servers`, `runtime_servers`.
- Top-level group: `[jfrog_site:children]` with all component groups listed.
- Plays use FQCN roles: `jfrog.platform.artifactory`, `jfrog.platform.artifactory_nginx`, `jfrog.platform.xray`, `jfrog.platform.distribution`, `jfrog.platform.postgres`.
- User sets variables in `group_vars/all/vars.yml` — no hand-crafted `system.yaml.j2`.
- Products not in the collection yet (Catalog, Runtime) fall back to manual archive + `installService.sh`, with a comment explaining the gap.
- Description text must reference: https://galaxy.ansible.com/ui/repo/published/jfrog/platform/

### 3. Deployment artifact accuracy — Helm (K8s path)
- Chart: `jfrog/jfrog-platform` (umbrella chart via `helm repo add jfrog https://charts.jfrog.io`).
- Workers and Runtime are **not** in the umbrella — they need separate `helm upgrade --install` commands.
- `nginx.enabled: false` when `!r.provisionNginx` (LB routes directly to Artifactory).
- AppTrust and UnifiedPolicy are sub-keys under `artifactory:` in the chart values (`artifactory.apptrust.*`, `artifactory.unifiedpolicy.*`).

### 4. XLSX export integrity
The export has 7 sheets. When adding new data to the calculator, check which sheet it belongs in and update `buildSizingXlsx(r)`:
- **Inputs** — form settings / projected values (pass numbers as JS numbers, not strings).
- **Summary** — aggregate footprint table + K8s cluster plan (with "Runs" column listing services per pool).
- **Components** — one row per component entry in `r.components[]`.
- **Databases** — DB list + instance sizing detail from `r.dbProducts[]`.
- **Binary Store** — `BINARY_STORE[r.cloud]` options.
- **Licensing** — `licenseCount(r)` results.
- **External Services** — only added to the workbook when external RMQ or Valkey is configured.

### 5. Consistency check after any field rename
When a form field is renamed or split, grep for all of the following and update each site:
- `document.querySelector('input[name="OLD"]')` in `common.js`
- `data-name="OLD"` in `index.html`
- `id="OLDField"` show/hide in `toggleConditionalFields()`
- Inputs sheet row in `buildSizingXlsx(r)` (around the `inputs.push(...)` block)
- Output HTML in `buildArtifactPanel`, `buildPortsPanel`, `buildNetworkPanel`, topology chip row

### 6. Tooltip text
`data-tip` values are plain text — no `<`, `>`, or HTML tags. If an explanation requires markup, rephrase it. The `initTooltips()` IIFE at the bottom of `common.js` renders via `textContent`; changing it to `innerHTML` would be an XSS risk (even though values are authored, keep the constraint to avoid future accidents).

## jf-k8s repo sync

When the sizing calculator changes topology (co-location, replica counts, resource limits), also update `/Users/rahulja/Documents/github/rahulkj/jf-k8s`:
- **`helm-values-cloud-ha.yaml`** — HA replica counts for services within the Artifactory subchart (e.g., `artifactory.apptrust.replicaCount`, `artifactory.unifiedpolicy.replicaCount`).
- **`terraform/variables.tf`** — variable descriptions for version/topology variables.
- **`terraform/terraform.tfvars.example`** — co-location comments and node-pool overlay documentation.
- **`terraform/README.md`** — "Co-located services" and "Dedicated pools" tables. Distribution is a dedicated StatefulSet on K8s (own PVC, own pod) — it does NOT belong in the co-located table.

## How to apply feedback

1. Read the feedback and identify which category above it falls into.
2. Read the affected section of `index.html` and `common.js` to understand current state.
3. For field changes: update `index.html` first (new `name=` attribute), then `toggleConditionalFields()`, then `calculate()`.
4. For co-location changes: update all three places (Artifactory section, K8s components block, `applied.push` + footnote).
5. Run the consistency grep before declaring done.
6. Verify the `buildArtifactPanel` description text and download bundle filenames match the new structure.
7. If topology changed, sync the jf-k8s repo.
