# JFrog Platform Deployment (JPD) Sizing Calculator

HTML calculators that translate workload inputs (active clients, RPM, indexed artifacts, storage, topology) into a fully spec'd JPD deployment — instance types, replica counts, storage IOPS, co-location rules, and a procurement list — for AWS, Azure, GCP, and Private Datacenter, on either VMs or Kubernetes.

Sizing values are pulled verbatim from JFrog's published documentation:

- [JFrog Self-Managed Reference Architecture](https://jfrog.com/reference-architecture/self-managed/deployment/sizing/) (tier definitions, replica counts, per-cloud instance types)
- [AWS](https://jfrog.com/reference-architecture/self-managed/deployment/sizing/aws/) · [Azure](https://jfrog.com/reference-architecture/self-managed/deployment/sizing/azure/) · [GCP](https://jfrog.com/reference-architecture/self-managed/deployment/sizing/gcp/) sizing pages
- [Storage Specifications](https://jfrog.com/reference-architecture/self-managed/deployment/sizing/storage/) (per-tier disk size, IOPS, throughput)
- [Hardware Sizing Matrix](https://docs.jfrog.com/installation/docs/hardware-sizing-matrix) (Artifactory by active clients, Xray by indexed artifacts, Distribution / Workers / AppTrust / UnifiedPolicy)

---

## Files

| File | What it does |
|---|---|
| [`index.html`](./index.html) | The calculator page — all inputs and the output panel. Thin: just markup + the `common.js`/`common.css` includes. |
| [`common.js`](./common.js) | The whole application: JFrog reference data (`REF_ARCH`, `REPLICAS`, `STORAGE`, …), tier helpers, `calculate()`, `render()` (single **and** Active+Passive, VM **and** Kubernetes), the CSV exporter, and the Helm/Ansible artifact generators. |
| [`common.css`](./common.css) | Shared styles. |

No build, no server, no external dependencies — open `index.html` directly in any modern browser. `common.css`/`common.js` load via plain `<link>`/`<script src>` (works over `file://`), so keep `index.html`, `common.css`, and `common.js` together.

```sh
open index.html
```

---

## Inputs

The calculator accepts these inputs (some are shown conditionally — e.g. Passive site scale only when Active+Passive, Kubernetes placement only when Kubernetes):

| Input | Drives |
|---|---|
| **Target environment** — AWS / Azure / GCP / Private Datacenter | Per-cloud instance type catalog, storage class, network guidance |
| **Deployment model** — Virtual Machines / Kubernetes | Per-component VM picks (for K8s these are worker-node recommendations) |
| **Kubernetes placement** — Dedicated node pool / Anti-affinity (shared pool) | How Artifactory replicas are spread on K8s (shown only for Kubernetes) |
| **Topology** — Single active cluster / Active + Passive (DR) | Whether a passive site is sized alongside the active |
| **Passive site scale** — Hot (mirror) / Warm (minimal) | Replica count on the passive site (shown only for Active+Passive) |
| **Active concurrent clients** | Artifactory tier suggestion (≤20 Small, ≤100 Medium, ≤200 Large, >200 contact support) |
| **Peak RPM** | Tier suggestion (≤6K Small, ≤50K Medium, ≤100K Large, ≤200K XLarge, ≤500K 2XLarge) and concurrent connection cap |
| **Binary storage (TB)** | Object-storage backend size and Artifactory DB disk (= 1/3 of filestore) |
| **Local cache-fs** — Enabled (default) / Disabled, with size % (default 20%) | Adds a local SSD cache per Artifactory replica that fronts the object store, serving hot binaries at local-disk latency. Sized as a percentage of the binary footprint and folded into each Artifactory node's disk |
| **Indexed artifacts** (Xray) | Xray node count, CPU/RAM/disk, RabbitMQ replicas, Xray DB sizing |
| **Planned growth headroom (%)** — default 25% | Scales the four load drivers above (clients, RPM, binary storage, indexed artifacts) so the deployment is sized for the projected future state. Set to 0 to size for today only |
| **HA** | Multi-replica vs single-node deployment |
| **Ingress** — JFrog NGINX / Load Balancer | Whether the bundled NGINX reverse-proxy tier is provisioned. With a Load Balancer, a follow-up **"LB routes to"** question (shown only then) chooses **Artifactory** (no NGINX tier — LB hits Artifactory's built-in router) or **NGINX** (keep NGINX behind the LB). The LB is auto-named per cloud (ALB/NLB, App Gateway, GCLB; "External / hardware LB" on-prem) |
| **RabbitMQ (Xray messaging)** — Bundled / External | External removes the RMQ nodes from the platform footprint (and the K8s worker plan). The results then show the recommended external cluster size plus the required plugins (`rabbitmq_management`, quorum queues, …) and a `system.yaml` configuration checklist |
| **Optional services** — Distribution, JAS, Workers, AppTrust+UnifiedPolicy, Mission Control, Curation+Catalog, Runtime Security | Adds (or co-locates) the corresponding components. Mission Control is bundled into Artifactory (no standalone node or DB — just enables the UI integration). Curation adds the Curation + Catalog services, a Catalog database, and a Valkey cache. **Runtime Security** adds a Runtime server (its own `runtime` DB) plus a per-node sensor DaemonSet, both as **separate Helm releases** (`jfrog/runtime`, `jfrog/runtime-sensors`) outside the `jfrog-platform` umbrella |
| **Valkey (Curation/Catalog cache)** — Co-located / External *(shown only when Curation is selected)* | Co-located folds Valkey onto the Catalog nodes (+RAM, no new VMs); External removes it from the footprint and shows a recommended Valkey/Redis cluster size + configuration |
| **Database** — Co-located (default) / External | Co-located = a PostgreSQL provisioned with the deployment (the Helm chart's bundled DB on K8s, or DB nodes alongside the platform on VMs) — counts toward the footprint and the K8s worker plan. External = any managed/standalone RDBMS run separately (RDS / Cloud SQL / Flexible Server / self-managed) — sized but outside the footprint. Drives the Helm mode: co-located → bundled `postgresql` + filesystem PVC; external → `postgresql.enabled: false` + per-service `database:` blocks + object-store binarystore |
| **Database instances** — Shared (default) / Dedicated per product | Each product always gets its own **logical database** (`artifactory`, `xraydb`, `distribution`, `catalogdb`, `runtime`). **Shared** = one PostgreSQL *instance* hosts them all (typical; matches the bundled chart) — sized to the dominant (Artifactory) DB with `max_connections` ≥ the sum, so the **VM form factor collapses to one DB node** (×2 for HA). **Dedicated** = a separate instance per product (one DB node per product). |

The effective tier is `max(client-implied, RPM-implied)`, computed on the growth-adjusted (projected) load. The chosen tier drives **every** per-component spec. The output summary shows the today → projected values whenever growth headroom is non-zero.

---

## Outputs

- **Deployment summary** — environment, model, tier, HA, placement strategy, topology.
- **Notes & warnings** — danger/warn/info banners for support-required tiers, JAS without Xray, K8s vs Helm preset clarification, and a **minimum-subscription callout** (the same effective tier as the Licensing section, with JAS / Runtime add-on flags), etc.
- **Licensing** — maps the selected products to the minimum JFrog self-hosted subscription tier (**Pro → Enterprise X → Enterprise+**) and highlights the single tier the customer needs, with a per-product breakdown (HA/Xray → Enterprise X; Distribution/Mission Control/Curation/AppTrust/Active+Passive → Enterprise+; **JAS is a paid add-on** on top of Xray). Also shows the Artifactory license count consumed (one per HA node, ×2 for Active+Passive) and how the license is applied (VM `artifactory.lic` vs Helm Secret). Tiers/inclusions change — links to JFrog subscriptions & license-management docs and flags confirming with JFrog.
- **Aggregate footprint** — total nodes, vCPU, RAM, service disk, binary storage, network. In Active+Passive: separate cards per site plus a grand total.
- **Kubernetes cluster plan** (K8s deployments only) — worker-node count and node-pool breakdown (VM size × nodes, what each pool runs), total worker capacity, and the recommended cluster size including ~15% headroom for kubelet/OS/CNI and system DaemonSets. Managed databases are excluded from the worker plan (provisioned as external managed services); self-hosted PostgreSQL is counted. Notes the managed (EKS/AKS/GKE) vs self-managed (3 control-plane nodes) control plane. Rendered per site in Active+Passive.
- **Per-component table** — for each JFrog component: replicas, vCPU, RAM, disk + IOPS, recommended VM instance, contextual notes.
- **VM procurement list** — group-by-instance tally: VM SKU, count, components served. (Two lists when Active+Passive.)
- **Co-location rules** — verbatim quotes from JFrog reference architecture (e.g. *"Distribution can run on the Artifactory nodes"*, *"Each Artifactory replica should run in its own instance"*) plus an Applied-in-this-configuration breakdown.
- **Storage & network** — block class, premium DB class, **JFrog-recommended binary store for the selected cloud** (the preferred option flagged *JFrog recommended* with its `binarystore.xml` template, plus the other options), network guidance, load-balancer note (with reverse-proxy config links), K8s notes (CSI driver, LB, ingress). Per cloud: AWS → Amazon S3, Azure → Azure Blob Storage, GCP → Google Cloud Storage, on-prem → S3-compatible object storage; alternatives are NFS (`cluster-file-system`) and single-node file system.
- **Ports & connectivity** — deployment-aware list of the network ports to open, conditioned on the components in play. **Virtual Machines**: inter-node/firewall rules (client → Nginx/LB on 443/80, Router 8082, Artifactory 8081, HA inter-node 8081/8082/8040, PostgreSQL 5432, RabbitMQ 5672/5671 + clustering 25672/4369, Valkey 6379/6380, Xray 8000, cross-site replication for Active+Passive). **Kubernetes**: external ingress (443/80), egress to any external DB/RabbitMQ/Valkey, the intra-cluster service ports for NetworkPolicies, and the standard cluster ports. Links to the JFrog network-ports docs.
- **Database setup** — the databases + DB users to create for each selected service (Artifactory, Xray (+JAS shares it), Distribution, Catalog) — Mission Control is bundled into Artifactory and needs no separate DB — the `CREATE DATABASE` template, a `system.yaml` connection block, required PostgreSQL version, and the `max_connections` floor derived from the tier's connection caps. Links to the JFrog database docs.
- **External RabbitMQ setup** (when RMQ externalized) — recommended cluster size, required plugins, and a configuration checklist (vhost/user, quorum, ports, `system.yaml`). Links to the JFrog external-RabbitMQ docs.
- **Derivation notes** — collapsible section explaining what's verbatim vs derived.
- **Export to CSV** — the **⤓ Export to CSV** button (under *Calculate sizing*) downloads the full configuration as a multi-section CSV: inputs, aggregate footprint, the recommended binary store + alternatives, per-component sizing (with an Active/Passive site column), the Kubernetes cluster plan, the databases to create, and any external-service recommendations (RabbitMQ / Valkey). Filename: `jpd-sizing-<cloud>-<tier>-<date>.csv`. Pure client-side download — no server.
- **Deployment artifacts** — a collapsible panel generated from the sizing, keyed to the deployment model:
  - **Kubernetes** → a `values.yaml` for the unified `jfrog/jfrog-platform` Helm chart, modeled on the proven reference values in `jf-k8s/` (`helm-values-k8s.yaml` self-contained, `helm-values-k8s-external.yaml` external). The **Database** input selects the mode: *Co-located* → bundled PostgreSQL + filesystem PVC; *External* → external PostgreSQL + per-cloud object-store binarystore (`s3-storage-v3-direct` / `azure-blob-storage` / `google-storage-v2`). Component toggles (Curation/Catalog, JAS, AppTrust+UnifiedPolicy, Workers, Distribution, Mission Control) map to the chart's `extraSystemYaml` flags and top-level keys; NGINX on/off follows the ingress choice. **External RabbitMQ and external Valkey are layered on** (the reference files keep both bundled). Replicas/resources come from the sizing. Validated with `helm template` against the live chart. Plus `helm repo add`/`upgrade --install` commands and a **Download values.yaml** button.
  - **Virtual Machines** → an Ansible bundle (`inventory.ini` grouped by role with counts from the sizing, a `site.yml` following the manual Linux-archive install, and a `system.yaml.j2` template wired for the external DB / HA / external RabbitMQ) plus a **Download Ansible bundle** button. (JFrog ships no single official Ansible collection; this is a manual-install scaffold.)

  Both are **sizing-derived starting templates** with placeholder secrets — validate against your chart/installer version before use.

---

## Components modeled

| Component | Source for sizing |
|---|---|
| Artifactory | Reference architecture (per-cloud, per-tier instance + replicas) |
| Nginx | Reference architecture (dedicated VM per replica) |
| Artifactory PostgreSQL | Reference architecture DB instance + connection cap; disk = 1/3 of binary filestore at per-tier IOPS |
| Xray | Reference architecture (per-cloud, per-tier instance + replicas) |
| RabbitMQ | Reference architecture; **always odd-numbered** to maintain quorum (1, 3, 5…) — rounded up automatically |
| Xray PostgreSQL | Reference architecture DB; per-tier disk 500–2500 GB at 4K–12K IOPS |
| JAS (Advanced Security) | Reference architecture; dedicated node pool to protect Xray + Artifactory |
| Distribution | Hardware sizing matrix; co-located on Artifactory nodes (+200 GB disk, no new VMs) |
| Workers | Hardware sizing matrix (4 CPU / 4 GB / 50 GB) |
| AppTrust + UnifiedPolicy | Hardware sizing matrix (2 CPU / 1 GB / 50 GB each) |
| Mission Control | Bundled into Artifactory (platform service on the router) — no standalone node or database; selecting it only enables the UI integration (`artifactory.mc.enabled`) |
| Runtime Security | Estimate: a Runtime server (2 CPU / 4 GB, HA → 2) with its own `runtime` DB, plus a per-node sensor DaemonSet (no dedicated nodes). Separate `jfrog/runtime` + `jfrog/runtime-sensors` releases |

### Co-location rules surfaced

The Co-location panel quotes the JFrog rules verbatim:

- *"Distribution can run on the Artifactory nodes"* → co-located, +200 GB Artifactory disk.
- *"Each Artifactory / Nginx / Xray replica should run in its own instance (prefer a dedicated node pool)"* → one VM (or one K8s node, or anti-affinity-spread pod) per replica.
- *"If running JAS, it's recommended to use a dedicated node pool for it to protect Xray and Artifactory pods"* → dedicated node for JAS.
- Xray HA / >100K artifacts → RabbitMQ split mode on separate VMs from Xray.
- RabbitMQ must be deployed in odd-numbered clusters (1, 3, 5, …) for quorum.

---

## One page, all scenarios

A single calculator (`index.html`) covers everything. For a quick single-cluster sizing, leave **Topology = Single active cluster** (the default). The advanced controls surface only when relevant:

- **Kubernetes placement** (dedicated node pool vs anti-affinity on a shared pool) appears when you pick Kubernetes.
- **Topology = Active + Passive (DR)** sizes a passive site (Hot mirror for instant failover, or Warm minimal that runs lean and scales up on failover) and renders per-site footprints plus a grand-total card.

> The former separate HA-only page (`ha-index.html`) was merged into this single page, so there's one implementation to maintain.

---

## What's verbatim vs derived

**Verbatim from JFrog docs:**

- Artifactory by active clients: `4/6`, `6/12`, `8/18`, then support
- RPM tier names and concurrent-connection caps
- Per-cloud instance types and replica counts per tier
- Per-tier storage size, IOPS, throughput
- Hardware sizing matrix specs for Distribution, Workers, AppTrust, UnifiedPolicy
- Co-location rule quotes

**Calculator-derived:**

- Tier selection logic (`max(client-implied, RPM-implied)`) — JFrog gives the two tier tables independently but doesn't prescribe a combinator.
- On-prem instance types — JFrog publishes per-cloud SKUs only, so on-prem mirrors the cloud CPU/RAM as generic VMs.
- Active+Passive sizing — DR is a topology pattern, not a JFrog sizing table; the calculator mirrors (Hot) or minimizes (Warm) the active replicas.
- RabbitMQ odd-replica enforcement — RabbitMQ quorum requirement is well-known but not explicit in JFrog's tables (their published values are already odd).

Validate any output with your JFrog SE before procurement.

---

## License / Disclaimer

These calculators are an unofficial planning aid. Sizing numbers are sourced from publicly accessible JFrog documentation as of the date the calculator was built — refresh against the live docs before signing infrastructure POs.
