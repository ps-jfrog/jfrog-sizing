/* =============================================================================
   The JPD Sizing Calculator application + shared data for index.html.
   Loaded as a CLASSIC script (no module/import) so it works over file:// too.
   Contains: JFrog reference data, tier helpers, fmtGB(), the CSV exporter, the
   Helm/Ansible artifact generators, and calculate()/render() + UI wiring.
   ============================================================================= */

/* =========================================================================
   JFrog reference architecture data — verbatim from published JFrog tables.
   Sources:
     - jfrog.com/reference-architecture/self-managed/deployment/sizing/{aws,azure,gcp}/
     - jfrog.com/reference-architecture/self-managed/deployment/sizing/storage/
     - docs.jfrog.com/installation/docs/hardware-sizing-matrix
   ========================================================================= */

const TIER_ORDER = ["small", "medium", "large", "xlarge", "2xlarge"];
const TIER_LABEL = { small:"Small", medium:"Medium", large:"Large", xlarge:"XLarge", "2xlarge":"2XLarge" };

// Tier classification from RPM + concurrent connection caps (reference architecture).
const TIER_RPM = {
  small:     { maxRpm: 6000,   maxConns: 100  },
  medium:    { maxRpm: 50000,  maxConns: 500  },
  large:     { maxRpm: 100000, maxConns: 1200 },
  xlarge:    { maxRpm: 200000, maxConns: 3000 },
  "2xlarge": { maxRpm: 500000, maxConns: 6000 }
};

// Map concurrent HTTP connections → tier using reference architecture thresholds.
// (Small ≤100, Medium ≤500, Large ≤1,200, XLarge ≤3,000, 2XLarge ≤6,000)
// This aligns with TIER_RPM.maxConns and lets XLarge (4 Artifactory nodes) be reachable.
function tierFromConns(c) {
  if (c <= 100)  return "small";
  if (c <= 500)  return "medium";
  if (c <= 1200) return "large";
  if (c <= 3000) return "xlarge";
  return "2xlarge";
}
function tierFromRpm(rpm) {
  if (rpm <= 6000)   return "small";
  if (rpm <= 50000)  return "medium";
  if (rpm <= 100000) return "large";
  if (rpm <= 200000) return "xlarge";
  return "2xlarge";
}
function maxTier(a, b) {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

// Replicas per tier per component (reference architecture, identical across clouds).
const REPLICAS = {
  artifactory: { small:1, medium:2, large:3, xlarge:4, "2xlarge":6 },
  nginx:       { small:1, medium:2, large:2, xlarge:2, "2xlarge":3 },
  xray:        { small:1, medium:2, large:2, xlarge:2, "2xlarge":3 },
  rabbitmq:    { small:1, medium:3, large:3, xlarge:3, "2xlarge":3 },
  jas:         { small:1, medium:1, large:1, xlarge:1, "2xlarge":1 }
};

// JFrog-published instance types per cloud per tier per component.
const REF_ARCH = {
  aws: {
    artifactory: {
      small:     { instance:"m8g.2xlarge", cpu:8,  memGB:32 },
      medium:    { instance:"m8g.2xlarge", cpu:8,  memGB:32 },
      large:     { instance:"m8g.4xlarge", cpu:16, memGB:64 },
      xlarge:    { instance:"m8g.4xlarge", cpu:16, memGB:64 },
      "2xlarge": { instance:"m8g.4xlarge", cpu:16, memGB:64 }
    },
    nginx: {
      small:     { instance:"c8g.xlarge",  cpu:4, memGB:8  },
      medium:    { instance:"c8g.xlarge",  cpu:4, memGB:8  },
      large:     { instance:"c8g.xlarge",  cpu:4, memGB:8  },
      xlarge:    { instance:"c8g.2xlarge", cpu:8, memGB:16 },
      "2xlarge": { instance:"c8g.2xlarge", cpu:8, memGB:16 }
    },
    xray: {
      small:     { instance:"c8g.2xlarge", cpu:8, memGB:16 },
      medium:    { instance:"m8g.2xlarge", cpu:8, memGB:32 },
      large:     { instance:"m8g.2xlarge", cpu:8, memGB:32 },
      xlarge:    { instance:"m8g.2xlarge", cpu:8, memGB:32 },
      "2xlarge": { instance:"m8g.2xlarge", cpu:8, memGB:32 }
    },
    rabbitmq: {
      small:     { instance:"c8g.xlarge", cpu:4, memGB:8 },
      medium:    { instance:"c8g.xlarge", cpu:4, memGB:8 },
      large:     { instance:"c8g.xlarge", cpu:4, memGB:8 },
      xlarge:    { instance:"c8g.xlarge", cpu:4, memGB:8 },
      "2xlarge": { instance:"c8g.xlarge", cpu:4, memGB:8 }
    },
    jas: {
      small:     { instance:"m8g.2xlarge", cpu:8, memGB:32 },
      medium:    { instance:"m8g.2xlarge", cpu:8, memGB:32 },
      large:     { instance:"m8g.2xlarge", cpu:8, memGB:32 },
      xlarge:    { instance:"m8g.2xlarge", cpu:8, memGB:32 },
      "2xlarge": { instance:"m8g.2xlarge", cpu:8, memGB:32 }
    },
    artifactoryDb: {
      small:     { instance:"db.m8g.2xlarge",  cpu:8,  memGB:32,  maxConns:100  },
      medium:    { instance:"db.m8g.4xlarge",  cpu:16, memGB:64,  maxConns:200  },
      large:     { instance:"db.m8g.8xlarge",  cpu:32, memGB:128, maxConns:600  },
      xlarge:    { instance:"db.m8g.12xlarge", cpu:48, memGB:192, maxConns:2000 },
      "2xlarge": { instance:"db.m8g.16xlarge", cpu:64, memGB:256, maxConns:5000 }
    },
    xrayDb: {
      small:     { instance:"db.m8g.xlarge",   cpu:4,  memGB:16,  maxConns:200  },
      medium:    { instance:"db.m8g.2xlarge",  cpu:8,  memGB:32,  maxConns:500  },
      large:     { instance:"db.m8g.4xlarge",  cpu:16, memGB:64,  maxConns:600  },
      xlarge:    { instance:"db.m8g.8xlarge",  cpu:32, memGB:128, maxConns:1200 },
      "2xlarge": { instance:"db.m8g.12xlarge", cpu:48, memGB:192, maxConns:2000 }
    }
  },
  azure: {
    artifactory: {
      small:     { instance:"Standard_D8s_v6",  cpu:8,  memGB:32 },
      medium:    { instance:"Standard_D8s_v6",  cpu:8,  memGB:32 },
      large:     { instance:"Standard_D16s_v6", cpu:16, memGB:64 },
      xlarge:    { instance:"Standard_D16s_v6", cpu:16, memGB:64 },
      "2xlarge": { instance:"Standard_D16s_v6", cpu:16, memGB:64 }
    },
    nginx: {
      small:     { instance:"Standard_F4s_v2", cpu:4, memGB:8  },
      medium:    { instance:"Standard_F4s_v2", cpu:4, memGB:8  },
      large:     { instance:"Standard_F4s_v2", cpu:4, memGB:8  },
      xlarge:    { instance:"Standard_F8s_v2", cpu:8, memGB:16 },
      "2xlarge": { instance:"Standard_F8s_v2", cpu:8, memGB:16 }
    },
    xray: {
      small:     { instance:"Standard_F8s_v2", cpu:8, memGB:16 },
      medium:    { instance:"Standard_D8s_v6", cpu:8, memGB:32 },
      large:     { instance:"Standard_D8s_v6", cpu:8, memGB:32 },
      xlarge:    { instance:"Standard_D8s_v6", cpu:8, memGB:32 },
      "2xlarge": { instance:"Standard_D8s_v6", cpu:8, memGB:32 }
    },
    rabbitmq: {
      small:     { instance:"Standard_F4s_v2", cpu:4, memGB:8 },
      medium:    { instance:"Standard_F4s_v2", cpu:4, memGB:8 },
      large:     { instance:"Standard_F4s_v2", cpu:4, memGB:8 },
      xlarge:    { instance:"Standard_F4s_v2", cpu:4, memGB:8 },
      "2xlarge": { instance:"Standard_F4s_v2", cpu:4, memGB:8 }
    },
    jas: {
      small:     { instance:"Standard_D8s_v6", cpu:8, memGB:32 },
      medium:    { instance:"Standard_D8s_v6", cpu:8, memGB:32 },
      large:     { instance:"Standard_D8s_v6", cpu:8, memGB:32 },
      xlarge:    { instance:"Standard_D8s_v6", cpu:8, memGB:32 },
      "2xlarge": { instance:"Standard_D8s_v6", cpu:8, memGB:32 }
    },
    artifactoryDb: {
      small:     { instance:"Standard_E8ds_v6",  cpu:8,  memGB:64,  maxConns:100  },
      medium:    { instance:"Standard_E16ds_v6", cpu:16, memGB:128, maxConns:200  },
      large:     { instance:"Standard_E20ds_v6", cpu:20, memGB:160, maxConns:600  },
      xlarge:    { instance:"Standard_E32ds_v6", cpu:32, memGB:256, maxConns:2000 },
      "2xlarge": { instance:"Standard_E48ds_v6", cpu:48, memGB:384, maxConns:5000 }
    },
    xrayDb: {
      small:     { instance:"Standard_E4ds_v6",  cpu:4,  memGB:32,  maxConns:200  },
      medium:    { instance:"Standard_E8ds_v6",  cpu:8,  memGB:64,  maxConns:500  },
      large:     { instance:"Standard_E16ds_v6", cpu:16, memGB:128, maxConns:600  },
      xlarge:    { instance:"Standard_E32ds_v6", cpu:32, memGB:256, maxConns:1200 },
      "2xlarge": { instance:"Standard_E48ds_v6", cpu:48, memGB:384, maxConns:2000 }
    }
  },
  gcp: {
    artifactory: {
      small:     { instance:"n4-standard-8",  cpu:8,  memGB:32 },
      medium:    { instance:"n4-standard-8",  cpu:8,  memGB:32 },
      large:     { instance:"n4-standard-16", cpu:16, memGB:64 },
      xlarge:    { instance:"n4-standard-16", cpu:16, memGB:64 },
      "2xlarge": { instance:"n4-standard-16", cpu:16, memGB:64 }
    },
    nginx: {
      small:     { instance:"c4d-highcpu-4", cpu:4, memGB:8  },
      medium:    { instance:"c4d-highcpu-4", cpu:4, memGB:8  },
      large:     { instance:"c4d-highcpu-4", cpu:4, memGB:8  },
      xlarge:    { instance:"c4d-highcpu-8", cpu:8, memGB:16 },
      "2xlarge": { instance:"c4d-highcpu-8", cpu:8, memGB:16 }
    },
    xray: {
      small:     { instance:"c4d-highcpu-8", cpu:8, memGB:15 },
      medium:    { instance:"n4-standard-8", cpu:8, memGB:32 },
      large:     { instance:"n4-standard-8", cpu:8, memGB:32 },
      xlarge:    { instance:"n4-standard-8", cpu:8, memGB:32 },
      "2xlarge": { instance:"n4-standard-8", cpu:8, memGB:32 }
    },
    rabbitmq: {
      small:     { instance:"c4d-highcpu-4", cpu:4, memGB:7 },
      medium:    { instance:"c4d-highcpu-4", cpu:4, memGB:7 },
      large:     { instance:"c4d-highcpu-4", cpu:4, memGB:7 },
      xlarge:    { instance:"c4d-highcpu-4", cpu:4, memGB:7 },
      "2xlarge": { instance:"c4d-highcpu-4", cpu:4, memGB:7 }
    },
    jas: {
      small:     { instance:"n4-standard-8", cpu:8, memGB:32 },
      medium:    { instance:"n4-standard-8", cpu:8, memGB:32 },
      large:     { instance:"n4-standard-8", cpu:8, memGB:32 },
      xlarge:    { instance:"n4-standard-8", cpu:8, memGB:32 },
      "2xlarge": { instance:"n4-standard-8", cpu:8, memGB:32 }
    },
    artifactoryDb: {
      small:     { instance:"Cloud SQL 8 vCPU",  cpu:8,  memGB:32,  maxConns:100  },
      medium:    { instance:"Cloud SQL 16 vCPU", cpu:16, memGB:64,  maxConns:200  },
      large:     { instance:"Cloud SQL 32 vCPU", cpu:32, memGB:128, maxConns:600  },
      xlarge:    { instance:"Cloud SQL 48 vCPU", cpu:48, memGB:192, maxConns:2000 },
      "2xlarge": { instance:"Cloud SQL 64 vCPU", cpu:64, memGB:256, maxConns:5000 }
    },
    xrayDb: {
      small:     { instance:"Cloud SQL 4 vCPU",  cpu:4,  memGB:16,  maxConns:200  },
      medium:    { instance:"Cloud SQL 8 vCPU",  cpu:8,  memGB:32,  maxConns:500  },
      large:     { instance:"Cloud SQL 16 vCPU", cpu:16, memGB:64,  maxConns:600  },
      xlarge:    { instance:"Cloud SQL 32 vCPU", cpu:32, memGB:128, maxConns:1200 },
      "2xlarge": { instance:"Cloud SQL 48 vCPU", cpu:48, memGB:192, maxConns:2000 }
    }
  },
  // Onprem mirrors the cloud CPU/RAM as generic VMs (JFrog doesn't publish onprem-specific SKUs).
  onprem: {
    artifactory: {
      small:     { instance:"VM 8 vCPU / 32 GB",  cpu:8,  memGB:32 },
      medium:    { instance:"VM 8 vCPU / 32 GB",  cpu:8,  memGB:32 },
      large:     { instance:"VM 16 vCPU / 64 GB", cpu:16, memGB:64 },
      xlarge:    { instance:"VM 16 vCPU / 64 GB", cpu:16, memGB:64 },
      "2xlarge": { instance:"VM 16 vCPU / 64 GB", cpu:16, memGB:64 }
    },
    nginx: {
      small:     { instance:"VM 4 vCPU / 8 GB",  cpu:4, memGB:8  },
      medium:    { instance:"VM 4 vCPU / 8 GB",  cpu:4, memGB:8  },
      large:     { instance:"VM 4 vCPU / 8 GB",  cpu:4, memGB:8  },
      xlarge:    { instance:"VM 8 vCPU / 16 GB", cpu:8, memGB:16 },
      "2xlarge": { instance:"VM 8 vCPU / 16 GB", cpu:8, memGB:16 }
    },
    xray: {
      small:     { instance:"VM 8 vCPU / 16 GB", cpu:8, memGB:16 },
      medium:    { instance:"VM 8 vCPU / 32 GB", cpu:8, memGB:32 },
      large:     { instance:"VM 8 vCPU / 32 GB", cpu:8, memGB:32 },
      xlarge:    { instance:"VM 8 vCPU / 32 GB", cpu:8, memGB:32 },
      "2xlarge": { instance:"VM 8 vCPU / 32 GB", cpu:8, memGB:32 }
    },
    rabbitmq: {
      small:     { instance:"VM 4 vCPU / 8 GB", cpu:4, memGB:8 },
      medium:    { instance:"VM 4 vCPU / 8 GB", cpu:4, memGB:8 },
      large:     { instance:"VM 4 vCPU / 8 GB", cpu:4, memGB:8 },
      xlarge:    { instance:"VM 4 vCPU / 8 GB", cpu:4, memGB:8 },
      "2xlarge": { instance:"VM 4 vCPU / 8 GB", cpu:4, memGB:8 }
    },
    jas: {
      small:     { instance:"VM 8 vCPU / 32 GB", cpu:8, memGB:32 },
      medium:    { instance:"VM 8 vCPU / 32 GB", cpu:8, memGB:32 },
      large:     { instance:"VM 8 vCPU / 32 GB", cpu:8, memGB:32 },
      xlarge:    { instance:"VM 8 vCPU / 32 GB", cpu:8, memGB:32 },
      "2xlarge": { instance:"VM 8 vCPU / 32 GB", cpu:8, memGB:32 }
    },
    artifactoryDb: {
      small:     { instance:"PostgreSQL VM 8 vCPU / 32 GB",  cpu:8,  memGB:32,  maxConns:100  },
      medium:    { instance:"PostgreSQL VM 16 vCPU / 64 GB", cpu:16, memGB:64,  maxConns:200  },
      large:     { instance:"PostgreSQL VM 32 vCPU / 128 GB",cpu:32, memGB:128, maxConns:600  },
      xlarge:    { instance:"PostgreSQL VM 48 vCPU / 192 GB",cpu:48, memGB:192, maxConns:2000 },
      "2xlarge": { instance:"PostgreSQL VM 64 vCPU / 256 GB",cpu:64, memGB:256, maxConns:5000 }
    },
    xrayDb: {
      small:     { instance:"PostgreSQL VM 4 vCPU / 16 GB",  cpu:4,  memGB:16,  maxConns:200  },
      medium:    { instance:"PostgreSQL VM 8 vCPU / 32 GB",  cpu:8,  memGB:32,  maxConns:500  },
      large:     { instance:"PostgreSQL VM 16 vCPU / 64 GB", cpu:16, memGB:64,  maxConns:600  },
      xlarge:    { instance:"PostgreSQL VM 32 vCPU / 128 GB",cpu:32, memGB:128, maxConns:1200 },
      "2xlarge": { instance:"PostgreSQL VM 48 vCPU / 192 GB",cpu:48, memGB:192, maxConns:2000 }
    }
  }
};

// Per-tier storage (size, IOPS, MB/s) — from the JFrog storage specification page.
const STORAGE = {
  artifactory:   { small:{gb:500, iops:3000, mbps:500 },  medium:{gb:500, iops:3000, mbps:500 },  large:{gb:1000,iops:6000, mbps:1000}, xlarge:{gb:1000,iops:6000, mbps:1000}, "2xlarge":{gb:1000,iops:6000, mbps:1000} },
  xray:          { small:{gb:100, iops:3000, mbps:500 },  medium:{gb:100, iops:3000, mbps:500 },  large:{gb:200, iops:6000, mbps:1000}, xlarge:{gb:200, iops:6000, mbps:1000}, "2xlarge":{gb:200, iops:6000, mbps:1000} },
  rabbitmq:      { small:{gb:100, iops:3000, mbps:500 },  medium:{gb:100, iops:3000, mbps:500 },  large:{gb:100, iops:3000, mbps:500 }, xlarge:{gb:100, iops:3000, mbps:500 }, "2xlarge":{gb:100, iops:3000, mbps:500 } },
  jas:           { small:{gb:300, iops:3000, mbps:500 },  medium:{gb:300, iops:3000, mbps:500 },  large:{gb:300, iops:3000, mbps:500 }, xlarge:{gb:300, iops:3000, mbps:500 }, "2xlarge":{gb:300, iops:3000, mbps:500 } },
  // Artifactory DB disk is "1/3 of filestore" with these IOPS/throughput per tier.
  artifactoryDb: { small:{frac:1/3, iops:4000, mbps:500 },  medium:{frac:1/3, iops:6000, mbps:600 },  large:{frac:1/3, iops:10000, mbps:800}, xlarge:{frac:1/3, iops:12000, mbps:1000}, "2xlarge":{frac:1/3, iops:20000, mbps:1500} },
  xrayDb:        { small:{gb:500, iops:4000, mbps:500 },  medium:{gb:500, iops:6000, mbps:600 },  large:{gb:800, iops:6000, mbps:600}, xlarge:{gb:1000,iops:8000, mbps:1000}, "2xlarge":{gb:2500,iops:12000,mbps:1000} }
};

// Co-location rules — verbatim quotes from JFrog reference architecture pages.
const COLOCATION_RULES = [
  { rule:"Distribution can run on the Artifactory nodes",        relation:"co-locate", components:["Distribution → Artifactory"] },
  { rule:"Each Artifactory replica should run in its own instance (prefer a dedicated node pool)", relation:"dedicated", components:["Artifactory"] },
  { rule:"Each Nginx replica should run in its own instance (prefer a dedicated node pool)",       relation:"dedicated", components:["Nginx"] },
  { rule:"Each Xray replica should run in its own instance (prefer a dedicated node pool)",        relation:"dedicated", components:["Xray"] },
  { rule:"If running JAS, it's recommended to use a dedicated node pool for it to protect Xray and Artifactory pods", relation:"dedicated", components:["JAS"] },
  { rule:"For Xray HA / more than 100K indexed artifacts, RabbitMQ and Xray must run on separate servers (split mode)", relation:"dedicated", components:["RabbitMQ", "Xray"] },
  { rule:"RabbitMQ must be deployed in odd-numbered clusters (1, 3, 5, ...) so quorum queues can elect a majority", relation:"odd-quorum", components:["RabbitMQ"] }
];

const STORAGE_CLASS = {
  aws:    { block:"EBS gp3 (SSD, ≥3000 IOPS)",       premium:"EBS io2 Block Express",  object:"Amazon S3 + lifecycle policies" },
  azure:  { block:"Premium SSD v2",                  premium:"Ultra Disk",             object:"Azure Blob Storage (Hot/Cool tiers)" },
  gcp:    { block:"pd-ssd (≥3000 IOPS)",             premium:"Hyperdisk Extreme",      object:"Google Cloud Storage + Object Lifecycle" },
  onprem: { block:"Enterprise NVMe SSD (≥3K IOPS)",  premium:"All-flash SAN",          object:"S3-compatible (MinIO / Ceph / NetApp StorageGRID)" }
};

// JFrog-recommended binary store (Artifactory filestore) per cloud: the preferred
// option plus alternatives, with the binarystore.xml template each maps to.
const BINARY_STORE = {
  aws: {
    best: { name:"Amazon S3", template:"s3-storage-v3 (cluster-s3-storage-v3 for HA)", note:"JFrog-recommended binary store — virtually unlimited, lifecycle tiering, lowest $/TB at scale. Front it with the local cache-fs." },
    alternatives: [
      { name:"Amazon EFS", template:"cluster-file-system", note:"Shared NFS across HA nodes — simpler, but higher latency and cost than S3 at scale." },
      { name:"Amazon EBS + file system", template:"file-system", note:"Block disk on a single node — only for non-HA / small deployments." }
    ]
  },
  azure: {
    best: { name:"Azure Blob Storage", template:"azure-blob-storage (cluster variant for HA)", note:"JFrog-recommended binary store on Azure — Hot/Cool tiering, scales independently of compute. Front it with the local cache-fs." },
    alternatives: [
      { name:"Azure Files (NFS)", template:"cluster-file-system", note:"Shared NFS across HA nodes — simpler, but higher latency/cost at scale." },
      { name:"Azure Managed Disk + file system", template:"file-system", note:"Block disk on a single node — only for non-HA / small deployments." }
    ]
  },
  gcp: {
    best: { name:"Google Cloud Storage", template:"google-storage-v2 (cluster variant for HA)", note:"JFrog-recommended binary store on GCP — object lifecycle management, scales independently of compute. Front it with the local cache-fs." },
    alternatives: [
      { name:"Filestore (NFS)", template:"cluster-file-system", note:"Shared NFS across HA nodes — simpler, but higher latency/cost at scale." },
      { name:"pd-ssd + file system", template:"file-system", note:"Block disk on a single node — only for non-HA / small deployments." }
    ]
  },
  onprem: {
    best: { name:"S3-compatible object storage (MinIO / Ceph RGW / NetApp StorageGRID)", template:"s3-storage-v3 (cluster variant for HA)", note:"Recommended for scale & HA — any S3-compatible store works. Front it with the local cache-fs." },
    alternatives: [
      { name:"Shared NFS", template:"cluster-file-system", note:"Common on-prem choice for HA when no object store is available." },
      { name:"Local file system", template:"file-system", note:"Single node only — non-HA / small deployments." }
    ]
  }
};

const NETWORK_REC = {
  aws:    "≥ 10 Gbps ENA, Placement Group (cluster) for HA replicas, PrivateLink for managed services.",
  azure:  "Accelerated Networking, ≥ 10 Gbps, Availability Zones for HA.",
  gcp:    "Tier-1 networking (up to 32 Gbps), regional MIG, Cloud NAT for egress.",
  onprem: "≥ 10 GbE bonded NICs, low-latency switching, redundant L3 paths between nodes."
};

const K8S_NOTES = {
  aws:    "EKS — Karpenter or Cluster Autoscaler; storageClass <code>gp3</code> via ebs.csi.aws.com; NLB for ingress.",
  azure:  "AKS — Premium SSD CSI (disk.csi.azure.com); Standard SKU LB; Application Gateway Ingress.",
  gcp:    "GKE (Standard or Autopilot) — pd-ssd CSI; GCLB Ingress; Workload Identity for IAM.",
  onprem: "Vanilla K8s / OpenShift / Rancher — CSI driver, MetalLB / F5 / NSX-ALB load balancer, dedicated worker pools."
};

function fmtGB(n) {
  if (n >= 1024) return (n / 1024).toFixed(1) + " TB";
  return n + " GB";
}

/* =============================================================================
   CSV export. buildSizingCsv(r) serializes a render() result object into a
   multi-section CSV. It introspects r, so it works for both single-cluster and
   Active+Passive results.
   ============================================================================= */

function csvEscape(v) {
  if (v == null) v = "";
  v = String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function buildSizingCsv(r) {
  const L = [];
  const row = (...cells) => L.push(cells.map(csvEscape).join(","));
  const blank = () => L.push("");

  const deployLabel = r.deployment === "k8s" ? "Kubernetes" : "Virtual Machines";
  const isAP = r.topology === "active-passive";
  const isAA = r.topology === "active-active";
  const isMulti = isAP || isAA;
  const siteA = isAA ? "Site A" : "Active";
  const siteB = isAA ? "Site B" : "Passive";

  row("JFrog Platform Deployment (JPD) Sizing — Export");
  row("Generated", new Date().toISOString());
  blank();

  /* Inputs */
  row("[INPUTS]");
  row("Field", "Value");
  row("Target environment", r.cloudLabel);
  row("Deployment model", deployLabel);
  if (r.topology) row("Topology", isAA ? "Active + Active" : isAP ? "Active + Passive (DR)" : "Single active cluster");
  if (isAP) row("Passive site scale", r.passiveScale === "hot" ? "Hot (mirror)" : "Warm (minimal)");
  if (r.deployment === "k8s" && r.k8sPlacement) row("Kubernetes placement", r.k8sPlacement === "antiaffinity" ? "Anti-affinity (shared pool)" : "Dedicated node pool");
  row("Effective tier", String(r.tier || "").toUpperCase());
  row("Peak concurrent connections", `${r.activeClientsInput} → ${r.activeClients} (projected)`);
  row("Peak RPM", `${r.rpmInput} → ${r.rpm} (projected)`);
  row("Binary storage (TB)", `${r.binaryTBInput} → ${r.binaryTB} (projected)`);
  row("Planned growth headroom (%)", r.growthPct);
  row("Indexed artifacts (Xray)", r.xrayEnabled ? `${r.xrayArtifactsInput} → ${r.xrayArtifacts} (projected)` : "No Xray");
  row("Local cache-fs", r.cacheFsGB > 0 ? `${r.cacheFsPct}% of binaries (${fmtGB(r.cacheFsGB)}/node)` : "Disabled");
  row("High Availability", r.ha ? "Yes (multi-replica)" : "No (single replica)");
  row("Ingress", r.externalLB ? `Load Balancer — ${r.lbDisplay}` : "JFrog NGINX (bundled)");
  if (r.externalLB) row("LB routes to", r.provisionNginx ? "NGINX (kept behind LB)" : "Artifactory (no NGINX tier)");
  row("NGINX tier provisioned", r.provisionNginx ? "Yes" : "No");
  row("RabbitMQ", !r.xrayEnabled ? "N/A (no Xray)" : (r.externalRMQ ? "External" : "Bundled"));
  row("Database", r.dbMode === "external" ? "External (managed/standalone RDBMS)" : "Co-located (provisioned with the deployment)");
  row("Database instances", r.dbInstances === "dedicated" ? "Dedicated (one instance per product)" : "Shared (one instance, a logical DB per product)");
  const svcList = [];
  if (r.svc.distribution) svcList.push("Distribution");
  if (r.svc.jas) svcList.push("JAS");
  if (r.svc.workers) svcList.push("Workers");
  if (r.svc.appTrust) svcList.push("AppTrust + UnifiedPolicy");
  if (r.svc.missionControl) svcList.push("Mission Control");
  if (r.svc.curation) svcList.push("Curation + Catalog");
  if (r.svc.runtime) svcList.push("Runtime Security");
  row("Optional services", svcList.join("; ") || "None");
  if (r.svc.curation) row("Valkey", r.externalValkey ? "External" : "Co-located");
  blank();

  /* Totals (computed from components so it works for either page shape) */
  const totalsOf = comps => comps.reduce((t, c) => ({
    nodes: t.nodes + c.replicas, cpu: t.cpu + c.cpu * c.replicas,
    mem: t.mem + c.memGB * c.replicas, disk: t.disk + c.diskGB * c.replicas
  }), { nodes: 0, cpu: 0, mem: 0, disk: 0 });
  const active = totalsOf(r.components);
  const passive = r.passiveComponents ? totalsOf(r.passiveComponents) : null;

  row("[AGGREGATE FOOTPRINT]");
  row("Scope", "Nodes", "vCPU", "RAM (GB)", "Service disk (GB)");
  if (isMulti && passive) {
    row(siteA + " site", active.nodes, active.cpu, active.mem, active.disk);
    row(siteB + " site", passive.nodes, passive.cpu, passive.mem, passive.disk);
    row("Grand total", active.nodes + passive.nodes, active.cpu + passive.cpu, active.mem + passive.mem, active.disk + passive.disk);
  } else {
    row("Total", active.nodes, active.cpu, active.mem, active.disk);
  }
  row("Binary / artifact storage (TB)", isMulti ? r.binaryTB * 2 : r.binaryTB);
  blank();

  /* Binary store recommendation (JFrog-preferred filestore for the cloud) */
  const bs = BINARY_STORE[r.cloud];
  if (bs) {
    row(`[BINARY STORE — JFrog recommended for ${r.cloudLabel}]`);
    row("Option", "Recommended", "binarystore.xml template", "Notes");
    row(bs.best.name, "Yes (best)", bs.best.template, bs.best.note);
    bs.alternatives.forEach(a => row(a.name, "No", a.template, a.note));
    blank();
  }

  /* Per-component sizing */
  row("[PER-COMPONENT SIZING]");
  row("Site", "Component", "Replicas", "vCPU (each)", "RAM GB (each)", "Disk GB (each)", "IOPS", "Instance / VM", "Total vCPU", "Total RAM (GB)", "Total disk (GB)", "Notes");
  const compRows = (comps, site) => comps.forEach(c =>
    row(site, c.name, c.replicas, c.cpu, c.memGB, c.diskGB, c.iops, c.instance, c.cpu * c.replicas, c.memGB * c.replicas, c.diskGB * c.replicas, c.note));
  compRows(r.components, isMulti ? siteA : "—");
  if (isMulti && r.passiveComponents) compRows(r.passiveComponents, siteB);
  blank();

  /* Kubernetes cluster plan */
  if (r.deployment === "k8s") {
    const externalDb = r.dbMode === "external";
    const planFor = comps => {
      const workers = comps.filter(c => !(externalDb && c.name.startsWith("PostgreSQL")));
      const pools = {};
      workers.forEach(c => { (pools[c.instance] = pools[c.instance] || { cpu: c.cpu, memGB: c.memGB, count: 0 }).count += c.replicas; });
      const nodes = Object.values(pools).reduce((s, p) => s + p.count, 0);
      const cpu = Object.values(pools).reduce((s, p) => s + p.cpu * p.count, 0);
      const mem = Object.values(pools).reduce((s, p) => s + p.memGB * p.count, 0);
      return { pools, nodes, cpu, mem, clusterCpu: Math.ceil(cpu * 1.15), clusterMem: Math.ceil(mem * 1.15) };
    };
    row("[KUBERNETES CLUSTER PLAN]");
    row("Site", "Node pool (VM)", "vCPU", "RAM (GB)", "Nodes");
    const planSection = (comps, site) => {
      const p = planFor(comps);
      Object.entries(p.pools).sort((a, b) => b[1].count - a[1].count).forEach(([inst, info]) => row(site, inst, info.cpu, info.memGB, info.count));
      row(site + " — total worker capacity", "", p.cpu, p.mem, p.nodes);
      row(site + " — provision (incl. ~15% sys)", "", p.clusterCpu, p.clusterMem, "");
    };
    planSection(r.components, isMulti ? siteA : "Cluster");
    if (isMulti && r.passiveComponents) planSection(r.passiveComponents, siteB);
    blank();
  }

  /* Databases */
  row("[DATABASES]");
  row("Service", "Database", "User", "Mode");
  const mode = r.dbMode === "external" ? "External" : "Co-located";
  row("Artifactory", "artifactory", "artifactory", mode);
  if (r.xrayEnabled) row(`Xray${r.svc.jas ? " + JAS" : ""}`, "xraydb", "xray", mode);
  if (r.svc.distribution) row("Distribution", "distribution", "distribution", mode);
  if (r.svc.curation) row("Catalog (Curation)", "catalogdb", "catalog", mode);
  if (r.svc.runtime) row("Runtime Security", "runtime", "runtime", mode);
  blank();

  /* External services (recommended, not in footprint) */
  const ext = [];
  if (r.xrayEnabled && r.externalRMQ && r.externalRmqSpec) {
    const s = r.externalRmqSpec;
    ext.push(["RabbitMQ", `${s.replicas} × ${s.instance}`, `${s.cpu} vCPU / ${s.memGB} GB`, fmtGB(s.diskGB)]);
  }
  if (r.svc.curation && r.externalValkey && r.externalValkeySpec) {
    const v = r.externalValkeySpec;
    ext.push(["Valkey", `${v.replicas} × ${v.instance}`, `${v.cpu} vCPU / ${v.memGB} GB`, fmtGB(v.diskGB)]);
  }
  if (ext.length) {
    row("[EXTERNAL SERVICES — recommended, provisioned separately]");
    row("Service", "Cluster", "Per-node spec", "Disk");
    ext.forEach(e => row(...e));
    blank();
  }

  /* Licensing */
  const lic = licenseCount(r);
  row("[LICENSING]");
  row("Field", "Value");
  row("Minimum subscription tier", lic.tier);
  if (lic.jas) row("Add-on", "JFrog Advanced Security (JAS)");
  if (isMulti) {
    row(`Artifactory licenses — ${siteA}`, lic.active);
    row(`Artifactory licenses — ${siteB}`, lic.passive);
  }
  row("Artifactory licenses — total", lic.total);
  if (lic.edge) row("Distribution Edge", "Edge nodes carry separate Edge licenses");
  blank();

  return L.join("\r\n");
}

function downloadText(filename, content, mime) {
  const blob = new Blob([content], { type: (mime || "text/plain") + ";charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadCsv(r) {
  if (!r) return;
  downloadText(`jpd-sizing-${r.cloud}-${r.tier}-${new Date().toISOString().slice(0, 10)}.csv`, buildSizingCsv(r), "text/csv");
}

/* =============================================================================
   Deployment artifacts. From the sizing result, generate a Helm values.yaml for
   the jfrog/jfrog-platform chart (Kubernetes) or an Ansible bundle (VMs). These
   are sizing-derived STARTING templates — validate against your chart/installer
   version. Secrets are placeholders.
   ============================================================================= */

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function findComp(r, name) {
  return r.components.find(c => c.name === name) || null;
}

// Per-cloud external binarystore block (jfrog-platform persistence.* under artifactory).
function binarystoreLines(r, indent) {
  const I = indent, I2 = indent + "  ";
  const out = [];
  if (r.cloud === "azure") {
    out.push(I + "type: azure-blob-storage");
    out.push(I + "azureBlob:");
    out.push(I2 + 'accountName: "<storage-account>"');
    out.push(I2 + 'accountKey: "<account-key>"');
    out.push(I2 + 'containerName: "<container>"');
    out.push(I2 + 'endpoint: "https://<storage-account>.blob.core.windows.net"');
  } else if (r.cloud === "gcp") {
    out.push(I + "type: google-storage-v2");
    out.push(I + "googleStorage:");
    out.push(I2 + "useInstanceCredentials: true   # GKE Workload Identity (HMAC identity/credential is deprecated)");
    out.push(I2 + 'bucketName: "<gcs-bucket>"');
    out.push(I2 + 'path: "artifactory/filestore"');
    out.push(I2 + 'endpoint: "commondatastorage.googleapis.com"');
  } else if (r.cloud === "onprem") {
    out.push(I + "type: s3-storage-v3-direct   # S3-compatible (MinIO / Ceph / StorageGRID)");
    out.push(I + "awsS3V3:");
    out.push(I2 + "testConnection: false");
    out.push(I2 + "useInstanceCredentials: false");
    out.push(I2 + 'identity: "<access-key>"');
    out.push(I2 + 'credential: "<secret-key>"');
    out.push(I2 + 'region: "<region>"');
    out.push(I2 + 'bucketName: "<bucket>"');
    out.push(I2 + 'path: "artifactory/filestore"');
    out.push(I2 + 'endpoint: "http://<minio-host>:9000"');
    out.push(I2 + "useHttp: true");
    out.push(I2 + "enablePathStyleAccess: true");
  } else { // aws
    out.push(I + "type: s3-storage-v3-direct");
    out.push(I + "awsS3V3:");
    out.push(I2 + "testConnection: false");
    out.push(I2 + "useInstanceCredentials: true   # or set identity/credential");
    out.push(I2 + 'region: "<aws-region>"');
    out.push(I2 + 'bucketName: "<s3-bucket>"');
    out.push(I2 + 'path: "artifactory/filestore"');
  }
  return out;
}

function buildHelmValues(r) {
  const arti    = findComp(r, "Artifactory");
  const xray    = findComp(r, "Xray");
  const nginx   = findComp(r, "Nginx (reverse proxy / TLS)");
  const catalog = findComp(r, "Catalog");
  const artiDb  = findComp(r, "PostgreSQL (Artifactory DB)");

  const external       = r.dbMode === "external";
  const catalogOn      = r.svc.curation;
  const distributionOn = r.svc.distribution;
  const valkeyBundled  = catalogOn && !r.externalValkey;
  const rmqBundled     = !r.externalRMQ && (r.xrayEnabled || r.svc.distribution || r.svc.workers);
  const jasOn          = r.svc.jas && r.xrayEnabled;
  const appTrustOn     = r.svc.appTrust;

  const pgDisk   = r.components.filter(c => c.name.startsWith("PostgreSQL")).reduce((s, c) => s + c.diskGB, 0) || 20;
  const maxConns = Math.max(300, r.artiDbMaxConns + (r.xrayEnabled ? r.xrayDbMaxConns : 0));

  // Replica counts and autoscaling bounds (min = sized count, max = sized + 2)
  const artiReplicas = arti ? arti.replicas : 1;
  const xrayReplicas = xray ? xray.replicas : 1;
  const catReplicas  = catalog ? catalog.replicas : 1;
  const distReplicas = r.ha ? 2 : 1;
  const artiMax = artiReplicas + 2;
  const xrayMax = xrayReplicas + 2;
  const catMax  = catReplicas + 2;
  const distMax = distReplicas + 2;

  const L = [];
  const p = s => L.push(s);

  // Burstable QoS: requests ≈ 50 %, limits = full tier (matches reference files)
  const res = (indent, cpu, mem) => {
    const reqCpu = cpu >= 2 ? Math.max(1, Math.floor(cpu / 2)) : cpu;
    const reqMem = Math.max(1, Math.floor(mem / 2));
    p(indent + "resources:");
    p(indent + "  requests:");
    p(indent + `    cpu: "${reqCpu}"`);
    p(indent + `    memory: "${reqMem}Gi"`);
    p(indent + "  limits:");
    p(indent + `    cpu: "${cpu}"`);
    p(indent + `    memory: "${mem}Gi"`);
  };

  // Xray worker sub-components (server / analysis / indexer) — scaled to tier
  const xCpu = xray ? xray.cpu : 8;
  const xMem = xray ? xray.memGB : 16;
  const xSubLimCpu = Math.max(2, Math.floor(xCpu / 3));
  const xSubLimMem = Math.max(4, Math.floor(xMem / 3));
  const xSubReqCpu = Math.max(1, Math.floor(xSubLimCpu / 2));
  const xSubReqMem = Math.max(2, Math.floor(xSubLimMem / 2));
  const xSubRes = (indent) => {
    p(indent + "resources:");
    p(indent + "  requests:");
    p(indent + `    cpu: "${xSubReqCpu}"`);
    p(indent + `    memory: "${xSubReqMem}Gi"`);
    p(indent + "  limits:");
    p(indent + `    cpu: "${xSubLimCpu}"`);
    p(indent + `    memory: "${xSubLimMem}Gi"`);
  };

  // ── Header ────────────────────────────────────────────────────────────────
  p("# JFrog Platform — Helm values for the jfrog/jfrog-platform chart.");
  p("# Generated by the JPD Sizing Calculator, aligned with jf-k8s/ reference values:");
  p("#   helm-values-k8s.yaml (bundled)  &  helm-values-k8s-external.yaml (external).");
  p("# MODE: " + (external
    ? "EXTERNAL — external PostgreSQL + object-store binarystore."
    : "SELF-CONTAINED — bundled PostgreSQL + filesystem binarystore."));
  p("# Resources use burstable QoS (requests ≈ 50 %, limits = full tier).");
  p("# Secrets are placeholders. Validate keys: helm show values jfrog/jfrog-platform");
  p("");

  // ── global ────────────────────────────────────────────────────────────────
  p("global:");
  p("  masterKeySecretName: jfrog-master-key");
  p("  joinKeySecretName: jfrog-join-key");
  if (external) { p("  database:"); p("    initDBCreation: false"); }
  if (catalogOn) {
    p("  valkey:");
    if (valkeyBundled) {
      p('    password: "<valkey-password>"');
    } else {
      p('    host: "<valkey-host>"');
      p("    port: 6379");
      p('    password: "<valkey-password>"');
    }
  }
  p("  security:");
  p("    allowPrivilegeEscalation: false");
  p("    runAsNonRoot: true");
  p("    seccompProfile:");
  p("      type: RuntimeDefault");
  p("    capabilities:");
  p("      drop:");
  p("        - ALL");
  p("");

  // ── preUpgradeHook (top-level) ────────────────────────────────────────────
  p("preUpgradeHook:");
  p("  enabled: true");
  p("  podSecurityContext:");
  p("    enabled: true");
  p("    runAsNonRoot: true");
  p("    runAsUser: 1001");
  p("    runAsGroup: 1001");
  p("    fsGroup: 1001");
  p("    fsGroupChangePolicy: OnRootMismatch");
  p("    seccompProfile:");
  p("      type: RuntimeDefault");
  p("  containerSecurityContext:");
  p("    enabled: true");
  p("    runAsNonRoot: true");
  p("    runAsGroup: 1001");
  p("    allowPrivilegeEscalation: false");
  p("    capabilities:");
  p("      drop:");
  p("        - ALL");
  p("    seccompProfile:");
  p("      type: RuntimeDefault");
  p("");

  // ── shared ────────────────────────────────────────────────────────────────
  p("shared:");
  p("  metrics:");
  p("    enabled: false");
  p("");

  // ── artifactory ───────────────────────────────────────────────────────────
  p("artifactory:");
  p("  enabled: true");
  p("  serviceAccount:");
  p("    create: false");
  p("    name: jfrog-sa");
  p("  rbac:");
  p("    create: false");
  // Autoscaling: only safe when external DB (shared object store; bundled PVC can't split)
  p("  autoscaling:");
  if (external) {
    p("    enabled: true");
    p(`    minReplicas: ${artiReplicas}`);
    p(`    maxReplicas: ${artiMax}`);
    p("    targetCPUUtilizationPercentage: 70");
  } else {
    p("    enabled: false   # bundled PVC binarystore — cannot scale across replicas");
    p(`    minReplicas: ${artiReplicas}`);
    p(`    maxReplicas: ${artiReplicas}`);
  }
  if (external) {
    p("  postgresql:");
    p("    enabled: false");
    p("  database:");
    p("    type: postgresql");
    p("    driver: org.postgresql.Driver");
    p('    url: "jdbc:postgresql://<db-host>:5432/artifactory"');
    p('    user: "artifactory"');
    p('    password: "<db-password>"');
  }
  p("  artifactory:");
  p(`    replicaCount: ${artiReplicas}` + (r.ha ? "   # HA" : ""));
  if (r.ha) {
    p("    podAntiAffinity:");
    p("      type: soft");
    p("      topologyKey: kubernetes.io/hostname");
  }
  p("    livenessProbe:");
  p("      enabled: true");
  p("      config: |");
  p("        httpGet:");
  p("          path: /artifactory/api/v1/system/liveness");
  p("          port: 8091");
  p("        initialDelaySeconds: 300");
  p("        periodSeconds: 20");
  p("        timeoutSeconds: 5");
  p("        failureThreshold: 10");
  p("        successThreshold: 1");
  p("    readinessProbe:");
  p("      enabled: true");
  p("      config: |");
  p("        httpGet:");
  p("          path: /artifactory/api/v1/system/readiness");
  p("          port: 8091");
  p("        initialDelaySeconds: 120");
  p("        periodSeconds: 15");
  p("        timeoutSeconds: 5");
  p("        failureThreshold: 20");
  p("        successThreshold: 1");
  const hasArtiExtra = catalogOn || appTrustOn || jasOn || r.svc.workers || r.svc.runtime || r.externalRMQ;
  p("    extraSystemYaml:" + (hasArtiExtra ? "" : " {}"));
  if (catalogOn) {
    p("      platformFederation:");
    p("        enabled: true");
    p("      jfbus:");
    p("        enabled: true");
    p("      artifactory:");
    p("        curation:");
    p("          enabled: true");
    p("      metadata:");
    p("        catalog:");
    p("          enabled: true");
  }
  if (appTrustOn) { p("      apptrust:"); p("        enabled: true"); }
  if (jasOn)      { p("      jas:");      p("        enabled: true"); }
  if (r.svc.runtime) { p("      runtime:"); p("        enabled: true"); }
  if (r.svc.workers || r.externalRMQ) {
    p("      shared:");
    if (r.svc.workers) {
      p('        extraJavaOpts: "-Dartifactory.workers.addon.support=true"');
      p("        featureToggler:");
      p("          worker: true");
    }
    if (r.externalRMQ) {
      p("        rabbitMq:");
      p("          active: false");
      p('          url: "amqp://<rmq-host>:5672"');
    }
  }
  if (r.svc.workers) { p("      access:"); p("        worker:"); p("          enabled: true"); }
  if (r.svc.workers) { p("    worker:"); p("      enabled: true"); }
  p("    metrics:");
  p("      enabled: false");
  // Main Artifactory container — burstable resources derived from tier
  res("    ", arti ? arti.cpu : 8, arti ? arti.memGB : 32);
  p("    javaOpts:");
  p(`      xms: "${Math.max(1, Math.floor((arti ? arti.memGB : 32) / 4))}g"`);
  p(`      xmx: "${Math.max(2, Math.floor((arti ? arti.memGB : 32) / 2))}g"`);
  p('      other: "-XX:+UseG1GC -XX:MaxRAMPercentage=75.0"');
  p("    persistence:");
  p("      enabled: true");
  p("      size: " + (external ? Math.max(20, r.cacheFsGB || 20) : (arti ? arti.diskGB : 50)) + "Gi");
  p("      accessMode: ReadWriteOnce");
  if (external) {
    binarystoreLines(r, "      ").forEach(p);
  } else {
    p("      # Self-contained: filesystem PVC. Use external mode for the recommended");
    p("      # object store (" + BINARY_STORE[r.cloud].best.name + ").");
  }
  if (!r.provisionNginx) {
    const svcType = r.cloud === "onprem" ? "NodePort" : "LoadBalancer";
    p("    service:");
    p("      type: " + svcType + "   # expose Artifactory router :8082 to the external LB");
  }
  // Security contexts
  p("  podSecurityContext:");
  p("    enabled: true");
  p("    runAsNonRoot: true");
  p("    runAsUser: 1030");
  p("    runAsGroup: 1030");
  p("    fsGroup: 1030");
  p("    fsGroupChangePolicy: OnRootMismatch");
  p("    seccompProfile:");
  p("      type: RuntimeDefault");
  p("  containerSecurityContext:");
  p("    enabled: true");
  p("    runAsNonRoot: true");
  p("    runAsGroup: 1030");
  p("    allowPrivilegeEscalation: false");
  p("    readOnlyRootFilesystem: false");
  p("    capabilities:");
  p("      drop:");
  p("        - ALL");
  p("    seccompProfile:");
  p("      type: RuntimeDefault");
  // Router sidecar (startup probe + resources)
  p("  router:");
  p("    startupProbe:");
  p("      enabled: true");
  p("      failureThreshold: 60");
  p("      periodSeconds: 5");
  p("      timeoutSeconds: 5");
  p("    resources:");
  p("      requests:");
  p('        cpu: "100m"');
  p('        memory: "256Mi"');
  p("      limits:");
  p('        cpu: "1"');
  p('        memory: "1Gi"');
  // Standard small sidecars
  ["frontend", "jfconfig", "jfconnect", "topology", "metadata", "event", "evidence", "onemodel", "observability"].forEach(svc => {
    p(`  ${svc}:`);
    p("    resources:");
    p("      requests:");
    p('        cpu: "100m"');
    p('        memory: "256Mi"');
    p("      limits:");
    p('        cpu: "1"');
    p('        memory: "1Gi"');
  });
  // Access sidecar (Java — larger memory)
  p("  access:");
  p("    resources:");
  p("      requests:");
  p('        cpu: "500m"');
  p('        memory: "512Mi"');
  p("      limits:");
  p('        cpu: "1"');
  p('        memory: "2Gi"');
  // AppTrust
  p("  apptrust:");
  if (appTrustOn) {
    p("    enabled: true");
    p("    resources:");
    p("      requests:");
    p('        cpu: "250m"');
    p('        memory: "512Mi"');
    p("      limits:");
    p('        cpu: "1"');
    p('        memory: "2Gi"');
    p("    podSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsUser: 1117");
    p("      runAsGroup: 1117");
    p("      fsGroup: 1117");
    p("      fsGroupChangePolicy: OnRootMismatch");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
    p("    containerSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsGroup: 1117");
    p("      allowPrivilegeEscalation: false");
    p("      capabilities:");
    p("        drop:");
    p("          - ALL");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
  } else {
    p("    enabled: false");
  }
  // jfbus (Curation Federation backend)
  p("  jfbus:");
  if (catalogOn) {
    p("    enabled: true");
    p(`    replicaCount: ${r.ha ? 2 : 1}`);
    p("    resources:");
    p("      requests:");
    p('        cpu: "250m"');
    p('        memory: "512Mi"');
    p("      limits:");
    p('        cpu: "1"');
    p('        memory: "2Gi"');
    p("    podSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsUser: 1030");
    p("      runAsGroup: 1030");
    p("      fsGroup: 1030");
    p("      fsGroupChangePolicy: OnRootMismatch");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
    p("    containerSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsGroup: 1030");
    p("      allowPrivilegeEscalation: false");
    p("      capabilities:");
    p("        drop:");
    p("          - ALL");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
  } else {
    p("    enabled: false");
  }
  // Nginx
  p("  nginx:");
  if (r.provisionNginx) {
    const ngxCpu = nginx ? nginx.cpu : 4;
    const ngxMem = nginx ? nginx.memGB : 8;
    p("    enabled: true");
    p("    replicaCount: " + (nginx ? nginx.replicas : 1));
    p("    service:");
    p("      type: ClusterIP");
    p("    resources:");
    p("      requests:");
    p(`        cpu: "${Math.max(1, Math.floor(ngxCpu / 2))}"`);
    p(`        memory: "${Math.max(1, Math.floor(ngxMem / 2))}Gi"`);
    p("      limits:");
    p(`        cpu: "${ngxCpu}"`);
    p(`        memory: "${ngxMem}Gi"`);
    p("    podSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsUser: 104");
    p("      runAsGroup: 107");
    p("      fsGroup: 107");
    p("      fsGroupChangePolicy: OnRootMismatch");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
    p("    containerSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsGroup: 107");
    p("      allowPrivilegeEscalation: false");
    p("      capabilities:");
    p("        drop:");
    p("          - ALL");
    p("        add:");
    p("          - NET_BIND_SERVICE");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
  } else {
    p("    enabled: false   # external LB fronts Artifactory directly");
    p("  ingress:");
    p("    enabled: false");
    p('    className: "<ingress-class>"');
    p('    hosts: ["<artifactory-host>"]');
    p('    # tls: [{ secretName: "<tls-secret>", hosts: ["<artifactory-host>"] }]');
  }
  // Platform Federation (Curation Federation controller↔follower sync)
  p("  platformfederation:");
  if (catalogOn) {
    p("    enabled: true");
    p(`    replicaCount: ${r.ha ? 2 : 1}`);
    p("    resources:");
    p("      requests:");
    p('        cpu: "250m"');
    p('        memory: "512Mi"');
    p("      limits:");
    p('        cpu: "1"');
    p('        memory: "2Gi"');
    p("    podSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsUser: 1117");
    p("      runAsGroup: 1117");
    p("      fsGroup: 1117");
    p("      fsGroupChangePolicy: OnRootMismatch");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
    p("    containerSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsGroup: 1117");
    p("      allowPrivilegeEscalation: false");
    p("      capabilities:");
    p("        drop:");
    p("          - ALL");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
  } else {
    p("    enabled: false");
  }
  // rtfs security contexts (no resources key — uses chart defaults)
  p("  rtfs:");
  p("    podSecurityContext:");
  p("      enabled: true");
  p("      runAsNonRoot: true");
  p("      runAsUser: 1030");
  p("      runAsGroup: 1030");
  p("      fsGroup: 1030");
  p("      fsGroupChangePolicy: OnRootMismatch");
  p("      seccompProfile:");
  p("        type: RuntimeDefault");
  p("    containerSecurityContext:");
  p("      enabled: true");
  p("      runAsNonRoot: true");
  p("      runAsGroup: 1030");
  p("      allowPrivilegeEscalation: false");
  p("      capabilities:");
  p("        drop:");
  p("          - ALL");
  p("      seccompProfile:");
  p("        type: RuntimeDefault");
  // Unified Policy (AppTrust lifecycle policies)
  p("  unifiedpolicy:");
  if (appTrustOn) {
    p("    enabled: true");
    p("    resources:");
    p("      requests:");
    p('        cpu: "100m"');
    p('        memory: "256Mi"');
    p("      limits:");
    p('        cpu: "500m"');
    p('        memory: "1Gi"');
    p("    podSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsUser: 1117");
    p("      runAsGroup: 1117");
    p("      fsGroup: 1117");
    p("      fsGroupChangePolicy: OnRootMismatch");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
    p("    containerSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsGroup: 1117");
    p("      allowPrivilegeEscalation: false");
    p("      capabilities:");
    p("        drop:");
    p("          - ALL");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
  } else {
    p("    enabled: false");
  }
  // Mission Control
  p("  mc:");
  p("    enabled: " + (r.svc.missionControl ? "true" : "false"));
  if (r.svc.missionControl) {
    p("    resources:");
    p("      requests:");
    p('        cpu: "100m"');
    p('        memory: "256Mi"');
    p("      limits:");
    p('        cpu: "500m"');
    p('        memory: "1Gi"');
  }
  // Artifactory preUpgradeHook
  p("  preUpgradeHook:");
  p("    podSecurityContext:");
  p("      enabled: true");
  p("      runAsNonRoot: true");
  p("      runAsUser: 1030");
  p("      runAsGroup: 1030");
  p("      fsGroup: 1030");
  p("      fsGroupChangePolicy: OnRootMismatch");
  p("      seccompProfile:");
  p("        type: RuntimeDefault");
  p("    containerSecurityContext:");
  p("      enabled: true");
  p("      runAsNonRoot: true");
  p("      runAsGroup: 1030");
  p("      allowPrivilegeEscalation: false");
  p("      readOnlyRootFilesystem: false");
  p("      capabilities:");
  p("        drop:");
  p("          - ALL");
  p("      seccompProfile:");
  p("        type: RuntimeDefault");
  p("");

  // ── bridge (inter-service router for Workers / AppTrust) ──────────────────
  p("bridge:");
  p("  podSecurityContext:");
  p("    enabled: true");
  p("    runAsNonRoot: true");
  p("    runAsUser: 1169");
  p("    fsGroup: 1169");
  p("    fsGroupChangePolicy: OnRootMismatch");
  p("    seccompProfile:");
  p("      type: RuntimeDefault");
  p("  containerSecurityContext:");
  p("    enabled: true");
  p("    runAsNonRoot: true");
  p("    allowPrivilegeEscalation: false");
  p("    capabilities:");
  p("      drop:");
  p("        - NET_RAW");
  p("    seccompProfile:");
  p("      type: RuntimeDefault");
  p("");

  // ── worker (in-pod worker container security context) ─────────────────────
  p("worker:");
  p("  podSecurityContext:");
  p("    enabled: true");
  p("    runAsNonRoot: true");
  p("    runAsUser: 1131");
  p("    fsGroup: 1131");
  p("    fsGroupChangePolicy: OnRootMismatch");
  p("    seccompProfile:");
  p("      type: RuntimeDefault");
  p("  containerSecurityContext:");
  p("    enabled: true");
  p("    runAsNonRoot: true");
  p("    allowPrivilegeEscalation: false");
  p("    capabilities:");
  p("      drop:");
  p("        - NET_RAW");
  p("    seccompProfile:");
  p("      type: RuntimeDefault");
  p("");

  // ── jfconnect ─────────────────────────────────────────────────────────────
  p("jfconnect:");
  p("  enabled: true");
  p("");

  // ── xray ──────────────────────────────────────────────────────────────────
  if (r.xrayEnabled) {
    p("xray:");
    p("  enabled: true");
    p(`  replicaCount: ${xrayReplicas}`);
    p("  autoscaling:");
    p("    enabled: true");
    p(`    minReplicas: ${xrayReplicas}`);
    p(`    maxReplicas: ${xrayMax}`);
    p("    targetCPUUtilizationPercentage: 70");
    p("  serviceAccount:");
    p("    create: false");
    p("    name: jfrog-sa");
    p("  rbac:");
    p("    create: false");
    if (external) {
      p("  postgresql:");
      p("    enabled: false");
      p("  database:");
      p("    type: postgres");
      p('    url: "postgres://<db-host>:5432/xraydb?sslmode=disable"');
      p('    user: "xray"');
      p('    password: "<db-password>"');
    }
    p("  xray:");
    p("    extraSystemYaml:" + ((catalogOn || jasOn || r.svc.runtime) ? "" : " {}"));
    if (catalogOn) {
      p("      curation:");
      p("        enabled: true");
      p("        federation:");
      p("          enabled: true");
      p("      catalog:");
      p("        enabled: true");
    }
    if (jasOn)         { p("      jas:");     p("        enabled: true"); }
    if (r.svc.runtime) { p("      runtime:"); p("        enabled: true"); }
    if (r.ha) {
      p("    podAntiAffinity:");
      p("      type: soft");
      p("      topologyKey: kubernetes.io/hostname");
    }
    // Xray sub-component resource blocks (scaled to tier)
    p("  server:");
    p(`    replicaCount: ${xrayReplicas}`);
    xSubRes("    ");
    p("  analysis:");
    p(`    replicaCount: ${xrayReplicas}`);
    p(`    threads: ${xCpu <= 8 ? 2 : 4}`);
    xSubRes("    ");
    p("  indexer:");
    p(`    replicaCount: ${xrayReplicas}`);
    p(`    threads: ${xCpu <= 8 ? 4 : 8}`);
    xSubRes("    ");
    p("  persist:");
    p("    resources:");
    p("      requests:");
    p('        cpu: "100m"');
    p('        memory: "1Gi"');
    p("      limits:");
    p('        cpu: "1"');
    p('        memory: "2Gi"');
    p("  policyenforcer:");
    p("    resources:");
    p("      requests:");
    p('        cpu: "100m"');
    p('        memory: "1Gi"');
    p("      limits:");
    p('        cpu: "1"');
    p('        memory: "2Gi"');
    p("  router:");
    p("    resources:");
    p("      requests:");
    p('        cpu: "100m"');
    p('        memory: "256Mi"');
    p("      limits:");
    p('        cpu: "1"');
    p('        memory: "1Gi"');
    p("  observability:");
    p("    resources:");
    p("      requests:");
    p('        cpu: "100m"');
    p('        memory: "256Mi"');
    p("      limits:");
    p('        cpu: "1"');
    p('        memory: "1Gi"');
    p("  common:");
    p("    persistence:");
    p("      enabled: true");
    p("      size: " + (xCpu >= 16 ? 20 : 10) + "Gi");
    p("  podSecurityContext:");
    p("    enabled: true");
    p("    runAsNonRoot: true");
    p("    runAsUser: 1035");
    p("    runAsGroup: 1035");
    p("    fsGroup: 1035");
    p("    fsGroupChangePolicy: OnRootMismatch");
    p("    seccompProfile:");
    p("      type: RuntimeDefault");
    p("  containerSecurityContext:");
    p("    enabled: true");
    p("    runAsNonRoot: true");
    p("    runAsGroup: 1035");
    p("    allowPrivilegeEscalation: false");
    p("    capabilities:");
    p("      drop:");
    p("        - ALL");
    p("    seccompProfile:");
    p("      type: RuntimeDefault");
    p("  valkey:");
    if (valkeyBundled) {
      p("    enabled: true");
      p("    resources:");
      p("      requests:");
      p('        cpu: "100m"');
      p('        memory: "256Mi"');
      p("      limits:");
      p('        cpu: "500m"');
      p('        memory: "1Gi"');
    } else if (catalogOn) {
      p("    enabled: false   # EXTERNAL Valkey — see global.valkey above");
    } else {
      p("    enabled: false");
    }
    p("");
  } else {
    p("xray:");
    p("  enabled: false");
    p("");
  }

  // ── catalog ───────────────────────────────────────────────────────────────
  if (catalogOn) {
    p("catalog:");
    p("  enabled: true");
    p(`  replicaCount: ${catReplicas}`);
    p("  autoscaling:");
    p("    enabled: true");
    p(`    minReplicas: ${catReplicas}`);
    p(`    maxReplicas: ${catMax}`);
    p("    targetCPU: 70");
    p("  serviceAccount:");
    p("    create: false");
    p("    name: jfrog-sa");
    p("  rbac:");
    p("    create: false");
    p("  cache:");
    p("    enabled: true");
    if (external) {
      p("  database:");
      p('    url: "jdbc:postgresql://<db-host>:5432/catalog?sslmode=disable"');
      p('    user: "catalog"');
      p('    password: "<db-password>"');
    }
    res("  ", catalog ? catalog.cpu : 8, catalog ? Math.max(4, Math.floor((catalog.memGB || 16) * 0.75)) : 8);
    p("  persistence:");
    p("    enabled: true");
    p("    size: " + (catalog && catalog.diskGB > 10 ? Math.min(catalog.diskGB, 100) : 10) + "Gi");
    p("  podSecurityContext:");
    p("    enabled: true");
    p("    runAsNonRoot: true");
    p("    runAsUser: 1030");
    p("    runAsGroup: 1030");
    p("    fsGroup: 1030");
    p("    fsGroupChangePolicy: OnRootMismatch");
    p("    seccompProfile:");
    p("      type: RuntimeDefault");
    p("  containerSecurityContext:");
    p("    enabled: true");
    p("    runAsNonRoot: true");
    p("    runAsGroup: 1030");
    p("    allowPrivilegeEscalation: false");
    p("    capabilities:");
    p("      drop:");
    p("        - ALL");
    p("    seccompProfile:");
    p("      type: RuntimeDefault");
    p("");
  } else {
    p("catalog:");
    p("  enabled: false");
    p("");
  }

  // ── distribution ──────────────────────────────────────────────────────────
  if (distributionOn) {
    p("distribution:");
    p("  enabled: true");
    p(`  replicaCount: ${distReplicas}`);
    p("  autoscaling:");
    p("    enabled: true");
    p(`    minReplicas: ${distReplicas}`);
    p(`    maxReplicas: ${distMax}`);
    p("    targetCPUUtilizationPercentage: 70");
    p("  serviceAccount:");
    p("    create: false");
    p("    name: jfrog-sa");
    p("  rbac:");
    p("    create: false");
    if (external) {
      p("  database:");
      p('    url: "jdbc:postgresql://<db-host>:5432/distribution?sslmode=disable"');
      p('    user: "distribution"');
      p('    password: "<db-password>"');
    }
    p("  distribution:");   // nested sub-chart key (resources/persistence live here)
    p("    resources:");
    p("      requests:");
    p('        cpu: "250m"');
    p('        memory: "512Mi"');
    p("      limits:");
    p('        cpu: "1"');
    p('        memory: "2Gi"');
    p("    persistence:");
    p("      enabled: true");
    p("      size: 10Gi");
    p("  podSecurityContext:");
    p("    enabled: true");
    p("    runAsNonRoot: true");
    p("    runAsUser: 1020");
    p("    runAsGroup: 1020");
    p("    fsGroup: 1020");
    p("    fsGroupChangePolicy: OnRootMismatch");
    p("    seccompProfile:");
    p("      type: RuntimeDefault");
    p("  containerSecurityContext:");
    p("    enabled: true");
    p("    runAsNonRoot: true");
    p("    runAsGroup: 1020");
    p("    allowPrivilegeEscalation: false");
    p("    capabilities:");
    p("      drop:");
    p("        - NET_RAW");
    p("    seccompProfile:");
    p("      type: RuntimeDefault");
    p("");
  } else {
    p("distribution:");
    p("  enabled: false");
    p("");
  }

  // ── rabbitmq ──────────────────────────────────────────────────────────────
  p("rabbitmq:");
  p("  enabled: " + (rmqBundled ? "true" : "false" + (r.externalRMQ ? "   # external RabbitMQ — wired via extraSystemYaml" : "")));
  if (rmqBundled) {
    p(`  replicaCount: ${r.ha ? 3 : 1}`);
    p("  rabbitmqUpgradeReady: true");
    p("  auth:");
    p("    existingPasswordSecret: jfrog-rabbitmq-secret");
    p("    existingErlangSecret: jfrog-rabbitmq-erlang-secret");
    p("  persistence:");
    p("    size: 20Gi");
    p("  common:");
    p("    persistence:");
    p("      size: 20Gi");
    p("  resources:");
    p("    requests:");
    p('      cpu: "250m"');
    p('      memory: "512Mi"');
    p("    limits:");
    p('      cpu: "1"');
    p('      memory: "2Gi"');
    p("  podSecurityContext:");
    p("    enabled: true");
    p("    runAsNonRoot: true");
    p("    runAsUser: 1001");
    p("    runAsGroup: 1001");
    p("    fsGroup: 1001");
    p("    fsGroupChangePolicy: OnRootMismatch");
    p("    seccompProfile:");
    p("      type: RuntimeDefault");
    p("  containerSecurityContext:");
    p("    enabled: true");
    p("    runAsNonRoot: true");
    p("    runAsGroup: 1001");
    p("    allowPrivilegeEscalation: false");
    p("    capabilities:");
    p("      drop:");
    p("        - ALL");
    p("    seccompProfile:");
    p("      type: RuntimeDefault");
    p("  extraContainerSecurityContext:");
    p("    capabilities:");
    p("      drop:");
    p("        - ALL");
    p("  migration:");
    p("    enabled: false");
    p("  preUpgradeHook:");
    p("    podSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsUser: 1001");
    p("      runAsGroup: 1001");
    p("      fsGroup: 1001");
    p("      fsGroupChangePolicy: OnRootMismatch");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
    p("    containerSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsGroup: 1001");
    p("      allowPrivilegeEscalation: false");
    p("      capabilities:");
    p("        drop:");
    p("          - ALL");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
  }
  p("");

  // ── postgresql ────────────────────────────────────────────────────────────
  p("databaseUpgradeReady: true");
  if (r.dbInstances === "dedicated") {
    p(external
      ? "# Dedicated DB instances: point each product's database url (above) at its own host."
      : "# Dedicated DB instances requested: the bundled chart provides ONE PostgreSQL. For separate");
    if (!external) p("# instances per product, switch to external DB and give each product its own host.");
  }
  p("postgresql:");
  if (external) {
    p("  enabled: false   # external database in use");
  } else {
    const pgReqCpu = artiDb ? Math.max(1, Math.floor(Math.min(artiDb.cpu, 8) / 4)) : 1;
    const pgReqMem = artiDb ? Math.max(1, Math.floor(Math.min(artiDb.memGB, 16) / 4)) : 1;
    const pgLimCpu = artiDb ? Math.min(artiDb.cpu, 8) : 2;
    const pgLimMem = artiDb ? Math.min(artiDb.memGB, 16) : 4;
    p("  enabled: true");
    p("  image:");
    p("    tag: 17.6.0-debian-12-r2");
    p("  primary:");
    p("    extendedConfiguration: |");
    p(`      max_connections = ${maxConns}`);
    p("    persistence:");
    p(`      size: ${pgDisk}Gi`);
    p("    resources:");
    p("      requests:");
    p(`        cpu: "${pgReqCpu}"`);
    p(`        memory: "${pgReqMem}Gi"`);
    p("      limits:");
    p(`        cpu: "${pgLimCpu}"`);
    p(`        memory: "${pgLimMem}Gi"`);
    p("    podSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsUser: 1001");
    p("      runAsGroup: 1001");
    p("      fsGroup: 1001");
    p("      fsGroupChangePolicy: OnRootMismatch");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
    p("    containerSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsGroup: 1001");
    p("      allowPrivilegeEscalation: false");
    p("      capabilities:");
    p("        drop:");
    p("          - ALL");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
    p("  readReplicas:");
    p("    podSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsUser: 1001");
    p("      runAsGroup: 1001");
    p("      fsGroup: 1001");
    p("      fsGroupChangePolicy: OnRootMismatch");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
    p("    containerSecurityContext:");
    p("      enabled: true");
    p("      runAsNonRoot: true");
    p("      runAsGroup: 1001");
    p("      allowPrivilegeEscalation: false");
    p("      capabilities:");
    p("        drop:");
    p("          - ALL");
    p("      seccompProfile:");
    p("        type: RuntimeDefault");
  }

  return L.join("\n");
}

function buildAnsibleInventory(r) {
  const arti    = findComp(r, "Artifactory");
  const nginx   = findComp(r, "Nginx (reverse proxy / TLS)");
  const xray    = findComp(r, "Xray");
  const rmq     = findComp(r, "RabbitMQ (Xray)");
  const catalog = findComp(r, "Catalog");
  const L = [];
  const group = (name, comp, n) => {
    if (!n) return;
    L.push("[" + name + "]" + (comp ? "   # " + comp.cpu + " vCPU / " + comp.memGB + " GB each" : ""));
    for (let i = 1; i <= n; i++) L.push(name + "-" + i + " ansible_host=<ip-" + i + ">");
    L.push("");
  };
  group("artifactory", arti, arti ? arti.replicas : 1);
  if (r.provisionNginx && nginx) group("nginx", nginx, nginx.replicas);
  if (r.xrayEnabled && xray)     group("xray", xray, xray.replicas);
  if (r.xrayEnabled && !r.externalRMQ && rmq) group("rabbitmq", rmq, rmq.replicas);
  if (r.svc.curation && catalog) {
    group("catalog", catalog, catalog.replicas);
    // Valkey co-located on Catalog nodes — no separate group needed unless external
    if (r.externalValkey) {
      const catReplicas = r.ha ? 3 : 1;
      L.push("[valkey]   # " + catReplicas + " node(s) — external Valkey (separate from Catalog)");
      for (let i = 1; i <= catReplicas; i++) L.push("valkey-" + i + " ansible_host=<ip-" + i + ">");
      L.push("");
    }
  }
  if (r.svc.runtime) group("runtime", findComp(r, "Runtime (server)"), r.ha ? 2 : 1);
  if (r.dbMode === "colocated") group("postgresql", null, r.ha ? 2 : 1);
  L.push("[jpd:children]");
  L.push("artifactory");
  if (r.provisionNginx) L.push("nginx");
  if (r.xrayEnabled) L.push("xray");
  if (r.svc.curation) L.push("catalog");
  if (r.svc.runtime) L.push("runtime");
  return L.join("\n");
}

function buildSystemYamlTemplate(r) {
  const L = [];
  L.push("# system.yaml.j2 — rendered onto each node by the playbook.");
  L.push("configVersion: 1");
  L.push("shared:");
  L.push('  jfrogUrl: "https://<jpd-url>"');
  L.push("  security:");
  L.push('    masterKey: "{{ jpd_master_key }}"');
  L.push('    joinKey: "{{ jpd_join_key }}"');
  if (r.ha) {
    L.push("  node:");
    L.push("    id: \"{{ inventory_hostname }}\"");
    L.push("    primary: \"{{ 'true' if inventory_hostname == groups['artifactory'][0] else 'false' }}\"");
    L.push("    haEnabled: true");
  }
  L.push("  database:");
  L.push("    type: postgresql");
  L.push("    driver: org.postgresql.Driver");
  L.push('    url: "jdbc:postgresql://{{ db_host }}:5432/artifactory"');
  L.push('    username: artifactory');
  L.push('    password: "{{ artifactory_db_password }}"');
  if (r.xrayEnabled && r.externalRMQ) {
    L.push("  rabbitMq:");
    L.push("    active: false   # external RabbitMQ");
    L.push('    url: "amqp://{{ rmq_host }}:5672"');
  }
  return L.join("\n");
}

function buildAnsiblePlaybook(r) {
  const L = [];
  L.push("# site.yml — install JFrog Artifactory" + (r.xrayEnabled ? " + Xray" : "") + " on VMs.");
  L.push("# Follows the JFrog manual install (Linux archive + system.yaml). Adapt versions/paths.");
  L.push("- name: Install JFrog Artifactory");
  L.push("  hosts: artifactory");
  L.push("  become: true");
  L.push("  vars:");
  L.push('    artifactory_version: "7.x.x"          # pin to your target release');
  L.push('    install_root: /opt/jfrog/artifactory');
  L.push('    db_host: "<db-host>"');
  L.push('    # secrets: pass via --extra-vars or Ansible Vault');
  L.push("  tasks:");
  L.push("    - name: Create install directory");
  L.push("      ansible.builtin.file: { path: '{{ install_root }}', state: directory }");
  L.push("    - name: Download & unpack Artifactory Pro (bundled JRE)");
  L.push("      ansible.builtin.unarchive:");
  L.push('        src: "https://releases.jfrog.io/artifactory/artifactory-pro/org/artifactory/pro/jfrog-artifactory-pro/{{ artifactory_version }}/jfrog-artifactory-pro-{{ artifactory_version }}-linux.tar.gz"');
  L.push("        dest: '{{ install_root }}'");
  L.push("        remote_src: true");
  L.push("        extra_opts: [--strip-components=1]");
  L.push("    - name: Render system.yaml (external DB" + (r.ha ? ", HA node config" : "") + ")");
  L.push("      ansible.builtin.template:");
  L.push("        src: templates/system.yaml.j2");
  L.push("        dest: '{{ install_root }}/var/etc/system.yaml'");
  L.push("    - name: Install & start the service");
  L.push("      ansible.builtin.shell: |");
  L.push("        {{ install_root }}/app/bin/installService.sh");
  L.push("        systemctl enable --now artifactory");
  if (r.provisionNginx) {
    L.push("");
    L.push("- name: Install Nginx reverse proxy");
    L.push("  hosts: nginx");
    L.push("  become: true");
    L.push("  tasks:");
    L.push("    - name: Install nginx + JFrog reverse-proxy config");
    L.push("      ansible.builtin.debug: { msg: 'Install nginx and drop in the Artifactory reverse-proxy conf (Artifactory UI generates it).' }");
  }
  if (r.xrayEnabled) {
    L.push("");
    L.push("- name: Install JFrog Xray");
    L.push("  hosts: xray");
    L.push("  become: true");
    L.push("  vars: { xray_version: \"3.x.x\", db_host: \"<db-host>\" }");
    L.push("  tasks:");
    L.push("    - name: Download & unpack Xray, render its system.yaml, install service");
    L.push("      ansible.builtin.debug: { msg: 'Mirror the Artifactory tasks using the Xray archive; point system.yaml at xraydb" + (r.externalRMQ ? " and the external RabbitMQ" : "") + ".' }");
  }
  if (r.svc.curation) {
    L.push("");
    L.push("# Curation is a runtime feature of Artifactory + Xray — no dedicated nodes.");
    L.push("# Enable it by adding the flags below to system.yaml on Artifactory + Xray nodes:");
    L.push("#   artifactory.curation.enabled: true  (under the 'artifactory:' key)");
    L.push("#   curation.enabled: true               (under the 'xray:' key, if running Xray)");
    L.push("# The Catalog service (below) and Valkey are the only new infrastructure.");
    L.push("");
    L.push("- name: Install JFrog Catalog");
    L.push("  hosts: catalog");
    L.push("  become: true");
    L.push("  vars:");
    L.push('    catalog_version: "3.x.x"          # pin to your target release');
    L.push('    install_root: /opt/jfrog/catalog');
    L.push('    db_host: "<db-host>"');
    L.push('    valkey_host: "' + (r.externalValkey ? "<valkey-host>" : "{{ groups['catalog'][0] }}") + '"');
    L.push('    # secrets: pass via --extra-vars or Ansible Vault');
    L.push("  tasks:");
    L.push("    - name: Download & unpack Catalog");
    L.push("      ansible.builtin.unarchive:");
    L.push('        src: "https://releases.jfrog.io/artifactory/jfrog-catalog/{{ catalog_version }}/jfrog-catalog-{{ catalog_version }}-linux.tar.gz"');
    L.push("        dest: '{{ install_root }}'");
    L.push("        remote_src: true");
    L.push("        extra_opts: [--strip-components=1]");
    L.push("    - name: Render system.yaml (DB + Valkey + platform URL)");
    L.push("      ansible.builtin.template:");
    L.push("        src: templates/catalog-system.yaml.j2");
    L.push("        dest: '{{ install_root }}/var/etc/system.yaml'");
    L.push("      vars:");
    L.push("        catalog_db_url: 'jdbc:postgresql://{{ db_host }}:5432/catalogdb'");
    L.push("        valkey_url: 'redis://{{ valkey_host }}:6379'");
    L.push("    - name: Install & start the Catalog service");
    L.push("      ansible.builtin.shell: |");
    L.push("        {{ install_root }}/app/bin/installService.sh");
    L.push("        systemctl enable --now catalog");
  }
  if (r.svc.runtime) {
    L.push("");
    L.push("- name: Install JFrog Runtime (server)");
    L.push("  hosts: runtime");
    L.push("  become: true");
    L.push("  vars: { runtime_version: \"1.x.x\", db_host: \"<db-host>\" }");
    L.push("  tasks:");
    L.push("    - name: Install the Runtime server, point it at the 'runtime' database and the platform jfrogUrl (:8082)");
    L.push("      ansible.builtin.debug: { msg: 'Install jfrog-runtime; system.yaml database url = postgres://<db-host>:5432/runtime.' }");
    L.push("");
    L.push("- name: Install Runtime sensors (per-node agent — DaemonSet equivalent)");
    L.push("  hosts: all");
    L.push("  become: true");
    L.push("  tasks:");
    L.push("    - name: Deploy the runtime sensor on every node, registered to the Runtime server");
    L.push("      ansible.builtin.debug: { msg: 'Install jfrog-runtime-sensors on each VM, pointing at the Runtime server :8082.' }");
  }
  return L.join("\n");
}

function buildArtifactPanel(r) {
  if (r.deployment === "k8s") {
    const values = buildHelmValues(r);
    let cmds = "helm repo add jfrog https://charts.jfrog.io\n" +
               "helm repo update\n" +
               "kubectl create namespace jfrog\n" +
               "helm upgrade --install jfrog jfrog/jfrog-platform -n jfrog -f values.yaml";
    // Workers and Runtime are NOT part of the jfrog-platform umbrella — separate releases.
    const extraReleases = [];
    if (r.svc.workers) extraReleases.push("helm upgrade --install jfrog-worker jfrog/worker -n jfrog -f worker-values.yaml");
    if (r.svc.runtime) {
      extraReleases.push("helm upgrade --install jfrog-runtime jfrog/runtime -n jfrog -f runtime-values.yaml");
      extraReleases.push("helm upgrade --install jfrog-runtime-sensors jfrog/runtime-sensors -n jfrog -f runtime-sensors-values.yaml");
    }
    if (extraReleases.length) cmds += "\n\n# Separate releases (not in the jfrog-platform umbrella):\n" + extraReleases.join("\n");
    return `
    <details class="panel">
      <summary style="font-size:14px;">Deployment artifacts — Kubernetes (Helm)</summary>
      <p style="margin:10px 0 4px; font-size:13px; color:var(--muted);">Deploy with the unified <code>jfrog/jfrog-platform</code> chart (structure mirrors the reference values in <code>jf-k8s/</code>). Mode: <strong>${r.dbMode === "external" ? "external (external PostgreSQL + object-store binarystore)" : "self-contained (bundled PostgreSQL + filesystem PVC)"}</strong>, set by the Database input.${r.svc.runtime ? " Runtime Security installs as its own <code>jfrog/runtime</code> release (+ a <code>jfrog/runtime-sensors</code> DaemonSet) — it needs a <code>runtime</code> database." : ""}</p>
      <blockquote style="white-space:pre; font-family:monospace; font-style:normal;">${escapeHtml(cmds)}</blockquote>
      <p style="margin:12px 0 4px; font-size:13px; color:var(--muted);">Generated <code>values.yaml</code> (sizing-derived — validate against your chart version):</p>
      <blockquote style="white-space:pre; font-family:monospace; font-style:normal; max-height:340px; overflow:auto;">${escapeHtml(values)}</blockquote>
      <button class="export" id="artifactBtn">⤓ Download values.yaml</button>
      <div class="hint" style="margin-top:8px;">Secrets are placeholders — supply <code>masterKey</code>/<code>joinKey</code>/DB &amp; Valkey passwords via Kubernetes Secrets. Resources use burstable QoS (requests ≈ 50%, limits = full tier). Autoscaling bounds are derived from the sized replica count. Reference: <a href="https://docs.jfrog.com/installation/docs/helm-charts-for-advanced-users" target="_blank">Install JFrog Platform with Helm</a>.</div>
    </details>`;
  }
  const inv = buildAnsibleInventory(r);
  const play = buildAnsiblePlaybook(r);
  const sys = buildSystemYamlTemplate(r);
  return `
    <details class="panel">
      <summary style="font-size:14px;">Deployment artifacts — Virtual Machines (Ansible)</summary>
      <p style="margin:10px 0 4px; font-size:13px; color:var(--muted);">JFrog has no single official Ansible collection; this follows the manual install (Linux archive + <code>system.yaml</code>). Adapt versions and secrets, then run <code>ansible-playbook -i inventory.ini site.yml</code>.</p>
      <p style="margin:12px 0 4px; font-size:13px; color:var(--muted);"><strong>inventory.ini</strong> (hosts grouped by role, counts from the sizing):</p>
      <blockquote style="white-space:pre; font-family:monospace; font-style:normal; max-height:200px; overflow:auto;">${escapeHtml(inv)}</blockquote>
      <p style="margin:12px 0 4px; font-size:13px; color:var(--muted);"><strong>site.yml</strong>:</p>
      <blockquote style="white-space:pre; font-family:monospace; font-style:normal; max-height:300px; overflow:auto;">${escapeHtml(play)}</blockquote>
      <p style="margin:12px 0 4px; font-size:13px; color:var(--muted);"><strong>templates/system.yaml.j2</strong>:</p>
      <blockquote style="white-space:pre; font-family:monospace; font-style:normal; max-height:240px; overflow:auto;">${escapeHtml(sys)}</blockquote>
      <button class="export" id="artifactBtn">⤓ Download Ansible bundle</button>
      <div class="hint" style="margin-top:8px;">Reference: <a href="https://jfrog.com/help/r/jfrog-installation-setup-documentation/installing-artifactory" target="_blank">Installing Artifactory</a> &middot; <a href="https://jfrog.com/help/r/jfrog-installation-setup-documentation/system-yaml-configuration-file" target="_blank">system.yaml</a>.</div>
    </details>`;
}

function downloadArtifact(r) {
  if (!r) return;
  if (r.deployment === "k8s") {
    downloadText("jfrog-platform-values.yaml", buildHelmValues(r), "application/x-yaml");
  } else {
    const bundle =
      "# ===== inventory.ini =====\n" + buildAnsibleInventory(r) +
      "\n\n# ===== site.yml =====\n" + buildAnsiblePlaybook(r) +
      "\n\n# ===== templates/system.yaml.j2 =====\n" + buildSystemYamlTemplate(r);
    downloadText("jpd-ansible-bundle.txt", bundle, "text/plain");
  }
}

/* =============================================================================
   Calculator application — calculate() + render() + UI wiring.
   Single source for the calculator page (index.html). Handles both single and
   Active+Passive topologies, VM and Kubernetes. Runs the initial calculate() at
   load (this script is included at end of <body>, so the DOM is ready).
   ============================================================================= */

/* ---------- Calculator ---------- */

function toggleConditionalFields() {
  const deployment = document.querySelector('input[name="deployment"]:checked').value;
  const topology   = document.querySelector('input[name="topology"]:checked').value;
  document.getElementById("k8sPlacementField").style.display = deployment === "k8s" ? "" : "none";
  document.getElementById("passiveScaleField").style.display = topology === "active-passive" ? "" : "none";
  const usingLB = document.querySelector('input[name="ingress"]:checked').value === "lb";
  document.getElementById("lbTargetField").style.display = usingLB ? "" : "none";
  document.getElementById("valkeyField").style.display = document.getElementById("svcCuration").checked ? "" : "none";
  // RabbitMQ is always Helm-deployed on K8s — hide the external toggle for K8s deployments.
  const rmqField = document.getElementById("rmqField");
  if (rmqField) {
    rmqField.style.display = deployment === "k8s" ? "none" : "";
    if (deployment === "k8s") {
      const bundledRadio = document.querySelector('input[name="rmq"][value="bundled"]');
      if (bundledRadio) bundledRadio.checked = true;
    }
  }
}

function calculate() {
  toggleConditionalFields();
  const cloud         = document.querySelector('input[name="cloud"]:checked').value;
  const deployment    = document.querySelector('input[name="deployment"]:checked').value;
  const ha            = document.querySelector('input[name="ha"]:checked').value === "yes";
  const dbMode        = document.querySelector('input[name="db"]:checked').value;
  const dbInstances   = document.querySelector('input[name="dbInstances"]:checked').value; // shared | dedicated
  const k8sPlacement  = document.querySelector('input[name="k8sPlacement"]:checked')?.value || "dedicated";
  const topology      = document.querySelector('input[name="topology"]:checked').value;
  const passiveScale  = document.querySelector('input[name="passiveScale"]:checked')?.value || "hot";

  const growthPct     = Math.max(0, parseFloat(document.getElementById("growthPct").value) || 0);
  const growthFactor  = 1 + growthPct / 100;

  // Raw inputs describe today's load. Sizing plans for the future, so the demand
  // drivers are scaled by the growth factor and the deployment is sized for the
  // projected state. Base values are kept for "today → projected" display.
  const activeClientsInput = parseInt(document.getElementById("activeClients").value, 10) || 0;
  const rpmInput           = parseInt(document.getElementById("rpm").value, 10) || 0;
  const binaryTBInput      = parseFloat(document.getElementById("binaryStorageTB").value) || 0;
  const xrayArtifactsInput = parseInt(document.getElementById("xrayArtifacts").value, 10) || 0;

  const activeClients = Math.round(activeClientsInput * growthFactor);
  const rpm           = Math.round(rpmInput * growthFactor);
  const binaryTB      = Math.round(binaryTBInput * growthFactor * 10) / 10;
  const xrayArtifacts = Math.round(xrayArtifactsInput * growthFactor);

  const svc = {
    distribution:   document.getElementById("svcDistribution").checked,
    jas:            document.getElementById("svcJAS").checked,
    workers:        document.getElementById("svcWorkers").checked,
    appTrust:       document.getElementById("svcAppTrust").checked,
    missionControl: document.getElementById("svcMissionControl").checked,
    curation:       document.getElementById("svcCuration").checked,
    runtime:        document.getElementById("svcRuntime").checked
  };

  // Valkey (Curation/Catalog cache). Co-located folds onto the Catalog nodes;
  // external removes it from the footprint and a recommended spec/config is shown.
  const valkeyMode    = document.querySelector('input[name="valkey"]:checked').value; // colocated | external
  const externalValkey = valkeyMode === "external";

  // Local cache-fs: an SSD cache per Artifactory replica that fronts the object
  // store. Sized as a percentage of the (projected) binary footprint.
  const cacheFs    = document.querySelector('input[name="cachefs"]:checked').value === "yes";
  const cacheFsPct = Math.max(0, parseFloat(document.getElementById("cacheFsPct").value) || 0);
  const cacheFsGB  = cacheFs ? Math.round(binaryTB * 1024 * cacheFsPct / 100) : 0;

  // Ingress: NGINX (bundled reverse proxy) or a Load Balancer. When an LB is used,
  // it either routes straight to Artifactory (no NGINX tier) or to NGINX behind it.
  const ingress    = document.querySelector('input[name="ingress"]:checked').value; // nginx | lb
  const lbTarget   = document.querySelector('input[name="lbTarget"]:checked').value; // artifactory | nginx
  const externalLB = ingress === "lb";
  const provisionNginx = !externalLB || lbTarget === "nginx";

  // RabbitMQ (Xray messaging). External removes the RMQ nodes from this footprint;
  // the recommended external spec + plugin/config requirements are surfaced separately.
  const externalRMQ  = document.querySelector('input[name="rmq"]:checked').value === "external";

  // Effective tier = max of connections-implied and RPM-implied tier.
  const connsTier  = tierFromConns(activeClients);
  const rpmTierKey = tierFromRpm(rpm);
  const tier       = maxTier(connsTier, rpmTierKey);
  const tierMeta   = TIER_RPM[tier];
  const arch       = REF_ARCH[cloud];
  const cloudLabel = { aws:"AWS", azure:"Azure", gcp:"GCP", onprem:"Private Datacenter" }[cloud];

  const lbDisplay = !externalLB
    ? "JFrog NGINX (bundled reverse proxy)"
    : { aws:"AWS ALB/NLB", azure:"Azure LB / Application Gateway", gcp:"Google Cloud Load Balancing", onprem:"External / hardware LB" }[cloud];

  const xrayEnabled = xrayArtifacts > 0;

  // Per-tier DB connection caps (for the external-database max_connections guidance).
  const artiDbMaxConns = arch.artifactoryDb[tier].maxConns;
  const xrayDbMaxConns = arch.xrayDb[tier].maxConns;

  // Helper: build a row from REF_ARCH + REPLICAS + STORAGE for a given component.
  function buildRow(key, displayName, opts = {}) {
    const archEntry = arch[key][tier];
    let replicas    = ha ? REPLICAS[key][tier] : 1;
    if (opts.forceReplicas != null) replicas = opts.forceReplicas;
    const storage   = opts.storage || STORAGE[key][tier];
    return {
      name: displayName,
      replicas,
      instance: archEntry.instance,
      cpu: archEntry.cpu,
      memGB: archEntry.memGB,
      diskGB: storage.gb,
      iops: storage.iops,
      mbps: storage.mbps,
      note: opts.note || ""
    };
  }

  const components = [];

  /* --- Artifactory --- */
  // Distribution co-locates on Artifactory nodes: add 200 GB to its disk, note it, no new VMs.
  let artiDisk = STORAGE.artifactory[tier].gb;
  let artiNote = "Each replica on its own VM (JFrog dedicated-instance rule).";
  if (svc.distribution) {
    artiDisk += 200;
    artiNote += " Distribution co-located (+200 GB).";
  }
  if (cacheFsGB > 0) {
    artiDisk += cacheFsGB;
    artiNote += ` Cache-fs +${cacheFsGB} GB local SSD (${cacheFsPct}% of binaries) fronting the object store.`;
  }
  components.push(buildRow("artifactory", "Artifactory", {
    storage: { gb: artiDisk, iops: STORAGE.artifactory[tier].iops, mbps: STORAGE.artifactory[tier].mbps },
    note: artiNote
  }));

  /* --- Nginx (only when bundled, or explicitly kept behind an external LB) --- */
  if (provisionNginx) {
    components.push(buildRow("nginx", "Nginx (reverse proxy / TLS)", {
      storage: { gb: 50, iops: 3000, mbps: 200 },
      note: externalLB
        ? `Dedicated VM per replica, sitting behind the ${lbDisplay}.`
        : "Dedicated VM per replica (JFrog rule). Acts as the reverse proxy / TLS terminator."
    }));
  }

  /* --- Xray + RabbitMQ (Xray DB is sized in the consolidated database block below) --- */
  let externalRmqSpec = null;
  if (xrayEnabled) {
    components.push(buildRow("xray", "Xray", {
      note: "Dedicated VM per replica. Index time scales with artifact count."
    }));
    // RabbitMQ must be deployed in odd-numbered clusters (quorum queues need majority consensus).
    // Single node (1) is acceptable for non-HA small deployments; any cluster ≥ 2 must be rounded up to the next odd number.
    const oddify = n => (n <= 1 ? n : (n % 2 === 0 ? n + 1 : n));
    const rmqBase     = ha ? REPLICAS.rabbitmq[tier] : (xrayArtifacts > 100000 ? 3 : 1);
    const rmqReplicas = oddify(rmqBase);
    const rmqArch     = arch.rabbitmq[tier];
    const rmqStor     = STORAGE.rabbitmq[tier];
    const quorumNote  = rmqReplicas >= 3
      ? `Odd node count (${rmqReplicas}) enforced for quorum — tolerates ${(rmqReplicas - 1) / 2} node failure${(rmqReplicas - 1) / 2 === 1 ? "" : "s"}.`
      : "Single-node mode — no quorum / no failure tolerance.";
    if (externalRMQ) {
      externalRmqSpec = {
        replicas: rmqReplicas, instance: rmqArch.instance, cpu: rmqArch.cpu, memGB: rmqArch.memGB,
        diskGB: rmqStor.gb, iops: rmqStor.iops, mbps: rmqStor.mbps, quorumNote
      };
    } else {
      const splitNote   = xrayArtifacts > 100000 || ha
        ? "Split mode — RabbitMQ on separate VMs from Xray (JFrog HA rule)."
        : "Co-located permitted at ≤100K artifacts (still split here for safety).";
      components.push(buildRow("rabbitmq", "RabbitMQ (Xray)", {
        forceReplicas: rmqReplicas,
        note: `${splitNote} ${quorumNote}`
      }));
    }
  }

  /* --- JAS (Advanced Security) --- */
  if (svc.jas && xrayEnabled) {
    components.push(buildRow("jas", "JAS (Xray Advanced Security)", {
      note: "Dedicated node pool required (JFrog rule — protects Xray + Artifactory)."
    }));
  } else if (svc.jas && !xrayEnabled) {
    // JAS is part of Xray — silently ignore if Xray disabled (warning shown elsewhere).
  }

  /* --- Optional services from hardware sizing matrix --- */
  if (svc.workers) {
    components.push({
      name: "Workers",
      replicas: ha ? 2 : 1,
      instance: arch.nginx[tier].instance, // small footprint - use nginx-class VM as a proxy
      cpu: 4, memGB: 4, diskGB: 50, iops: 3000, mbps: 200,
      note: "Hardware sizing matrix: 4 CPU / 4 GB / 50 GB. Requires Artifactory ≥ 7.98.4."
    });
  }
  if (svc.appTrust) {
    components.push({
      name: "AppTrust",
      replicas: ha ? 2 : 1,
      instance: arch.nginx[tier].instance,
      cpu: 2, memGB: 1, diskGB: 50, iops: 3000, mbps: 200,
      note: "Hardware sizing matrix: 2 CPU / 1 GB / 50 GB."
    });
    components.push({
      name: "UnifiedPolicy",
      replicas: ha ? 2 : 1,
      instance: arch.nginx[tier].instance,
      cpu: 2, memGB: 1, diskGB: 50, iops: 3000, mbps: 200,
      note: "Required alongside AppTrust. 2 CPU / 1 GB / 50 GB."
    });
  }
  // Mission Control is bundled into Artifactory (a platform service on the
  // Artifactory router) — no standalone node and no separate database. The
  // selection only flips on the UI integration (artifactory.mc.enabled in Helm).

  /* --- Curation + Catalog (+ Catalog DB, + Valkey co-located or external) ---
     Curation is a runtime feature of Artifactory + Xray — no dedicated pod/VM.
     It is enabled via system.yaml flags (extraSystemYaml in Helm). The only new
     infrastructure is the Catalog service (standalone pod/VM) and Valkey (cache). */
  let externalValkeySpec = null;
  if (svc.curation) {
    const proxyVM = arch.nginx[tier].instance;
    let catalogMem  = 16;
    let catalogNote = "Catalog service — metadata store for Curation. Curation itself runs as a feature inside the existing Artifactory + Xray pods (no additional VMs/pods).";
    if (!externalValkey) { catalogMem += 8; catalogNote += " Valkey co-located on the Catalog nodes (+8 GB RAM, no new VMs)."; }
    components.push({
      name: "Catalog",
      replicas: ha ? 2 : 1,
      instance: proxyVM,
      cpu: 8, memGB: catalogMem, diskGB: 100, iops: 3000, mbps: 500,
      note: catalogNote
    });
    if (externalValkey) {
      externalValkeySpec = { replicas: ha ? 3 : 1, instance: proxyVM, cpu: 2, memGB: 8, diskGB: 20, iops: 3000, mbps: 200 };
    }
  }

  /* --- Runtime Security (separate jfrog/runtime release + per-node sensor DaemonSet) --- */
  if (svc.runtime) {
    components.push({
      name: "Runtime (server)",
      replicas: ha ? 2 : 1,
      instance: arch.nginx[tier].instance,
      cpu: 2, memGB: 4, diskGB: 50, iops: 3000, mbps: 200,
      note: "JFrog Runtime server (separate jfrog/runtime release). Uses its own 'runtime' database. Sensors run as a per-node DaemonSet (no dedicated nodes)."
    });
  }

  /* --- Databases: one logical DB per product, hosted on a single shared instance
         (default) or a dedicated instance per product (dbInstances). --- */
  const dbProducts = [];
  {
    const adb = arch.artifactoryDb[tier], adbStor = STORAGE.artifactoryDb[tier];
    dbProducts.push({ label:"Artifactory", db:"artifactory", user:"artifactory", cpu:adb.cpu, memGB:adb.memGB,
      instance:adb.instance, maxConns:adb.maxConns, diskGB:Math.max(100, Math.round(binaryTB*1024*adbStor.frac)), iops:adbStor.iops, mbps:adbStor.mbps });
    if (xrayEnabled) {
      const xdb = arch.xrayDb[tier], xdbStor = STORAGE.xrayDb[tier];
      dbProducts.push({ label:"Xray", db:"xraydb", user:"xray", cpu:xdb.cpu, memGB:xdb.memGB, instance:xdb.instance, maxConns:xdb.maxConns, diskGB:xdbStor.gb, iops:xdbStor.iops, mbps:xdbStor.mbps });
    }
    const sdb = arch.xrayDb.small; // small managed-DB SKU for the lighter services
    if (svc.distribution) dbProducts.push({ label:"Distribution", db:"distribution", user:"distribution", cpu:sdb.cpu, memGB:sdb.memGB, instance:sdb.instance, maxConns:sdb.maxConns, diskGB:100, iops:4000, mbps:500 });
    if (svc.curation)     dbProducts.push({ label:"Catalog", db:"catalogdb", user:"catalog", cpu:sdb.cpu, memGB:sdb.memGB, instance:sdb.instance, maxConns:sdb.maxConns, diskGB:200, iops:4000, mbps:500 });
    if (svc.runtime)      dbProducts.push({ label:"Runtime", db:"runtime", user:"runtime", cpu:sdb.cpu, memGB:sdb.memGB, instance:sdb.instance, maxConns:sdb.maxConns, diskGB:50, iops:4000, mbps:500 });
  }
  const dbReplicas = dbMode === "colocated" && ha ? 2 : 1;            // primary + standby for self-run HA
  const dbTotalConns = dbProducts.reduce((s, d) => s + d.maxConns, 0);
  if (dbInstances === "dedicated" && dbProducts.length > 1) {
    dbProducts.forEach(d => components.push({
      name: `PostgreSQL (${d.label} DB)`, replicas: dbReplicas,
      instance: dbMode === "external" ? d.instance : `Co-located ${d.cpu} vCPU / ${d.memGB} GB`,
      cpu: d.cpu, memGB: d.memGB, diskGB: d.diskGB, iops: d.iops, mbps: d.mbps,
      note: `${dbMode === "external" ? `External managed RDBMS (max ${d.maxConns} conns)` : "Co-located"} — dedicated instance for the ${d.label} database (${d.db}).${dbReplicas > 1 ? " Primary+standby for HA." : ""}`
    }));
  } else {
    // Shared: one instance hosting all databases — sized to the dominant (Artifactory)
    // DB, disk = sum of all DBs, max_connections ≥ sum across products.
    const big = dbProducts[0]; // Artifactory DB is the largest/dominant
    const sumDisk = dbProducts.reduce((s, d) => s + d.diskGB, 0);
    components.push({
      name: "PostgreSQL (shared)", replicas: dbReplicas,
      instance: dbMode === "external" ? big.instance : `Co-located ${big.cpu} vCPU / ${big.memGB} GB`,
      cpu: big.cpu, memGB: big.memGB, diskGB: sumDisk, iops: big.iops, mbps: big.mbps,
      note: `${dbMode === "external" ? "External managed RDBMS" : "Co-located"} — single instance hosting ${dbProducts.length} database${dbProducts.length === 1 ? "" : "s"} (${dbProducts.map(d => d.db).join(", ")}). Sized to the dominant (Artifactory) DB; set max_connections ≥ ${dbTotalConns}.${dbReplicas > 1 ? " Primary+standby for HA." : ""}`
    });
  }

  /* --- Compute totals for the active cluster --- */
  function totalsOf(comps) {
    let cpu = 0, mem = 0, disk = 0, nodes = 0;
    comps.forEach(c => {
      c.totalCPU  = c.cpu * c.replicas;
      c.totalMem  = c.memGB * c.replicas;
      c.totalDisk = c.diskGB * c.replicas;
      cpu += c.totalCPU; mem += c.totalMem; disk += c.totalDisk; nodes += c.replicas;
    });
    return { cpu, mem, disk, nodes };
  }
  const activeTotals = totalsOf(components);

  /* --- Build the second site for a multi-site topology (Active+Passive or Active+Active) --- */
  let passiveComponents = null;   // "the second site" (passive in A/P, the other active site in A/A)
  let passiveTotals     = null;
  if (topology === "active-passive" || topology === "active-active") {
    const aa = topology === "active-active";
    // Deep-copy components. Active+Active: a full active mirror (both sites serve traffic).
    // Active+Passive: Hot = identical; Warm = 1 replica per component (RabbitMQ rounded to 3 for quorum), DB at full sizing.
    passiveComponents = components.map(c => {
      const copy = { ...c };
      if (aa) {
        copy.note = `Active site B — ${copy.note}`;
      } else if (passiveScale === "warm") {
        if (c.name === "RabbitMQ (Xray)") {
          copy.replicas = c.replicas >= 3 ? 3 : 1; // keep quorum-capable
        } else if (c.name.startsWith("PostgreSQL")) {
          copy.replicas = c.replicas; // keep DB at full sizing for fast failover (still 1 in managed, 2 if self-HA)
        } else {
          copy.replicas = 1;
        }
        copy.note = `Warm standby — ${copy.note}`;
      } else {
        copy.note = `Hot standby (mirror) — ${copy.note}`;
      }
      return copy;
    });
    passiveTotals = totalsOf(passiveComponents);
  }

  const binaryStorageTarget = STORAGE_CLASS[cloud].object;

  render({
    cloud, cloudLabel, deployment, ha, dbMode, dbInstances, k8sPlacement, topology, passiveScale,
    tier, tierMeta, connsTier, rpmTierKey,
    activeClients, rpm, binaryTB,
    growthPct, activeClientsInput, rpmInput, binaryTBInput, xrayArtifactsInput,
    cacheFs, cacheFsPct, cacheFsGB,
    lbDisplay, externalLB, provisionNginx,
    externalRMQ, externalRmqSpec,
    valkeyMode, externalValkey, externalValkeySpec,
    artiDbMaxConns, xrayDbMaxConns, dbProducts, dbTotalConns,
    xrayArtifacts, xrayEnabled, svc,
    components, activeTotals,
    passiveComponents, passiveTotals,
    binaryStorageTarget
  });
}

/* =============================================================================
   Ports & connectivity — the network ports that must be reachable between the
   deployed components. Deployment-aware: inter-node firewall rules for VMs,
   ingress/egress + intra-cluster guidance for Kubernetes. Conditioned on which
   components (Xray, RabbitMQ, Valkey, Distribution, external services) are in play.
   ============================================================================= */
function buildPortsPanel(r) {
  const xray        = r.xrayEnabled;
  const rmqBundled  = !r.externalRMQ && (r.xrayEnabled || r.svc.distribution || r.svc.workers);
  const rmqInPlay   = r.xrayEnabled || r.svc.distribution || r.svc.workers;
  const externalDb  = r.dbMode === "external";

  const rows = [];
  const row = (ports, proto, flow, purpose) =>
    rows.push(`<tr><td><code>${ports}</code></td><td>${proto}</td><td>${flow}</td><td><span class="hint">${purpose}</span></td></tr>`);

  let intro, notes = [];

  if (r.deployment === "vm") {
    intro = "Open these ports in your security groups / host firewalls so the VMs can talk to each other and to clients. Ports not listed are bound to localhost on each node.";
    row("443, 80", "TCP / HTTPS", `Clients &amp; CI → ${r.externalLB ? r.lbDisplay : "Nginx"}`, "Console UI, REST API, Docker/registry, package clients (TLS on 443).");
    row("8082", "TCP / HTTP", `${r.externalLB ? r.lbDisplay : "Nginx"} → Artifactory`, "JFrog Router — primary upstream for all platform APIs and the UI.");
    row("8081", "TCP / HTTP", `${r.externalLB ? "LB" : "Nginx"} → Artifactory`, "Artifactory service (direct/legacy API path).");
    if (r.ha) row("8081, 8082, 8040", "TCP", "Artifactory ↔ Artifactory (HA replicas)", "HA inter-node: Artifactory, Router, and Access (gRPC) between replicas.");
    row("5432", "TCP", `Platform nodes → ${externalDb ? "external PostgreSQL" : "co-located PostgreSQL"}`, `PostgreSQL — Artifactory${xray ? ", Xray" : ""}${r.svc.distribution ? ", Distribution" : ""}${r.svc.curation ? ", Catalog" : ""}${r.svc.runtime ? ", Runtime" : ""} database(s).`);
    if (xray) {
      row("8082", "TCP / HTTP", "Xray ↔ Artifactory (Router)", "Xray indexing pulls + Artifactory → Xray scan/curation requests.");
      row("8000", "TCP / HTTP", "Xray ↔ Xray (internal services)", "Xray server / analysis / indexer / persist microservices.");
    }
    if (rmqInPlay) {
      row("5672, 5671", "TCP / AMQP(S)", `Xray${r.svc.distribution ? " / Distribution" : ""}${r.svc.workers ? " / Workers" : ""} → ${r.externalRMQ ? "external RabbitMQ" : "RabbitMQ"}`, "Platform message bus (5671 = AMQPS/TLS).");
      if (rmqBundled && r.ha) row("25672, 4369", "TCP", "RabbitMQ ↔ RabbitMQ (cluster)", "Erlang inter-node clustering + epmd. 15672 = management UI/API (optional).");
      if (r.externalRMQ)       row("15672", "TCP / HTTP", "Xray → external RabbitMQ (mgmt)", "Management REST API — Xray uses it to create/inspect queues.");
    }
    if (r.svc.curation) {
      row("6379, 6380", "TCP", `Catalog → ${r.externalValkey ? "external Valkey" : "Valkey"}`, "Curation/Catalog cache (6380 = TLS).");
      if (r.externalValkey && r.ha) row("26379, 16379", "TCP", "Valkey ↔ Valkey (Sentinel / cluster)", "Sentinel quorum + cluster bus (external HA Valkey).");
    }
    if (r.svc.distribution) row("8082", "TCP / HTTP", "Distribution ↔ Artifactory (Router)", "Release-bundle distribution APIs.");
    if (r.svc.runtime) {
      row("8082", "TCP / HTTP", "Runtime ↔ Artifactory (Router)", "Runtime server registers with the platform.");
      row("8082", "TCP / HTTP", "Sensors (every node) → Runtime server", "Per-node sensor agents report to the Runtime server.");
    }
    notes.push("Internal JFrog microservices (Access, Metadata, Frontend, Observability, Event — typically <code>8040–8049</code>, <code>8070</code>, <code>8086</code>) bind to each node and need no cross-node rule; only Artifactory HA replicas open <code>8081/8082/8040</code> between themselves.");
    if (r.externalLB) notes.push(`The ${r.lbDisplay} health-checks and forwards to Artifactory on <code>8082</code> (or <code>8081</code>).`);
    if (r.topology === "active-passive") notes.push("Active+Passive: also allow cross-site replication — the active Artifactory reaches the passive over <code>443/8082</code> (federation/replication), plus your chosen DB replication path.");
    if (r.topology === "active-active") notes.push("Active+Active: allow <strong>bidirectional</strong> cross-site traffic between both sites' Artifactory over <code>443/8082</code> (Federated repositories + Access Federation), and front both sites with a global LB / GSLB.");
  } else {
    intro = "Inside the cluster, pod-to-pod service traffic is handled by the CNI — you only need explicit rules for external ingress and for egress to any external services. The intra-cluster ports are listed for writing NetworkPolicies.";
    row("443, 80", "TCP / HTTPS", "Clients &amp; CI → Ingress / LoadBalancer Service", "External entry (Ingress controller or cloud LB Service; TLS on 443).");
    row("30000–32767", "TCP", "Clients → Nodes (NodePort only)", "NodePort service range — only if you expose via NodePort instead of Ingress/LB.");
    if (externalDb)        row("5432", "TCP (egress)", "Cluster pods → external PostgreSQL", "Allow cluster egress to your managed/standalone DB.");
    if (r.externalRMQ)     row("5672, 5671, 15672", "TCP (egress)", "Cluster pods → external RabbitMQ", "AMQP(S) + management REST API.");
    if (r.svc.curation && r.externalValkey) row("6379, 6380", "TCP (egress)", "Cluster pods → external Valkey", "Cache (TLS on 6380).");
    const intra = ["Router <code>8082</code>", "Artifactory <code>8081</code>", "Access <code>8040</code>"];
    if (xray) intra.push("Xray <code>8000</code>");
    if (rmqBundled) intra.push("RabbitMQ <code>5672</code>");
    if (!externalDb) intra.push("PostgreSQL <code>5432</code>");
    if (r.svc.curation && !r.externalValkey) intra.push("Valkey <code>6379</code>");
    if (r.svc.runtime) intra.push("Runtime <code>8082</code> (+ sensor DaemonSet on every node)");
    notes.push(`Intra-cluster (pod-to-pod, CNI-handled; allow these in NetworkPolicies if enforced): ${intra.join(" · ")}.`);
    notes.push("Standard cluster ports (kube-apiserver <code>6443</code>, kubelet <code>10250</code>, etcd <code>2379–2380</code>, NodePort <code>30000–32767</code>) are part of your Kubernetes setup, not JFrog-specific.");
    if (r.topology === "active-passive") notes.push("Active+Passive: open cross-cluster ingress on <code>443</code> between sites for federation/replication.");
    if (r.topology === "active-active") notes.push("Active+Active: open <strong>bidirectional</strong> cross-cluster ingress on <code>443</code> between both sites (federation), and use a global LB / GSLB across both clusters' ingresses.");
  }

  return `
    <details class="panel">
      <summary style="font-size:14px;">Ports &amp; connectivity — ${r.deployment === "k8s" ? "Kubernetes" : "Virtual Machines"}</summary>
      <p style="margin:10px 0 10px; font-size:13px; color:var(--muted);">${intro}</p>
      <table>
        <thead><tr><th>Port(s)</th><th>Protocol</th><th>From → To</th><th>Purpose</th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>
      ${notes.map(n => `<div class="hint" style="margin-top:8px;">${n}</div>`).join("")}
      <div class="hint" style="margin-top:8px;">Defaults shown; ports are configurable in <code>system.yaml</code>. Reference: <a href="https://docs.jfrog.com/installation/docs/network-requirements-for-jfrog-products" target="_blank">JFrog — Network Ports</a>.</div>
    </details>
  `;
}

/* =============================================================================
   Licensing — maps the selected products to the minimum JFrog self-hosted
   subscription tier (Pro < Enterprise X < Enterprise+), flags the JAS add-on,
   and shows how many Artifactory licenses the deployment consumes. Tiers and
   inclusions change over time — always confirm exact entitlements with JFrog.
   ============================================================================= */
// Per-product → minimum subscription tier mapping (single source for the panel + the warning).
function licenseItems(r) {
  const items = [];
  const add = (name, tier, note) => items.push({ name, tier, note });
  add("Artifactory — core repositories, all package types", "Pro", "Single-node Artifactory is the entry tier.");
  if (r.ha)             add("High Availability — multi-node Artifactory", "Enterprise X", "HA / multiple Artifactory nodes require Enterprise X or above.");
  if (r.xrayEnabled)    add("Xray — SCA (security &amp; license scanning)", "Enterprise X", "Included from Enterprise X (also offered as a Pro add-on in some plans).");
  if (r.svc.jas)        add("JFrog Advanced Security (JAS)", "Enterprise X", "Paid <strong>add-on</strong> on top of an Xray-enabled subscription — Secrets, IaC, SAST, Contextual Analysis, etc.");
  if (r.svc.workers)    add("Workers — event-driven automation", "Enterprise X", "Entitlement-gated platform feature — confirm inclusion for your plan.");
  if (r.svc.runtime)    add("Runtime Security (Runtime + sensors)", "Enterprise X", "Part of JFrog's runtime security offering — paid add-on / entitlement on top of the security subscription; confirm with JFrog.");
  if (r.svc.distribution) add("Distribution — release bundles &amp; Edge nodes", "Enterprise+", "Enterprise+; Edge nodes additionally carry their own Edge license.");
  if (r.svc.missionControl) add("Mission Control — Topology / management plane", "Enterprise+", "Enterprise+ feature (bundled into Artifactory).");
  if (r.svc.curation)   add("Curation + Catalog", "Enterprise+", "Requires Enterprise+ (or a dedicated Curation entitlement).");
  if (r.svc.appTrust)   add("AppTrust + Unified Policy", "Enterprise+", "Release-lifecycle / evidence — Enterprise+ (newer products may need a specific entitlement).");
  if (r.topology === "active-passive") add("Active + Passive DR — multi-site &amp; Federation", "Enterprise+", "Multi-site, Federated repositories and Access Federation are Enterprise+.");
  if (r.topology === "active-active")  add("Active + Active — multi-site &amp; bidirectional Federation", "Enterprise+", "Two active sites, Federated repositories + Access Federation — Enterprise+.");
  return items;
}
function licenseEffectiveTier(r) {
  const TIERS = ["Pro", "Enterprise X", "Enterprise+"];
  return licenseItems(r).reduce((m, it) => TIERS.indexOf(it.tier) > TIERS.indexOf(m) ? it.tier : m, "Pro");
}
// How many JFrog licenses this configuration consumes. JPD is licensed per
// Artifactory node (one license per HA node, per site); other JPD services are
// entitlements within the subscription, not separately-licensed servers. Edge
// (Distribution) nodes carry their own Edge licenses.
function licenseCount(r) {
  const arti = findComp(r, "Artifactory");
  const active  = arti ? arti.replicas : 1;
  const passive = (r.passiveComponents || []).filter(c => c.name === "Artifactory").reduce((s, c) => s + c.replicas, 0);
  return {
    tier:    licenseEffectiveTier(r),
    active,
    passive,
    total:   active + passive,
    jas:     !!r.svc.jas,
    edge:    !!r.svc.distribution
  };
}

/* =============================================================================
   Deployment architecture diagram — a self-contained, dynamically generated SVG
   (no dependencies, renders over file://). Reacts to cloud, deployment model,
   topology, HA, and the selected products. Schematic: Region → VPC/VNet →
   public/private subnets across AZs → component boxes → in-region managed
   services, with a cross-region replication arrow for Active+Passive.
   ============================================================================= */
const DIAGRAM_REGIONS = {
  aws:    { vpc:"VPC", az:"Availability Zones", k8s:"EKS", db:"RDS for PostgreSQL", obj:"Amazon S3", active:"Region us-east-1", passive:"Region us-west-2", lb:"ALB / NLB" },
  azure:  { vpc:"VNet", az:"Availability Zones", k8s:"AKS", db:"Azure DB for PostgreSQL", obj:"Azure Blob Storage", active:"Region East US", passive:"Region West US", lb:"Application Gateway" },
  gcp:    { vpc:"VPC network", az:"zones", k8s:"GKE", db:"Cloud SQL", obj:"Cloud Storage", active:"Region us-central1", passive:"Region us-west1", lb:"Cloud Load Balancing" },
  onprem: { vpc:"Network / VLAN", az:"racks", k8s:"Kubernetes", db:"PostgreSQL (self-run)", obj:"S3-compatible store", active:"Primary datacenter", passive:"DR datacenter", lb:"External / hardware LB" }
};

function buildArchitectureDiagram(r) {
  const esc = escapeHtml;
  const C = { region:"#12151b", border:"#2a2f3a", accent:"#40bf6a", accentDim:"#2a8f4d", node:"#1f232c", lb:"#13251a", managed:"#171a21", txt:"#e6e8ee", muted:"#9aa3b2" };
  const REG = DIAGRAM_REGIONS[r.cloud];
  const isAP    = r.topology === "active-passive";
  const isAA    = r.topology === "active-active";
  const isMulti = isAP || isAA;
  const isK8s = r.deployment === "k8s";
  const azCount = r.ha ? 3 : 1;
  const lbShort = r.externalLB ? REG.lb : "NGINX (reverse proxy)";

  const boxW = 150, boxH = 46, gx = 12, gy = 12, COLS = 3, P = 16, bandGap = 16, pad = 8;
  const contentW = COLS * boxW + (COLS - 1) * gx;
  const regW = contentW + 2 * P;

  const clip = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;
  const T = (x, y, s, o = {}) => `<text x="${x}" y="${y}" fill="${o.fill || C.txt}" font-size="${o.size || 12}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif"${o.weight ? ` font-weight="${o.weight}"` : ""}${o.anchor ? ` text-anchor="${o.anchor}"` : ""}>${esc(s)}</text>`;
  const RECT = (x, y, w, h, fill, stroke, rx, dash) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1"${dash ? ` stroke-dasharray="5 4"` : ""}/>`;
  const cbox = (x, y, label, sub, kind) => {
    const fill = kind === "lb" ? C.lb : kind === "managed" ? C.managed : C.node;
    const stroke = kind === "lb" ? C.accent : kind === "managed" ? C.muted : C.border;
    return RECT(x, y, boxW, boxH, fill, stroke, 6, kind === "managed")
      + T(x + 10, y + 19, clip(label, 21), { weight: 600 })
      + T(x + 10, y + 35, clip(sub, 27), { fill: C.muted, size: 10 });
  };
  const layout = (x, y, items, kind) => {
    let s = "";
    items.forEach((it, i) => { s += cbox(x + (i % COLS) * (boxW + gx), y + Math.floor(i / COLS) * (boxH + gy), it.label, it.sub, kind); });
    const rows = Math.max(1, Math.ceil(items.length / COLS));
    return { svg: s, endY: y + rows * boxH + (rows - 1) * gy };
  };
  const shortLabel = n => n
    .replace(/^PostgreSQL \((.+?) DB\)$/, "PG · $1")
    .replace(/^PostgreSQL \(shared\)$/, "PostgreSQL")
    .replace(/ \(reverse proxy \/ TLS\)/, "")
    .replace(/ \(Xray\)/, "")
    .replace(/ \(server\)/, " server")
    .replace(/ \(Xray Advanced Security\)/, "");
  const compBoxes = comps => comps.map(c => ({ label: shortLabel(c.name), sub: `×${c.replicas} · ${c.cpu} vCPU / ${c.memGB} GB` }));

  const managed = [{ label: REG.obj, sub: "binary store" }];
  if (r.dbMode === "external") managed.push({ label: REG.db, sub: r.dbInstances === "dedicated" ? "dedicated per product" : "shared instance" });
  if (r.externalRMQ && r.xrayEnabled) managed.push({ label: "RabbitMQ", sub: "external cluster" });
  if (r.svc.curation && r.externalValkey) managed.push({ label: "Valkey", sub: "external cache" });

  function regionSvg(x0, headerText, comps) {
    const innerX = x0 + P;
    const c = [];
    const top = 6;
    let y = top + 20;
    c.push(T(x0 + 12, y, headerText, { size: 13, weight: 600 }));
    y += 8;
    const vpcTop = y;
    y += 22;
    c.push(T(innerX, y, `${REG.vpc} · 10.0.0.0/16`, { fill: C.muted, size: 11, weight: 600 })); y += 18;
    c.push(T(innerX, y, "Public subnet", { fill: C.muted, size: 10 })); y += 14;
    const lbItems = [{ label: lbShort, sub: "443 / 80" }];
    if (r.cloud !== "onprem") lbItems.push({ label: "NAT gateway", sub: "egress" });
    { const o = layout(innerX, y, lbItems, "lb"); c.push(o.svg); y = o.endY + bandGap; }
    c.push(T(innerX, y, `${isK8s ? REG.k8s + " worker nodes" : "VM instances"} — private subnets across ${azCount} ${REG.az}`, { fill: C.muted, size: 10 })); y += 14;
    { const o = layout(innerX, y, compBoxes(comps), "node"); c.push(o.svg); y = o.endY + bandGap; }
    c.push(T(innerX, y, "In-region managed services", { fill: C.muted, size: 10 })); y += 14;
    { const o = layout(innerX, y, managed, "managed"); c.push(o.svg); y = o.endY; }
    const vpcBottom = y + 10;
    const regBottom = vpcBottom + 10;
    const rects = RECT(x0, top, regW, regBottom - top, C.region, C.border, 10)
      + RECT(x0 + 8, vpcTop, regW - 16, vpcBottom - vpcTop, "none", C.accentDim, 8, true);
    return { svg: rects + c.join(""), h: regBottom + top };
  }

  if (!isMulti) {
    const reg = regionSvg(pad, `${r.cloudLabel} · ${REG.active}`, r.components);
    const W = regW + pad * 2, H = reg.h + pad;
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;height:auto;background:#0f1115;border-radius:8px;" xmlns="http://www.w3.org/2000/svg">${reg.svg}</svg>`;
  }
  const arrowGap = 96;
  const r1 = regionSvg(pad, `${r.cloudLabel} · ${REG.active} (${isAA ? "Active A" : "Active"})`, r.components);
  const x2 = pad + regW + arrowGap;
  const r2label = isAA ? "Active B" : `Passive · ${r.passiveScale === "hot" ? "Hot mirror" : "Warm"}`;
  const r2 = regionSvg(x2, `${r.cloudLabel} · ${REG.passive} (${r2label})`, r.passiveComponents || r.components);
  const H = Math.max(r1.h, r2.h) + pad, W = x2 + regW + pad;
  const midY = Math.round(H / 2), ax1 = pad + regW, ax2 = x2;
  // Active+Active = bidirectional federation arrow; Active+Passive = one-way replication.
  const arrow = `<defs><marker id="jpd-ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="${C.accent}"/></marker><marker id="jpd-ah2" markerWidth="9" markerHeight="9" refX="2" refY="3" orient="auto"><path d="M7,0 L0,3 L7,6 Z" fill="${C.accent}"/></marker></defs>`
    + `<line x1="${ax1 + 6}" y1="${midY}" x2="${ax2 - 6}" y2="${midY}" stroke="${C.accent}" stroke-width="1.5" marker-end="url(#jpd-ah)"${isAA ? ` marker-start="url(#jpd-ah2)"` : ""}/>`
    + T((ax1 + ax2) / 2, midY - 8, "Federation /", { fill: C.muted, size: 10, anchor: "middle" })
    + T((ax1 + ax2) / 2, midY + 14, isAA ? "(bidirectional)" : "replication", { fill: C.muted, size: 10, anchor: "middle" });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;height:auto;background:#0f1115;border-radius:8px;" xmlns="http://www.w3.org/2000/svg">${arrow}${r1.svg}${r2.svg}</svg>`;
}

function buildDiagramPanel(r) {
  return `
    <details class="panel" open>
      <summary style="font-size:14px;">Deployment architecture — ${r.cloudLabel}${r.topology === "active-passive" ? " (Active + Passive)" : r.topology === "active-active" ? " (Active + Active)" : ""}</summary>
      <p style="margin:10px 0 8px; font-size:13px; color:var(--muted);">Schematic of the ${r.deployment === "k8s" ? "Kubernetes" : "VM"} deployment for the selected products. Component boxes show <em>name ×replicas</em>; dashed boxes are managed / external services.</p>
      <div style="margin-top:8px;">${buildArchitectureDiagram(r)}</div>
      <button class="export" id="diagramBtn">⤓ Download diagram (.svg)</button>
      <div class="hint" style="margin-top:8px;">Schematic only — CIDRs and region names are illustrative. ${r.ha ? "HA replicas spread across multiple AZs/zones." : "Single-AZ (no HA)."} Managed / external services sit outside the subnets. Sensors (Runtime) run as a per-node DaemonSet and aren't drawn as separate boxes.</div>
    </details>`;
}

function buildLicensePanel(r) {
  const items     = licenseItems(r);
  const lic       = licenseCount(r);
  const effective = lic.tier;
  const effClass  = effective === "Enterprise+" ? "danger" : effective === "Enterprise X" ? "warn" : "ok";

  const totalArti = lic.total;
  const splitNote = r.topology === "active-passive" ? ` (${lic.active} active + ${lic.passive} passive)`
                  : r.topology === "active-active"  ? ` (${lic.active} site A + ${lic.passive} site B)`
                  : "";

  const rows = items.map(it => {
    const cls = it.tier === "Enterprise+" ? "danger" : it.tier === "Enterprise X" ? "warn" : "ok";
    return `<tr><td><strong>${it.name}</strong></td><td><span class="chip ${cls}">${it.tier}</span></td><td><span class="hint">${it.note}</span></td></tr>`;
  }).join("");

  return `
    <details class="panel">
      <summary style="font-size:14px;">Licensing — minimum subscription: ${effective} · ${totalArti} Artifactory license${totalArti === 1 ? "" : "s"}</summary>
      <div class="notice ${effClass}" style="margin-top:10px;">
        <strong>Minimum subscription for this configuration: ${effective}.</strong>
        ${r.svc.jas ? " Plus the <strong>JFrog Advanced Security</strong> add-on (on top of the Xray entitlement)." : ""}
        One subscription licenses the whole JFrog Platform Deployment (JPD) — Xray, Distribution, Mission Control, etc. are entitlements within that tier, not separately-licensed servers.
      </div>
      <div class="notice ${effClass}" style="margin-top:10px;">
        <strong>Licenses needed for this configuration: ${totalArti} Artifactory node license${totalArti === 1 ? "" : "s"}${splitNote}.</strong>
        JPD is licensed per Artifactory node — one license per HA node, per site.${lic.edge ? " Distribution Edge nodes carry their own <strong>Edge licenses</strong> (counted separately)." : ""}
      </div>
      <table>
        <thead><tr><th>Product / capability</th><th>Min. subscription</th><th>Notes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="hint" style="margin-top:10px;"><strong>License count:</strong> HA consumes one Artifactory license per node — this deployment uses <strong>${totalArti}</strong> Artifactory license${totalArti === 1 ? "" : "s"}${splitNote} from your license bucket.${r.svc.distribution ? " Distribution Edge nodes are licensed separately (Edge licenses)." : ""}</div>
      <div class="hint" style="margin-top:6px;"><strong>How it's applied:</strong> ${r.deployment === "k8s"
        ? "supply the license to the Helm chart via a Secret (<code>artifactory.license.secret</code> / <code>licenseKey</code>) or post-install through the UI / Access API."
        : "drop <code>artifactory.lic</code> into <code>$JFROG_HOME/artifactory/var/etc/artifactory/</code> (or apply via the UI / Access API) at install time."}</div>
      <div class="hint" style="margin-top:6px;">Subscription tiers, inclusions and pricing change over time — <strong>confirm exact entitlements with your JFrog account team</strong>. Reference: <a href="https://jfrog.com/pricing/" target="_blank">JFrog subscriptions</a> &middot; <a href="https://jfrog.com/help/r/jfrog-installation-setup-documentation/manage-the-artifactory-license" target="_blank">Managing the license</a>.</div>
    </details>
  `;
}

/* ---------- Render ---------- */

let lastResult = null; // most recent render() input, for CSV export

function render(r) {
  lastResult = r;
  const deployLabel = r.deployment === "k8s" ? "Kubernetes" : "Virtual Machines";
  const tierName    = TIER_LABEL[r.tier];
  const isAP        = r.topology === "active-passive";
  const isAA        = r.topology === "active-active";
  const isMulti     = isAP || isAA;                           // two-site topology
  const siteALabel  = isAA ? "Site A (active)" : "Active site";
  const siteBLabel  = isAA ? "Site B (active)" : `Passive site (${r.passiveScale === "hot" ? "Hot mirror" : "Warm minimal"})`;
  const placement   = r.deployment === "k8s"
    ? (r.k8sPlacement === "antiaffinity" ? "K8s anti-affinity (shared pool)" : "K8s dedicated node pool")
    : "VM (one Artifactory per VM)";
  let html = "";

  /* Summary */
  html += `
    <div class="panel">
      <h2>Deployment summary</h2>
      <div class="summary-grid">
        <div class="stat"><div class="label">Environment</div><div class="value">${r.cloudLabel}</div></div>
        <div class="stat"><div class="label">Model</div><div class="value">${deployLabel}</div></div>
        <div class="stat"><div class="label">Tier</div><div class="value">${tierName}</div></div>
        <div class="stat"><div class="label">Topology</div><div class="value">${isAA ? "Active+Active" : isAP ? "Active+Passive" : "Single"}</div></div>
      </div>
      <div style="margin-top:14px;">
        <span class="chip">${r.activeClients.toLocaleString()} concurrent conns → ${TIER_LABEL[r.connsTier]}</span>
        <span class="chip">${r.rpm.toLocaleString()} RPM → ${TIER_LABEL[r.rpmTierKey]}</span>
        <span class="chip warn">Effective tier: ${tierName} (max of both)</span>
        ${r.xrayEnabled ? `<span class="chip">Xray ${r.xrayArtifacts.toLocaleString()} indexed</span>` : `<span class="chip">No Xray</span>`}
        ${r.growthPct > 0 ? `<span class="chip warn">+${r.growthPct}% growth headroom</span>` : ""}
        ${r.cacheFsGB > 0 ? `<span class="chip ok">Cache-fs ${fmtGB(r.cacheFsGB)}/node</span>` : ""}
      </div>
      <div style="margin-top:10px;">
        <span class="chip ok">${r.ha ? "HA enabled" : "Single replica"}</span>
        <span class="chip ok">Placement: ${placement}</span>
        <span class="chip ok">LB: ${r.lbDisplay}</span>
        ${r.externalLB && !r.provisionNginx ? `<span class="chip warn">No Nginx tier</span>` : ""}
        ${r.externalRMQ && r.xrayEnabled ? `<span class="chip warn">External RabbitMQ</span>` : ""}
        ${r.svc.curation ? `<span class="chip ok">Curation + Catalog</span>` : ""}
        ${r.svc.curation && r.externalValkey ? `<span class="chip warn">External Valkey</span>` : ""}
        ${isAP ? `<span class="chip warn">Passive: ${r.passiveScale === "hot" ? "Hot mirror" : "Warm minimal"}</span>` : ""}
        ${isAA ? `<span class="chip warn">Active+Active (2 sites)</span>` : ""}
      </div>
      ${r.growthPct > 0 ? `
      <div class="notice info" style="margin-top:12px;">
        <strong>Sized for ${r.growthPct}% projected growth.</strong>
        Today → projected:
        ${r.activeClientsInput.toLocaleString()} → <strong>${r.activeClients.toLocaleString()}</strong> concurrent connections ·
        ${r.rpmInput.toLocaleString()} → <strong>${r.rpm.toLocaleString()}</strong> RPM ·
        ${r.binaryTBInput} → <strong>${r.binaryTB} TB</strong> binaries${r.xrayEnabled ? ` ·
        ${r.xrayArtifactsInput.toLocaleString()} → <strong>${r.xrayArtifacts.toLocaleString()}</strong> indexed artifacts` : ""}.
      </div>` : ""}
    </div>
  `;

  /* Warnings */
  const warnings = [];
  if (r.activeClients > 6000)            warnings.push({type:"danger", text:"Concurrent connections exceed 6,000 (2XLarge tier ceiling) — contact JFrog Support for custom Enterprise+ sizing."});
  if (r.rpm > 500000)                    warnings.push({type:"danger", text:"RPM exceeds published 2XLarge tier (500K). Custom sizing required."});
  if (r.xrayArtifacts > 10000000)        warnings.push({type:"danger", text:"Indexed artifacts exceed 10M — contact JFrog Support."});
  if (r.svc.jas && !r.xrayEnabled)       warnings.push({type:"warn",   text:"JAS requires Xray. Enable Xray or uncheck JAS — it has been skipped."});
  if (r.deployment === "k8s")            warnings.push({type:"info",   text:"<strong>Kubernetes:</strong> the per-replica vCPU/RAM below represent the worker-node capacity each pod needs. JFrog's Helm chart sizing presets (in <code>jfrog/charts</code>) define authoritative per-pod requests/limits — typically smaller because requests are floors, not host totals."});
  {
    const licTier = licenseEffectiveTier(r);
    warnings.push({type: licTier === "Enterprise+" ? "warn" : "info",
      text:`<strong>Licensing:</strong> this configuration needs at least a <strong>${licTier}</strong> self-hosted subscription${r.svc.jas ? " plus the <strong>JFrog Advanced Security</strong> add-on" : ""}${r.svc.runtime ? " plus the <strong>Runtime Security</strong> entitlement" : ""}. See the Licensing section for the per-product breakdown and license count. Confirm exact entitlements with your JFrog account team.`});
  }

  if (warnings.length) {
    html += `<div class="panel"><h2>Notes &amp; warnings</h2>`;
    warnings.forEach(w => {
      const cls = w.type === "danger" ? "danger" : w.type === "info" ? "info" : "";
      html += `<div class="notice ${cls}" style="margin-bottom:8px;">${w.text}</div>`;
    });
    html += `</div>`;
  }

  /* Aggregate footprint */
  const nodeStatLabel = r.deployment === "k8s" ? "Total nodes" : "VM instances";
  function footprintCard(label, t) {
    return `
      <div class="panel">
        <h2>${label}</h2>
        <div class="summary-grid">
          <div class="stat"><div class="label">${nodeStatLabel}</div><div class="value">${t.nodes}</div></div>
          <div class="stat"><div class="label">vCPU</div><div class="value">${t.cpu}</div></div>
          <div class="stat"><div class="label">Memory</div><div class="value">${t.mem}<span class="unit">GB</span></div></div>
          <div class="stat"><div class="label">Service disk</div><div class="value">${fmtGB(t.disk)}</div></div>
        </div>
      </div>
    `;
  }
  if (isMulti) {
    const gt = {
      nodes: r.activeTotals.nodes + r.passiveTotals.nodes,
      cpu:   r.activeTotals.cpu   + r.passiveTotals.cpu,
      mem:   r.activeTotals.mem   + r.passiveTotals.mem,
      disk:  r.activeTotals.disk  + r.passiveTotals.disk
    };
    html += footprintCard(`Grand total (${isAA ? "Active + Active" : "Active + Passive"})`, gt);
    html += `<div class="totals">
      ${footprintCard(siteALabel, r.activeTotals)}
      ${footprintCard(siteBLabel, r.passiveTotals)}
    </div>`;
  } else {
    html += footprintCard("Aggregate footprint", r.activeTotals);
  }

  /* Deployment architecture diagram */
  html += buildDiagramPanel(r);

  /* Kubernetes cluster plan — group component node recommendations into node pools.
     Cluster capacity adds ~15% headroom for kubelet/OS/CNI and system DaemonSets. */
  if (r.deployment === "k8s") {
    const SYS_OVERHEAD = 1.15;
    // Managed databases run outside the cluster — exclude them from the worker plan.
    const externalDb = r.dbMode === "external";
    const k8sPlan = comps => {
      const workerComps = comps.filter(c => !(externalDb && c.name.startsWith("PostgreSQL")));
      const externalDbs = externalDb ? comps.filter(c => c.name.startsWith("PostgreSQL")) : [];
      const pools = {};
      workerComps.forEach(c => {
        if (!pools[c.instance]) pools[c.instance] = { instance: c.instance, cpu: c.cpu, memGB: c.memGB, count: 0, usedBy: [] };
        pools[c.instance].count += c.replicas;
        pools[c.instance].usedBy.push(`${c.name}${c.replicas > 1 ? ` ×${c.replicas}` : ""}`);
      });
      const arr = Object.values(pools).sort((a, b) => b.count - a.count);
      const workerNodes = arr.reduce((s, p) => s + p.count, 0);
      const workerCPU   = arr.reduce((s, p) => s + p.cpu * p.count, 0);
      const workerMem   = arr.reduce((s, p) => s + p.memGB * p.count, 0);
      const dbNote = externalDbs.length
        ? ` Plus ${externalDbs.length} managed database${externalDbs.length > 1 ? "s" : ""} (${externalDbs.map(d => d.instance).join(", ")}) provisioned as external managed service${externalDbs.length > 1 ? "s" : ""}, outside the cluster.`
        : "";
      return { pools: arr, workerNodes, workerCPU, workerMem,
        clusterCPU: Math.ceil(workerCPU * SYS_OVERHEAD), clusterMem: Math.ceil(workerMem * SYS_OVERHEAD), dbNote };
    };
    const cpName = { aws: "EKS", azure: "AKS", gcp: "GKE" }[r.cloud];
    const controlPlaneNote = r.cloud === "onprem"
      ? "Self-managed control plane: add 3 dedicated control-plane nodes (4 vCPU / 8 GB each, stacked etcd) per cluster for quorum — not counted in the worker totals."
      : `Managed control plane (${cpName}) — control-plane sizing &amp; HA are handled by the cloud provider, at no worker-node cost.`;
    const placementNote = r.k8sPlacement === "antiaffinity"
      ? "Anti-affinity (shared pool): stateful pods are spread across nodes but may share them — node count is an upper bound that bin-packing can reduce."
      : "Dedicated node pool: one Artifactory/Nginx/Xray pod per node. Smaller stateless pods can share nodes — figures are a safe upper bound.";
    const k8sPlanCard = (label, plan) => `
      <div class="panel">
        <h2>Kubernetes cluster plan — ${label}</h2>
        <div class="summary-grid">
          <div class="stat"><div class="label">Worker nodes</div><div class="value">${plan.workerNodes}</div></div>
          <div class="stat"><div class="label">Node pools</div><div class="value">${plan.pools.length}</div></div>
          <div class="stat"><div class="label">Cluster vCPU</div><div class="value">${plan.clusterCPU}<span class="unit">w/ sys</span></div></div>
          <div class="stat"><div class="label">Cluster RAM</div><div class="value">${plan.clusterMem}<span class="unit">GB w/ sys</span></div></div>
        </div>
        <table style="margin-top:12px;">
          <thead><tr><th>Node pool (VM size)</th><th>vCPU</th><th>RAM</th><th>Nodes</th><th>Runs</th></tr></thead>
          <tbody>
            ${plan.pools.map(p => `
              <tr>
                <td><code>${p.instance}</code></td>
                <td>${p.cpu}</td>
                <td>${p.memGB} GB</td>
                <td><strong>${p.count}</strong></td>
                <td><span class="hint">${p.usedBy.join(", ")}</span></td>
              </tr>`).join("")}
            <tr style="background:var(--panel-2);">
              <td><strong>Total worker capacity</strong></td>
              <td><strong>${plan.workerCPU}</strong></td>
              <td><strong>${plan.workerMem} GB</strong></td>
              <td><strong>${plan.workerNodes}</strong></td>
              <td></td>
            </tr>
          </tbody>
        </table>
        <div class="notice info" style="margin-top:12px;">
          <strong>Cluster sizing:</strong> ${plan.workerNodes} worker nodes across ${plan.pools.length} node pool${plan.pools.length === 1 ? "" : "s"} provide <strong>${plan.workerCPU} vCPU / ${plan.workerMem} GB</strong> of pod-schedulable capacity. Adding ~15% for kubelet, OS, CNI and system DaemonSets, provision ≈ <strong>${plan.clusterCPU} vCPU / ${plan.clusterMem} GB</strong>. ${controlPlaneNote}${plan.dbNote}
        </div>
        <div class="hint" style="margin-top:8px;">${placementNote}</div>
      </div>
    `;
    if (isMulti) {
      html += k8sPlanCard(siteALabel, k8sPlan(r.components));
      html += k8sPlanCard(siteBLabel, k8sPlan(r.passiveComponents));
    } else {
      html += k8sPlanCard(r.cloudLabel, k8sPlan(r.components));
    }
  }

  // Storage + network row (shared across topology)
  html += `
    <div class="panel">
      <div class="totals">
        <div class="total-card">
          <div class="label">Binary / artifact storage</div>
          <div class="value">${isMulti ? (r.binaryTB * 2) : r.binaryTB} TB</div>
          <div class="hint" style="margin-top:6px;">${r.binaryStorageTarget}${isMulti ? ` — ${r.binaryTB} TB per site (federation replicates ${isAA ? "both ways" : "active → passive"})` : ""}</div>
        </div>
        <div class="total-card">
          <div class="label">Network</div>
          <div class="value">${NETWORK_REC[r.cloud].split(",")[0]}</div>
          <div class="hint" style="margin-top:6px;">${NETWORK_REC[r.cloud]}${isMulti ? ` Cross-site ${isAA ? "bidirectional " : ""}replication: ensure adequate WAN bandwidth + low latency for federation.` : ""}</div>
        </div>
      </div>
    </div>
  `;

  /* Per-component table + procurement tally — rendered per cluster */
  const instColHeader = r.deployment === "k8s" ? "Recommended node-pool VM" : "VM instance";
  function clusterSection(label, comps) {
    let h = `
      <div class="panel">
        <h2>${label} — per-component sizing (${r.cloudLabel} ${tierName}, ${deployLabel})</h2>
        <table>
          <thead>
            <tr>
              <th>Component</th><th>Replicas</th><th>vCPU</th><th>RAM</th>
              <th>Disk / IOPS</th><th>${instColHeader}</th><th>Notes</th>
            </tr>
          </thead>
          <tbody>
    `;
    comps.forEach(c => {
      h += `
        <tr>
          <td><strong>${c.name}</strong></td>
          <td>${c.replicas}</td>
          <td>${c.cpu}</td>
          <td>${c.memGB} GB</td>
          <td>${fmtGB(c.diskGB)} <span class="hint">/ ${c.iops.toLocaleString()} IOPS</span></td>
          <td><code>${c.instance}</code><br><span class="hint">${c.cpu} vCPU / ${c.memGB} GB</span></td>
          <td><span class="hint">${c.note}</span></td>
        </tr>
      `;
    });
    h += `</tbody></table></div>`;

    // Procurement tally for this cluster
    const tally = {};
    comps.forEach(c => {
      const key = c.instance;
      if (!tally[key]) tally[key] = { cpu: c.cpu, memGB: c.memGB, count: 0, usedBy: [] };
      tally[key].count += c.replicas;
      tally[key].usedBy.push(`${c.name} ×${c.replicas}`);
    });
    const rows = Object.entries(tally).sort((a,b) => b[1].count - a[1].count);
    const total = rows.reduce((s,[,v]) => s + v.count, 0);
    const procTitle = r.deployment === "k8s"
      ? `${label} — ${r.cloudLabel} VMs for worker pool`
      : `${label} — ${r.cloudLabel} VM procurement list`;
    h += `<div class="panel"><h2>${procTitle}</h2>
      <table>
        <thead><tr><th>VM type</th><th>vCPU</th><th>RAM</th><th>Count</th><th>Used by</th></tr></thead>
        <tbody>`;
    rows.forEach(([name, info]) => {
      h += `<tr>
        <td><code>${name}</code></td>
        <td>${info.cpu}</td>
        <td>${info.memGB} GB</td>
        <td><strong>${info.count}</strong></td>
        <td><span class="hint">${info.usedBy.join(", ")}</span></td>
      </tr>`;
    });
    h += `<tr style="background:var(--panel-2);">
        <td colspan="3"><strong>Total VM instances</strong></td>
        <td><strong>${total}</strong></td>
        <td></td>
      </tr></tbody></table></div>`;
    return h;
  }

  html += clusterSection(isMulti ? siteALabel : "Cluster", r.components);
  if (isMulti) html += clusterSection(siteBLabel, r.passiveComponents);

  /* Licensing */
  html += buildLicensePanel(r);

  /* Co-location rules */
  html += `
    <details class="panel">
      <summary style="font-size:14px;">Co-location rules (from JFrog reference architecture)</summary>
      <table>
        <thead><tr><th>Rule</th><th>Relation</th><th>Applies to</th></tr></thead>
        <tbody>
  `;
  COLOCATION_RULES.forEach(rule => {
    const cls = rule.relation === "co-locate" ? "ok" : rule.relation === "odd-quorum" ? "danger" : "warn";
    html += `
      <tr>
        <td><blockquote>"${rule.rule}"</blockquote></td>
        <td><span class="chip ${cls}">${rule.relation}</span></td>
        <td>${rule.components.map(c => `<span class="chip">${c}</span>`).join("")}</td>
      </tr>
    `;
  });
  html += `</tbody></table>`;
  // Show explicitly which rule was applied in this calculation
  const applied = [];
  if (r.svc.distribution) applied.push("Distribution co-located onto Artifactory nodes (+200 GB disk, no new VMs).");
  if (r.xrayEnabled && r.externalRMQ) {
    applied.push(`RabbitMQ externalized — ${r.externalRmqSpec.replicas} node(s) provisioned and operated outside the platform (no RMQ nodes in this footprint). See the External RabbitMQ requirements below.`);
  }
  if (r.xrayEnabled && !r.externalRMQ && (r.xrayArtifacts > 100000 || r.ha)) applied.push("RabbitMQ deployed in split mode on dedicated VMs (Xray HA / >100K artifacts).");
  if (r.xrayEnabled && !r.externalRMQ) {
    const rmqRow = r.components.find(c => c.name === "RabbitMQ (Xray)");
    if (rmqRow && rmqRow.replicas >= 3) {
      applied.push(`RabbitMQ replica count rounded to odd (${rmqRow.replicas}) for quorum — tolerates ${(rmqRow.replicas - 1) / 2} simultaneous node failure(s).`);
    } else if (rmqRow && rmqRow.replicas === 1) {
      applied.push("RabbitMQ running single-node (no quorum) — acceptable only for non-HA Small deployments.");
    }
  }
  if (r.svc.jas && r.xrayEnabled) applied.push("JAS deployed on its own dedicated VM (Xray protection rule).");
  if (r.svc.missionControl) applied.push("Mission Control bundled into Artifactory (platform service on the router) — no standalone node or database.");
  if (r.svc.curation) {
    applied.push(`Curation is a runtime feature of Artifactory + Xray — no dedicated nodes. Only new infrastructure: Catalog service nodes (with a catalogdb database) and Valkey (${r.externalValkey ? "external — provisioned separately, see below" : "co-located on the Catalog nodes, +8 GB RAM, no new VMs"}).`);
  }
  if (r.svc.runtime) {
    applied.push("Runtime Security deployed as separate releases — a Runtime server (its own 'runtime' DB) plus a per-node sensor DaemonSet (no dedicated nodes). UI integration via runtime.enabled on Artifactory + Xray.");
  }
  if (!r.externalLB) {
    applied.push("JFrog bundled Nginx provides reverse proxy / TLS termination (dedicated VM/node per replica).");
  } else if (r.provisionNginx) {
    applied.push(`${r.lbDisplay} front-ends the platform; Nginx is kept behind it for advanced proxy features (dedicated VM/node per replica).`);
  } else {
    applied.push(`${r.lbDisplay} terminates TLS and routes directly to Artifactory's built-in router — dedicated Nginx tier omitted (no Nginx nodes).`);
  }
  if (r.deployment === "k8s" && r.k8sPlacement === "antiaffinity") {
    applied.push("Kubernetes <strong>podAntiAffinity</strong> on shared node pool — Artifactory replicas spread across distinct nodes, but the pool may also host other JFrog services. Node count unchanged (still 1 node per Artifactory replica due to anti-affinity).");
  } else if (r.deployment === "k8s") {
    applied.push("Kubernetes <strong>dedicated node pool</strong> for Artifactory — one pod per node, no other workloads share the pool (JFrog recommendation).");
  } else {
    applied.push("Each Artifactory replica on its own dedicated VM (VM model).");
  }
  applied.push(`Artifactory${r.provisionNginx ? ", Nginx" : ""}, Xray: dedicated VM/node per replica (no co-mingling between these services).`);
  if (isAP) {
    const scaleDesc = r.passiveScale === "hot" ? "identical replica counts for instant failover" : "1 replica per component (RabbitMQ kept at 3 for quorum), DB at full sizing for fast scale-up";
    applied.push(`<strong>Active+Passive DR topology</strong> — passive site sized as <em>${r.passiveScale === "hot" ? "Hot mirror" : "Warm minimal"}</em>: ${scaleDesc}. Use Artifactory federation / replication for data sync between sites.`);
  }
  if (isAA) {
    applied.push("<strong>Active+Active topology</strong> — two full active sites, each sized identically and both serving traffic. Use Artifactory Federated repositories (bidirectional) + Access Federation for cross-site sync, and a global LB / GSLB (geo or weighted DNS) to distribute clients. Each site has its own database, RabbitMQ and binary store; plan for replication lag and write-conflict handling.");
  }
  html += `<div style="margin-top:14px;"><div class="hint" style="margin-bottom:6px;">Applied in this configuration:</div>`;
  applied.forEach(a => { html += `<div class="notice ok" style="margin-bottom:6px;">${a}</div>`; });
  html += `</div></details>`;

  /* Storage & network */
  const sc = STORAGE_CLASS[r.cloud];
  const bs = BINARY_STORE[r.cloud];
  html += `
    <details class="panel">
      <summary style="font-size:14px;">Storage &amp; network — ${r.cloudLabel}</summary>
      <table style="margin-top:10px;">
        <tbody>
          <tr><td><strong>Service disks (block)</strong></td><td>${sc.block} — sized per-tier (Artifactory 500/1000 GB, Xray 100/200 GB, RabbitMQ 100 GB, JAS 300 GB)</td></tr>
          <tr><td><strong>Database disks</strong></td><td>${sc.premium} — Artifactory DB ≈ 1/3 of filestore; Xray DB 500–2500 GB per tier; IOPS 4K–20K</td></tr>
          <tr><td><strong>Binary / artifact backend</strong></td><td><strong>${bs.best.name}</strong> <span class="chip ok">JFrog recommended</span> — sized at <strong>${r.binaryTB} TB</strong>${isMulti ? " per site" : ""}. <span class="hint">binarystore.xml: <code>${bs.best.template}</code>. ${bs.best.note}</span><div class="hint" style="margin-top:4px;">Other options: ${bs.alternatives.map(a => `${a.name} (<code>${a.template}</code>)`).join(" · ")}.</div></td></tr>
          ${r.cacheFsGB > 0 ? `<tr><td><strong>Cache-fs (binary cache)</strong></td><td>${sc.block} — <strong>${fmtGB(r.cacheFsGB)}</strong> local SSD per Artifactory replica (${r.cacheFsPct}% of filestore); fronts ${sc.object} so hot artifacts are served at local-disk latency</td></tr>` : `<tr><td><strong>Cache-fs (binary cache)</strong></td><td>Disabled — every binary read hits ${sc.object} directly. Enable for better performance with object storage.</td></tr>`}
          <tr><td><strong>Load balancer / ingress</strong></td><td><strong>${r.lbDisplay}</strong> — ${r.externalLB ? (r.provisionNginx ? "Nginx provisioned behind the LB for advanced proxy features." : "no dedicated Nginx tier; the LB terminates TLS and routes to Artifactory's built-in router. On K8s the chart sets nginx.enabled:false and exposes the Artifactory service (LoadBalancer/NodePort or Ingress) for the LB to target.") : "bundled Nginx reverse proxy on a dedicated VM/node per replica."}${r.deployment === "k8s" ? " On K8s, expose it via the cluster ingress / cloud LB service." : ""}${isAP ? " Provide a global/cross-site LB or DNS failover to direct traffic to the active site." : ""}${isAA ? " Provide a global LB / GSLB (geo or weighted DNS) to distribute clients across both active sites." : ""} <span class="hint">Config: <a href="https://jfrog.com/help/r/jfrog-installation-setup-documentation/configure-the-reverse-proxy" target="_blank">Reverse Proxy / LB</a>${r.externalLB ? ` &middot; <a href="https://jfrog.com/help/r/jfrog-installation-setup-documentation/http-settings" target="_blank">HTTP Settings</a>` : ""}.</span></td></tr>
          <tr><td><strong>Network</strong></td><td>${NETWORK_REC[r.cloud]}</td></tr>
          ${r.deployment === "k8s" ? `<tr><td><strong>Kubernetes</strong></td><td>${K8S_NOTES[r.cloud]}</td></tr>` : ""}
        </tbody>
      </table>
    </details>
  `;

  /* Ports & connectivity */
  html += buildPortsPanel(r);

  /* Database setup — required databases, users & configuration (always external here) */
  {
    const dbs = [{ svc:"Artifactory", db:"artifactory", user:"artifactory", note:"Core platform metadata — always required." }];
    if (r.xrayEnabled) dbs.push({ svc:`Xray${r.svc.jas ? " + JAS" : ""}`, db:"xraydb", user:"xray", note:`Scan results & component graph.${r.svc.jas ? " JAS shares the Xray database — no separate DB." : ""}` });
    if (r.svc.distribution) dbs.push({ svc:"Distribution", db:"distribution", user:"distribution", note:"Release-bundle metadata." });
    if (r.svc.curation) dbs.push({ svc:"Catalog (Curation)", db:"catalogdb", user:"catalog", note:"Package-metadata catalog for Curation." });
    if (r.svc.runtime) dbs.push({ svc:"Runtime Security", db:"runtime", user:"runtime", note:"Runtime server data (separate jfrog/runtime release)." });

    const newer = [];
    if (r.svc.workers)  newer.push("Workers");
    if (r.svc.appTrust) newer.push("AppTrust + Unified Policy");

    const dbHost = { aws:"my-rds-endpoint.rds.amazonaws.com", azure:"my-flexible-server.postgres.database.azure.com", gcp:"my-cloudsql-ip", onprem:"db-host" }[r.cloud];
    const totalConns = r.dbTotalConns || (r.artiDbMaxConns + (r.xrayEnabled ? r.xrayDbMaxConns : 0));

    html += `
    <details class="panel">
      <summary style="font-size:14px;">Database setup — required databases, users &amp; configuration</summary>
      <div class="notice info" style="margin-top:10px;">
        ${r.dbMode === "external"
          ? `Create the databases below in your managed PostgreSQL (RDS / Cloud SQL / Flexible Server); JFrog connects over JDBC.`
          : `Create the databases below in your co-located PostgreSQL (the Helm chart's bundled DB on K8s, or a primary${r.ha ? " + standby for HA" : ""}).`}
        Each product gets its <strong>own logical database</strong>${(r.dbProducts || []).length > 1 ? `, all on <strong>${r.dbInstances === "dedicated" ? `${r.dbProducts.length} dedicated instances (one per product)` : "a single shared instance"}</strong>` : ""}.
      </div>
      <table>
        <thead><tr><th>Service</th><th>Database</th><th>DB user</th><th>Notes</th></tr></thead>
        <tbody>
          ${dbs.map(d => `<tr><td><strong>${d.svc}</strong></td><td><code>${d.db}</code></td><td><code>${d.user}</code></td><td><span class="hint">${d.note}</span></td></tr>`).join("")}
          ${newer.length ? `<tr><td><strong>${newer.join(", ")}</strong></td><td colspan="3"><span class="hint">Recent services may require their own database/schema in current releases — confirm the exact name in each service's install docs before provisioning.</span></td></tr>` : ""}
        </tbody>
      </table>
      <p style="margin:12px 0 4px;"><strong>Create each database</strong> (PostgreSQL — repeat per service, UTF8 encoding):</p>
      <blockquote style="white-space:pre; font-family:monospace; font-style:normal;">CREATE USER &lt;user&gt; WITH PASSWORD '&lt;password&gt;';
CREATE DATABASE &lt;db&gt; WITH OWNER=&lt;user&gt; ENCODING='UTF8';
GRANT ALL PRIVILEGES ON DATABASE &lt;db&gt; TO &lt;user&gt;;</blockquote>
      <p style="margin:12px 0 4px;"><strong>Point each product at its database</strong> in that product's <code>system.yaml</code> (Artifactory shown):</p>
      <blockquote style="white-space:pre; font-family:monospace; font-style:normal;">shared:
  database:
    type: postgresql
    driver: org.postgresql.Driver
    url: "jdbc:postgresql://${dbHost}:5432/artifactory"
    username: artifactory
    password: "&lt;password&gt;"</blockquote>
      <ul style="margin:4px 0 10px; padding-left:20px; color:var(--muted); font-size:13px; line-height:1.7;">
        <li><strong>Version:</strong> use a JFrog-supported PostgreSQL version (currently PostgreSQL 13–16 depending on release — confirm in the system requirements). UTF8 encoding is mandatory.</li>
        <li><strong>Connections:</strong> ${r.dbInstances === "dedicated" ? "size each instance for its product's connection cap" : `a shared instance needs <code>max_connections</code> ≥ <strong>${totalConns.toLocaleString()}</strong> (sum across all product databases)`} plus headroom for this tier.</li>
        <li><strong>Driver:</strong> JFrog bundles the PostgreSQL JDBC driver; for other engines (rarely supported) supply the driver JAR.</li>
        ${r.dbMode === "colocated" && r.ha ? `<li><strong>HA:</strong> run a primary + synchronous standby (or Patroni / repmgr) with automatic failover; the sizing above provisions 2 DB nodes per service.</li>` : ""}
        ${isAP ? `<li><strong>Active+Passive:</strong> run an independent database (or a cross-region read replica promoted on failover) at each site — size each site identically.</li>` : ""}
        ${isAA ? `<li><strong>Active+Active:</strong> each active site runs its own independent database (sized identically). Data sync is via Artifactory federation, not DB-level replication.</li>` : ""}
        <li><strong>TLS:</strong> enable <code>sslmode=verify-full</code> in the JDBC URL for encrypted connections to the database.</li>
      </ul>
      <div class="hint">Reference: <a href="https://jfrog.com/help/r/jfrog-installation-setup-documentation/configuring-the-database" target="_blank">JFrog — Configuring the Database (PostgreSQL)</a> &middot; <a href="https://jfrog.com/help/r/xray-tuning-and-maximizing-your-xray-s-database/xray-tuning-and-maximizing-your-xray-s-database" target="_blank">Xray — Database connection sizing &amp; tuning</a>.</div>
    </details>
  `;
  }

  /* External RabbitMQ — recommended sizing + plugins + configuration */
  if (r.xrayEnabled && r.externalRMQ) {
    const s = r.externalRmqSpec;
    html += `
    <details class="panel" open>
      <summary style="font-size:14px;">External RabbitMQ — recommended sizing, plugins &amp; configuration</summary>
      <div class="notice info" style="margin-top:10px;">
        <strong>Recommended external cluster:</strong> ${s.replicas} × <code>${s.instance}</code> (${s.cpu} vCPU / ${s.memGB} GB, ${fmtGB(s.diskGB)} disk @ ${s.iops.toLocaleString()} IOPS each)${isMulti ? " per site" : ""}. ${s.quorumNote} These nodes run on infrastructure you manage and are <strong>not</strong> counted in the platform footprint or Kubernetes cluster plan above.
      </div>
      <p style="margin:12px 0 4px;"><strong>Plugins to enable</strong> (<code>rabbitmq-plugins enable …</code>):</p>
      <table>
        <thead><tr><th>Plugin</th><th>Required?</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td><code>rabbitmq_management</code></td><td><span class="chip danger">required</span></td><td>REST API + UI (port 15672) that Xray uses to create and inspect queues.</td></tr>
          <tr><td><code>rabbitmq_management_agent</code></td><td><span class="chip warn">auto</span></td><td>Enabled automatically with the management plugin.</td></tr>
          <tr><td>Quorum queues (core)</td><td><span class="chip ${r.ha ? "danger" : "warn"}">${r.ha ? "required (HA)" : "recommended"}</span></td><td>Built into RabbitMQ core (no plugin). Xray queues must use quorum type so they survive node loss.</td></tr>
          <tr><td><code>rabbitmq_prometheus</code></td><td><span class="chip ok">recommended</span></td><td>Metrics endpoint for monitoring queue depth / consumer health.</td></tr>
        </tbody>
      </table>
      <p style="margin:12px 0 4px;"><strong>Configuration checklist</strong>:</p>
      <ul style="margin:4px 0 10px; padding-left:20px; color:var(--muted); font-size:13px; line-height:1.7;">
        <li><strong>Version:</strong> match the RabbitMQ version bundled with your JFrog release (see the Xray system requirements / release notes) — mismatched majors are unsupported.</li>
        <li><strong>vhost &amp; user:</strong> create a dedicated vhost and a user tagged <code>administrator</code> with full permissions (<code>configure / write / read = .* .* .*</code>) on that vhost.</li>
        <li><strong>Quorum:</strong> deploy an <strong>odd</strong> number of nodes (1 / 3 / 5) with an identical Erlang cookie (<code>/var/lib/rabbitmq/.erlang.cookie</code>) so quorum queues can elect a majority.</li>
        <li><strong>Ports:</strong> open <code>5672</code> (AMQP), <code>5671</code> (AMQPS/TLS), <code>15672</code> (management API) between JFrog ↔ RabbitMQ; and <code>25672</code> (inter-node) + <code>4369</code> (epmd) between RabbitMQ nodes.</li>
        <li><strong>Disable the bundled broker</strong> and point JFrog at the external cluster in <code>system.yaml</code> (field names vary by version — confirm against the JFrog "external RabbitMQ" docs):
          <blockquote style="white-space:pre; font-family:monospace; font-style:normal;">shared:
  rabbitMq:
    active: false
    url: "amqp://&lt;rmq-host&gt;:5672"
    username: "&lt;user&gt;"
    password: "&lt;password&gt;"</blockquote>
        </li>
        <li><strong>Long-running scans:</strong> raise <code>consumer_timeout</code> (e.g. ≥ 30 min) so Xray scan messages aren't dropped mid-processing.</li>
        <li><strong>TLS (optional):</strong> terminate AMQPS on <code>5671</code> with CA-signed certs for in-transit encryption.</li>
        ${isMulti ? `<li><strong>${isAA ? "Active+Active" : "Active+Passive"}:</strong> run an independent external RabbitMQ cluster at each site (Xray does not replicate RMQ across sites) — the recommended size applies per site.</li>` : ""}
      </ul>
      <div class="hint">Externalizing RabbitMQ moves the messaging capacity off the JFrog nodes but does not eliminate it — size your external cluster at least as large as the recommendation above. The same applies to an external load balancer: it runs on its own (often managed/auto-scaled) infrastructure, which is why neither appears in the node totals.</div>
      <div class="hint" style="margin-top:6px;">Reference: <a href="https://docs.jfrog.com/installation/docs/xray-and-rabbitmq-nodes-recommendations_xray-system-requirements-and-platform-support" target="_blank">JFrog — Configuring an External RabbitMQ</a>.</div>
    </details>
  `;
  }

  /* External Valkey — recommended sizing + configuration */
  if (r.svc.curation && r.externalValkey) {
    const v = r.externalValkeySpec;
    html += `
    <details class="panel" open>
      <summary style="font-size:14px;">External Valkey — recommended sizing &amp; configuration</summary>
      <div class="notice info" style="margin-top:10px;">
        <strong>Recommended external cache:</strong> ${v.replicas} × <code>${v.instance}</code> (${v.cpu} vCPU / ${v.memGB} GB, ${fmtGB(v.diskGB)} disk each)${isMulti ? " per site" : ""}. ${v.replicas >= 3 ? "Odd node count for Sentinel/cluster quorum — tolerates 1 node failure." : "Single node — no failover."} Valkey (or Redis ≥ 7) backs the Catalog service; it runs on infrastructure you manage and is <strong>not</strong> counted in the platform footprint above.
      </div>
      <p style="margin:12px 0 4px;"><strong>Configuration checklist</strong>:</p>
      <ul style="margin:4px 0 10px; padding-left:20px; color:var(--muted); font-size:13px; line-height:1.7;">
        <li><strong>Engine:</strong> Valkey (or a compatible Redis ≥ 7) — a managed option (ElastiCache / Azure Cache for Redis / Memorystore) works too. Match the version in the Catalog system requirements.</li>
        <li><strong>Memory:</strong> set <code>maxmemory</code> to ~75% of node RAM with <code>maxmemory-policy allkeys-lru</code>; the cache grows with the size of the indexed package catalog.</li>
        <li><strong>HA:</strong> deploy an <strong>odd</strong> number of nodes (3/5) with Sentinel, or use cluster mode; expose a single endpoint to Catalog.</li>
        <li><strong>Persistence:</strong> the Catalog cache is rebuildable — RDB snapshots are usually enough; enable AOF only if you want faster warm restarts.</li>
        <li><strong>Ports:</strong> <code>6379</code> (Valkey/Redis), <code>6380</code> (TLS), <code>16379</code> (cluster bus) and <code>26379</code> (Sentinel) between Catalog ↔ Valkey and between Valkey nodes.</li>
        <li><strong>Auth/TLS:</strong> set <code>requirepass</code> (or ACL users) and terminate TLS on <code>6380</code> with CA-signed certs.</li>
        ${isMulti ? `<li><strong>${isAA ? "Active+Active" : "Active+Passive"}:</strong> run an independent Valkey cluster at each site — the recommended size applies per site.</li>` : ""}
        <li><strong>Point Catalog at it</strong> in <code>system.yaml</code> (field names are version-specific — confirm against the Curation/Catalog docs):
          <blockquote style="white-space:pre; font-family:monospace; font-style:normal;">catalog:
  valkey:
    url: "redis://&lt;valkey-host&gt;:6379"
    password: "&lt;password&gt;"</blockquote>
        </li>
      </ul>
      <div class="hint">Reference: <a href="https://docs.jfrog.com/installation/docs/installing-catalog" target="_blank">JFrog Curation</a> &middot; <a href="https://valkey.io/topics/" target="_blank">Valkey operations</a>.</div>
    </details>
  `;
  }

  /* Deployment artifacts (Helm values.yaml for K8s, Ansible bundle for VMs) */
  html += buildArtifactPanel(r);

  /* Node count formula */
  const TIER_ROWS = [
    { tier:"Small",   conns:"≤ 100",   rpm:"≤ 6,000",   arti:1, nginx:1, xray:1, rmq:1  },
    { tier:"Medium",  conns:"≤ 500",   rpm:"≤ 50,000",  arti:2, nginx:2, xray:2, rmq:3  },
    { tier:"Large",   conns:"≤ 1,200", rpm:"≤ 100,000", arti:3, nginx:2, xray:2, rmq:3  },
    { tier:"XLarge",  conns:"≤ 3,000", rpm:"≤ 200,000", arti:4, nginx:2, xray:2, rmq:3  },
    { tier:"2XLarge", conns:"≤ 6,000", rpm:"≤ 500,000", arti:6, nginx:3, xray:3, rmq:3  },
  ];
  html += `
    <details>
      <summary>Node count formula — how the tier and replica counts are derived</summary>
      <p style="margin-top:10px;"><strong>Step 1 — classify each input into a tier:</strong></p>
      <ul style="margin:4px 0 10px; padding-left:20px; font-size:13px; line-height:1.8;">
        <li><strong>Concurrent Connections tier</strong>: classify the peak concurrent HTTP connections against the reference architecture thresholds.</li>
        <li><strong>RPM tier</strong>: classify the peak requests-per-minute against the reference architecture thresholds.</li>
      </ul>
      <p><strong>Step 2 — effective tier</strong> = <code>max(Concurrent Connections tier, RPM tier)</code>. The higher of the two drives the sizing, so whichever dimension is more demanding governs.</p>
      <p style="margin-top:10px;"><strong>Tier thresholds and replica counts (HA mode)</strong>:</p>
      <table style="margin-top:6px;">
        <thead>
          <tr>
            <th>Tier</th>
            <th>Concurrent Connections</th>
            <th>Requests / min (RPM)</th>
            <th>Artifactory<br><span style="font-weight:400;font-size:11px;">nodes (HA)</span></th>
            <th>Nginx<br><span style="font-weight:400;font-size:11px;">nodes (HA)</span></th>
            <th>Xray<br><span style="font-weight:400;font-size:11px;">nodes (HA)</span></th>
            <th>RabbitMQ<br><span style="font-weight:400;font-size:11px;">nodes (HA)</span></th>
          </tr>
        </thead>
        <tbody>
          ${TIER_ROWS.map(t => `
          <tr${t.tier === TIER_LABEL[r.tier] ? ' style="background:var(--accent-bg,#e8f4fb);font-weight:600;"' : ""}>
            <td>${t.tier}${t.tier === TIER_LABEL[r.tier] ? ' <span class="chip warn" style="font-size:10px;padding:1px 5px;">current</span>' : ""}</td>
            <td>${t.conns}</td>
            <td>${t.rpm}</td>
            <td>${t.arti}</td>
            <td>${t.nginx}</td>
            <td>${t.xray}</td>
            <td>${t.rmq}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <div class="notice info" style="margin-top:10px;">
        <strong>Current inputs:</strong> ${r.activeClients.toLocaleString()} concurrent connections (→ <strong>${TIER_LABEL[r.connsTier]}</strong>) &nbsp;·&nbsp; ${r.rpm.toLocaleString()} RPM (→ <strong>${TIER_LABEL[r.rpmTierKey]}</strong>)<br>
        <strong>Effective tier: ${tierName}</strong>${r.ha ? ` → <strong>${REPLICAS.artifactory[r.tier]} Artifactory node${REPLICAS.artifactory[r.tier] > 1 ? "s" : ""}</strong>` : " → <strong>1 Artifactory node</strong> (HA disabled)"}.
        ${REPLICAS.artifactory[r.tier] < 4 ? "<br>To reach <strong>4 Artifactory nodes</strong> (XLarge tier), set Concurrent Connections &gt; 1,200 or RPM &gt; 100,000." : ""}
      </div>
      <ul style="margin:10px 0 4px; padding-left:20px; font-size:13px; line-height:1.8;">
        <li>Replica counts above are for HA mode. Single-replica mode always uses 1 node per component regardless of tier.</li>
        <li>RabbitMQ is only deployed when Xray is enabled and runs on dedicated nodes for HA or &gt;100K indexed artifacts.</li>
        <li>JAS uses 1 node at every tier (always on its own dedicated node, separate from Xray).</li>
        <li>Distribution co-locates onto Artifactory nodes (+200 GB disk, no additional VMs/pods).</li>
      </ul>
    </details>
  `;

  /* Reference */
  html += `
    <details>
      <summary>How these numbers are derived</summary>
      <p><strong>Effective tier</strong> = max of two inputs: concurrent connections tier (reference architecture: ≤100 Small, ≤500 Medium, ≤1,200 Large, ≤3,000 XLarge, ≤6,000 2XLarge) and RPM tier (≤6K Small, ≤50K Medium, ≤100K Large, ≤200K XLarge, ≤500K 2XLarge).</p>
      <p><strong>Per-cloud instance types &amp; replica counts</strong> are verbatim from JFrog's <a href="https://jfrog.com/reference-architecture/self-managed/deployment/sizing/" target="_blank">reference architecture pages</a>. Replicas by tier — Artifactory 1/2/3/4/6, Nginx and Xray 1/2/2/2/3, RabbitMQ 1/3/3/3/3, JAS 1/1/1/1/1.</p>
      <p><strong>Storage sizing</strong> (disk, IOPS, throughput) is from the <a href="https://jfrog.com/reference-architecture/self-managed/deployment/sizing/storage/" target="_blank">JFrog storage specification page</a>: Artifactory 500→1000 GB, Xray 100→200 GB, RabbitMQ 100 GB, JAS 300 GB; Artifactory DB = 1/3 of filestore at 4K–20K IOPS; Xray DB 500–2500 GB at 4K–12K IOPS.</p>
      <p><strong>Co-location</strong>: Distribution is co-located onto Artifactory nodes (no extra VMs, +200 GB to Artifactory disk). Artifactory, Nginx, Xray, JAS each require a dedicated VM per replica. RabbitMQ runs split (separate VMs) for Xray HA or &gt;100K artifacts.</p>
      <p><strong>Optional services</strong> (Workers, AppTrust + UnifiedPolicy) come from the <a href="https://jfrog.com/help/r/jfrog-installation-setup-documentation/hardware-sizing-matrix" target="_blank">JFrog hardware sizing matrix</a> — Workers 4/4/50, AppTrust &amp; UnifiedPolicy each 2/1/50. <strong>Mission Control</strong> is bundled into Artifactory (a platform service on the router) — it adds no standalone node or database; selecting it only enables the UI integration (<code>artifactory.mc.enabled</code>). <strong>Runtime Security</strong> installs as separate releases (<code>jfrog/runtime</code> + <code>jfrog/runtime-sensors</code>): a Runtime server (its own <code>runtime</code> DB) plus a per-node sensor DaemonSet that adds no dedicated nodes. <strong>Workers</strong> and <strong>Runtime</strong> are not part of the <code>jfrog-platform</code> umbrella chart.</p>
      <p><strong>Onprem</strong>: JFrog does not publish a dedicated onprem sizing table, so this calculator mirrors the cloud CPU/RAM as generic VM sizes.</p>
      <p><strong>VM vs Kubernetes</strong>: capacity numbers are identical — they describe the worker-node footprint either way. On Kubernetes, per-pod <code>requests</code>/<code>limits</code> come from the JFrog Helm chart sizing presets and are typically smaller than the full VM allocation.</p>
    </details>
  `;

  document.getElementById("output").innerHTML = html;

  const artifactBtn = document.getElementById("artifactBtn");
  if (artifactBtn) artifactBtn.onclick = () => downloadArtifact(r);

  const diagramBtn = document.getElementById("diagramBtn");
  if (diagramBtn) diagramBtn.onclick = () => downloadText(`jpd-architecture-${r.cloud}-${new Date().toISOString().slice(0, 10)}.svg`, buildArchitectureDiagram(r), "image/svg+xml");
}

/* ---------- Wire up ---------- */

document.getElementById("calcBtn").addEventListener("click", calculate);
document.getElementById("exportBtn").addEventListener("click", () => downloadCsv(lastResult));
document.getElementById("inputs").addEventListener("change", calculate);
document.getElementById("inputs").addEventListener("input", (e) => {
  if (e.target.type === "number") calculate();
});

function paintRadioStates() {
  document.querySelectorAll(".radio-group").forEach(group => {
    group.querySelectorAll("label").forEach(lbl => {
      const input = lbl.querySelector('input[type="radio"]');
      lbl.classList.toggle("checked", input.checked);
    });
  });
}
document.addEventListener("change", paintRadioStates);
paintRadioStates();
toggleConditionalFields();
calculate();
