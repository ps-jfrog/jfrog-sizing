# JFrog Platform Deployment (JPD) Sizing Calculator

Single-file HTML calculators that translate workload inputs (active clients, RPM, indexed artifacts, storage, topology) into a fully spec'd JPD deployment — instance types, replica counts, storage IOPS, co-location rules, and a procurement list — for AWS, Azure, GCP, and Private Datacenter, on either VMs or Kubernetes.

Sizing values are pulled verbatim from JFrog's published documentation:

- [JFrog Self-Managed Reference Architecture](https://jfrog.com/reference-architecture/self-managed/deployment/sizing/) (tier definitions, replica counts, per-cloud instance types)
- [AWS](https://jfrog.com/reference-architecture/self-managed/deployment/sizing/aws/) · [Azure](https://jfrog.com/reference-architecture/self-managed/deployment/sizing/azure/) · [GCP](https://jfrog.com/reference-architecture/self-managed/deployment/sizing/gcp/) sizing pages
- [Storage Specifications](https://jfrog.com/reference-architecture/self-managed/deployment/sizing/storage/) (per-tier disk size, IOPS, throughput)
- [Hardware Sizing Matrix](https://docs.jfrog.com/installation/docs/hardware-sizing-matrix) (Artifactory by active clients, Xray by indexed artifacts, Distribution / Workers / AppTrust / UnifiedPolicy)

---

## Files

| File | What it does |
|---|---|
| [`index.html`](./index.html) | Baseline calculator. Inputs: cloud, deployment model, active clients, RPM, binary storage, Xray scale, HA, optional services, database. Outputs: per-component sizing, instance procurement list, co-location rules. |
| [`ha-index.html`](./ha-index.html) | Same as `index.html` **plus** two additional features: (a) Kubernetes HA placement strategy (dedicated node pool vs `podAntiAffinity` on a shared pool) and (b) multi-cluster topology (single active vs Active+Passive DR with Hot/Warm passive scaling). When Active+Passive is chosen, the output renders two complete cluster sections and a grand total. |

Both files are self-contained — no build, no server, no dependencies. Open in any modern browser.

```sh
open index.html       # or
open ha-index.html
```

---

## Inputs

Both calculators accept these inputs (the second file adds two more, marked **\***):

| Input | Drives |
|---|---|
| **Target environment** — AWS / Azure / GCP / Private Datacenter | Per-cloud instance type catalog, storage class, network guidance |
| **Deployment model** — Virtual Machines / Kubernetes | Per-component VM picks (for K8s these are worker-node recommendations) |
| **\* Kubernetes placement** — Dedicated node pool / Anti-affinity (shared pool) | How Artifactory replicas are spread on K8s — `ha-index.html` only |
| **\* Topology** — Single active cluster / Active + Passive (DR) | Whether a passive site is sized alongside the active — `ha-index.html` only |
| **\* Passive site scale** — Hot (mirror) / Warm (minimal) | Replica count on the passive site — `ha-index.html` only |
| **Active concurrent clients** | Artifactory tier suggestion (≤20 Small, ≤100 Medium, ≤200 Large, >200 contact support) |
| **Peak RPM** | Tier suggestion (≤6K Small, ≤50K Medium, ≤100K Large, ≤200K XLarge, ≤500K 2XLarge) and concurrent connection cap |
| **Binary storage (TB)** | Object-storage backend size and Artifactory DB disk (= 1/3 of filestore) |
| **Indexed artifacts** (Xray) | Xray node count, CPU/RAM/disk, RabbitMQ replicas, Xray DB sizing |
| **HA** | Multi-replica vs single-node deployment |
| **Optional services** — Distribution, JAS, Workers, AppTrust+UnifiedPolicy, Mission Control | Adds (or co-locates) the corresponding components |
| **Database** — Managed / Self-hosted PostgreSQL | DB instance name and replication note |

The effective tier is `max(client-implied, RPM-implied)`. The chosen tier drives **every** per-component spec.

---

## Outputs

- **Deployment summary** — environment, model, tier, HA, placement strategy, topology.
- **Notes & warnings** — danger/warn/info banners for support-required tiers, JAS without Xray, K8s vs Helm preset clarification, etc.
- **Aggregate footprint** — VM instances, vCPU, RAM, service disk, binary storage, network. In Active+Passive: separate cards per site plus a grand total.
- **Per-component table** — for each JFrog component: replicas, vCPU, RAM, disk + IOPS, recommended VM instance, contextual notes.
- **VM procurement list** — group-by-instance tally: VM SKU, count, components served. (Two lists when Active+Passive.)
- **Co-location rules** — verbatim quotes from JFrog reference architecture (e.g. *"Distribution can run on the Artifactory nodes"*, *"Each Artifactory replica should run in its own instance"*) plus an Applied-in-this-configuration breakdown.
- **Storage & network** — block class, premium DB class, object backend, network guidance, K8s notes (CSI driver, LB, ingress).
- **Derivation notes** — collapsible section explaining what's verbatim vs derived.

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
| Mission Control | Hardware sizing matrix (4 CPU / 8 GB / 100 GB) |

### Co-location rules surfaced

The Co-location panel quotes the JFrog rules verbatim:

- *"Distribution can run on the Artifactory nodes"* → co-located, +200 GB Artifactory disk.
- *"Each Artifactory / Nginx / Xray replica should run in its own instance (prefer a dedicated node pool)"* → one VM (or one K8s node, or anti-affinity-spread pod) per replica.
- *"If running JAS, it's recommended to use a dedicated node pool for it to protect Xray and Artifactory pods"* → dedicated node for JAS.
- Xray HA / >100K artifacts → RabbitMQ split mode on separate VMs from Xray.
- RabbitMQ must be deployed in odd-numbered clusters (1, 3, 5, …) for quorum.

---

## Choosing between the two files

Use **`index.html`** if you want a quick single-cluster sizing for a stable workload.

Use **`ha-index.html`** if you also need to:

- Choose between dedicated K8s node pool vs anti-affinity on a shared pool (matters for cost / cluster ergonomics).
- Size a DR setup with a passive site (Hot mirror for instant failover, or Warm minimal where the passive runs lean and scales up on failover).
- See per-site footprints alongside a grand-total card.

Both calculators share identical sizing logic for a single active cluster — the additions in `ha-index.html` only show up when you select Kubernetes or Active+Passive.

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
