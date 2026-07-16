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
function bumpTier(tier, delta) {
  const i = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, i + delta))];
}

const VALID_ARTI_REPLICAS = [1, 2, 3, 4, 6];

function tierFromArtiReplicas(n, ha) {
  if (!ha) return "small";
  for (let i = VALID_ARTI_REPLICAS.length - 1; i >= 0; i--) {
    if (n >= VALID_ARTI_REPLICAS[i]) return TIER_ORDER[i];
  }
  return "small";
}
function snapArtiReplicas(n, ha) {
  if (!ha) return { nodes: 1, snapped: n > 1, requested: n };
  if (VALID_ARTI_REPLICAS.includes(n)) return { nodes: n, snapped: false, requested: n };
  let best = 1;
  for (const v of VALID_ARTI_REPLICAS) { if (v <= n) best = v; }
  return { nodes: best, snapped: true, requested: n };
}
function computeBaseline({ loadTier, ha, topology, passiveScale }) {
  const activeNodes = ha ? REPLICAS.artifactory[loadTier] : 1;
  let passiveNodes = 0;
  if (topology === "active-active") passiveNodes = activeNodes;
  else if (topology === "active-passive") passiveNodes = passiveScale === "warm" ? 1 : activeNodes;
  return { tier: loadTier, activeNodes, passiveNodes, totalLicenses: activeNodes + passiveNodes };
}
function allocateLicenses({ total, topology, passiveScale, licensePrimary, licenseSecondary, ha }) {
  if (topology === "single") return { primary: total, secondary: 0, splitMode: "single" };
  if (!ha) {
    const isWarm = topology === "active-passive" && passiveScale === "warm";
    if (isWarm) return { primary: Math.max(0, total - 1), secondary: Math.min(1, total), splitMode: "warm" };
    const primary = Math.ceil(total / 2);
    return { primary, secondary: total - primary, splitMode: "single-replica-multi" };
  }
  const isWarm = topology === "active-passive" && passiveScale === "warm";
  if (isWarm) return { primary: Math.max(0, total - 1), secondary: Math.min(1, total), splitMode: "warm" };
  const p = Number.isFinite(licensePrimary) ? licensePrimary : Math.ceil(total / 2);
  const s = Number.isFinite(licenseSecondary) ? licenseSecondary : (total - p);
  if (p + s === total && p >= 1 && s >= 1) {
    return { primary: p, secondary: s, splitMode: "allocated" };
  }
  const primary = Math.max(1, Math.min(total - 1, p));
  return { primary, secondary: total - primary, splitMode: "allocated" };
}
function licenseSplitContextKey(total, topology, passiveScale, ha) {
  return `${total}|${topology}|${passiveScale}|${ha}`;
}
function defaultLicenseSplit(total, topology, passiveScale) {
  if (topology === "active-passive" && passiveScale === "warm") {
    return { primary: Math.max(0, total - 1), secondary: Math.min(1, total) };
  }
  const primary = Math.ceil(total / 2);
  return { primary, secondary: total - primary };
}
function applySizingBias(allocation, bias, baseline, { topology, passiveScale }) {
  if (bias === "normal") return { ...allocation, biased: false };
  const total = allocation.primary + allocation.secondary;
  const minSecondary = baseline.passiveNodes;
  const minPrimary = baseline.activeNodes;
  const slack = Math.max(0, total - minPrimary - minSecondary);
  let primary = allocation.primary, secondary = allocation.secondary;
  if (bias === "performance") {
    primary = Math.min(total - Math.max(0, minSecondary), Math.max(primary, minPrimary + slack));
    secondary = total - primary;
  } else if (bias === "resilience") {
    const isWarm = topology === "active-passive" && passiveScale === "warm";
    if (!isWarm) {
      secondary = Math.min(total - Math.max(1, minPrimary), Math.max(secondary, minSecondary + slack));
      primary = total - secondary;
    }
  }
  return { primary, secondary, splitMode: allocation.splitMode, biased: true };
}
function compareEffectiveToBaseline(effective, baseline, { sizingBias, licenseMode }) {
  const tierDelta = TIER_ORDER.indexOf(effective.activeTier) - TIER_ORDER.indexOf(baseline.tier);
  const passiveTierDelta = effective.passiveTier
    ? TIER_ORDER.indexOf(effective.passiveTier) - TIER_ORDER.indexOf(baseline.tier) : 0;
  const activeNodeDelta = effective.activeNodes - baseline.activeNodes;
  const passiveNodeDelta = effective.passiveNodes - baseline.passiveNodes;
  return {
    sizingBias, licenseMode, tierDelta, passiveTierDelta, activeNodeDelta, passiveNodeDelta,
    isOverBaseline: tierDelta > 0 || activeNodeDelta > 0 || passiveNodeDelta > 0,
    isUnderBaseline: tierDelta < 0 || activeNodeDelta < 0 || passiveNodeDelta < 0,
    hasBiasEffect: sizingBias !== "normal"
  };
}
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
function buildPassiveFromActive(components, { topology, passiveScale, resilienceOverride }) {
  const aa = topology === "active-active";
  const useHot = passiveScale === "hot" || resilienceOverride;
  return components.map(c => {
    const copy = { ...c };
    if (aa) {
      copy.note = `Active site B — ${copy.note}`;
    } else if (!useHot) {
      if (c.name === "RabbitMQ (Xray)") copy.replicas = c.replicas >= 3 ? 3 : 1;
      else if (c.name.startsWith("PostgreSQL")) copy.replicas = c.replicas;
      else copy.replicas = 1;
      copy.note = `Warm standby — ${copy.note}`;
    } else {
      copy.note = resilienceOverride && passiveScale === "warm"
        ? `Resilience bias — full mirror — ${copy.note}`
        : `Active-Standby — ${copy.note}`;
    }
    return copy;
  });
}

// Replicas per tier per component (reference architecture, identical across clouds).
// Fallback values — overridden at runtime by sizing-data.json when served over HTTP.
let REPLICAS = {
  artifactory: { small:1, medium:2, large:3, xlarge:4, "2xlarge":6 },
  nginx:       { small:1, medium:2, large:2, xlarge:2, "2xlarge":3 },
  xray:        { small:1, medium:2, large:2, xlarge:2, "2xlarge":3 },
  rabbitmq:    { small:1, medium:3, large:3, xlarge:3, "2xlarge":3 },
  jas:         { small:1, medium:1, large:1, xlarge:1, "2xlarge":1 }
};

// JFrog-published instance types per cloud per tier per component.
// Fallback values — overridden at runtime by sizing-data.json when served over HTTP.
let REF_ARCH = {
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
// Fallback values — overridden at runtime by sizing-data.json when served over HTTP.
let STORAGE = {
  artifactory:   { small:{gb:500, iops:3000, mbps:500 },  medium:{gb:500, iops:3000, mbps:500 },  large:{gb:1000,iops:6000, mbps:1000}, xlarge:{gb:1000,iops:6000, mbps:1000}, "2xlarge":{gb:1000,iops:6000, mbps:1000} },
  xray:          { small:{gb:100, iops:3000, mbps:500 },  medium:{gb:100, iops:3000, mbps:500 },  large:{gb:200, iops:6000, mbps:1000}, xlarge:{gb:200, iops:6000, mbps:1000}, "2xlarge":{gb:200, iops:6000, mbps:1000} },
  rabbitmq:      { small:{gb:250, iops:3000, mbps:500 },  medium:{gb:250, iops:3000, mbps:500 },  large:{gb:250, iops:3000, mbps:500 }, xlarge:{gb:250, iops:3000, mbps:500 }, "2xlarge":{gb:250, iops:3000, mbps:500 } },
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
  { rule:"If running JAS on VMs, dedicated servers are required for JAS (separate from Xray). On Kubernetes, JAS runs within the Xray chart — no separate node pool needed", relation:"dedicated", components:["JAS"] },
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
   XLSX export. buildSizingXlsx(r) creates a multi-sheet workbook using SheetJS
   (window.XLSX, loaded from CDN). Sheets:
     1. Inputs          — form settings / projections
     2. Summary         — aggregate footprint + Kubernetes cluster plan
     3. Components      — per-component sizing table
     4. Databases       — DB products and instance sizing
     5. Binary Store    — JFrog-recommended filestore options
     6. Licensing       — license counts
     7. External Svcs   — (conditional) external RabbitMQ / Valkey specs
   ============================================================================= */

function buildSizingXlsx(r) {
  const XLSX = window.XLSX;
  const deployLabel = r.deployment === "k8s" ? "Kubernetes" : "Virtual Machines";
  const isAP = r.topology === "active-passive";
  const isAA = r.topology === "active-active";
  const isMulti = isAP || isAA;
  const siteA = isAA ? "Site A" : "Active";
  const siteB = isAA ? "Site B" : "Passive";

  const wb = XLSX.utils.book_new();
  const addSheet = (name, rows) =>
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);

  /* ---- Sheet 1: Inputs ---- */
  const inputs = [["Field", "Value"]];
  inputs.push(["Target environment", r.cloudLabel]);
  inputs.push(["Deployment model", deployLabel]);
  if (r.topology) inputs.push(["Topology", isAA ? "Active-Active" : isAP ? "Active-Passive" : "Single active cluster"]);
  if (isAP) inputs.push(["Passive site scale", r.passiveScale === "hot" ? "Active-Standby" : "Warm Standby"]);
  if (r.deployment === "k8s" && r.k8sPlacement) inputs.push(["Kubernetes placement", r.k8sPlacement === "antiaffinity" ? "Anti-affinity (shared pool)" : "Dedicated node pool"]);
  inputs.push(["Effective tier", String(r.tier || "").toUpperCase()]);
  inputs.push(["Peak concurrent connections (projected)", r.activeClients]);
  inputs.push(["Peak RPM (projected)", r.rpm]);
  inputs.push(["Binary storage TB (projected)", r.binaryTB]);
  inputs.push(["Planned growth headroom (%)", r.growthPct]);
  inputs.push(["Indexed artifacts — Xray (projected)", r.xrayEnabled ? r.xrayArtifacts : "No Xray"]);
  inputs.push(["Local cache-fs", r.cacheFsGB > 0 ? `${r.cacheFsPct}% of binaries (${fmtGB(r.cacheFsGB)}/node)` : "Disabled"]);
  inputs.push(["High Availability", r.ha ? "Yes" : "No"]);
  inputs.push(["Sizing bias", r.sizingBias === "performance" ? "Performance" : r.sizingBias === "resilience" ? "Resilience" : "Normal"]);
  inputs.push(["Load baseline tier", String(r.loadTier || r.baseline?.tier || "").toUpperCase()]);
  inputs.push(["Artifactory licenses purchased", r.licenseMode ? r.licensePurchased : "Auto (from load)"]);
  if (r.licenseMode && r.licenseAllocation && r.licenseAllocation.secondary > 0) {
    inputs.push(["Licenses — primary site", r.licenseAllocation.primary]);
    inputs.push(["Licenses — secondary site", r.licenseAllocation.secondary]);
  }
  inputs.push(["Load balancer", r.externalLB ? r.lbDisplay : "None"]);
  inputs.push(["NGINX tier provisioned", r.provisionNginx ? "Yes" : "No"]);
  inputs.push(["RabbitMQ", !r.xrayEnabled ? "N/A (no Xray)" : (r.externalRMQ ? "External" : "Bundled")]);
  inputs.push(["Database", r.dbMode === "external" ? "External" : "Co-located"]);
  inputs.push(["Database instances", r.dbInstances === "dedicated" ? "Dedicated (one instance per product)" : "Shared (one instance, logical DBs)"]);
  const svcList = [];
  if (r.svc.distribution) svcList.push("Distribution");
  if (r.svc.jas) svcList.push("JAS");
  if (r.svc.workers) svcList.push("Workers");
  if (r.svc.appTrust) svcList.push("AppTrust + UnifiedPolicy");
  if (r.svc.missionControl) svcList.push("Mission Control");
  if (r.svc.curation) svcList.push("Curation + Catalog");
  if (r.svc.runtime) svcList.push("Runtime Security");
  inputs.push(["Optional services", svcList.join("; ") || "None"]);
  if (r.svc.curation) inputs.push(["Valkey", r.externalValkey ? "External" : "Co-located"]);
  addSheet("Inputs", inputs);

  /* ---- Sheet 2: Summary (Aggregate Footprint + Cluster Plan) ---- */
  const totalsOf = comps => comps.reduce((t, c) => ({
    nodes: t.nodes + c.replicas,
    cpu:   t.cpu  + c.cpu   * c.replicas,
    mem:   t.mem  + c.memGB * c.replicas,
    disk:  t.disk + c.diskGB * c.replicas
  }), { nodes: 0, cpu: 0, mem: 0, disk: 0 });
  const active  = totalsOf(r.components);
  const passive = r.passiveComponents ? totalsOf(r.passiveComponents) : null;

  const summary = [
    ["Deployment Summary"],
    [],
    ["Scope", "Nodes", r.cpuLabel, "RAM (GB)", "Service Disk (GB)"]
  ];
  if (isMulti && passive) {
    summary.push([siteA + " site",   active.nodes,                   active.cpu,                   active.mem,                   active.disk]);
    summary.push([siteB + " site",   passive.nodes,                  passive.cpu,                  passive.mem,                  passive.disk]);
    summary.push(["Grand total",     active.nodes + passive.nodes,   active.cpu + passive.cpu,     active.mem + passive.mem,     active.disk + passive.disk]);
  } else {
    summary.push(["Total",           active.nodes,                   active.cpu,                   active.mem,                   active.disk]);
  }
  summary.push(["Binary / artifact storage (TB)", isMulti ? r.binaryTB * 2 : r.binaryTB, "", "", ""]);

  if (r.deployment === "k8s") {
    const externalDb = r.dbMode === "external";
    const clusterPlan = comps => {
      const workers = comps.filter(c => !(externalDb && c.name.startsWith("PostgreSQL")));
      const pools = {};
      workers.forEach(c => {
        if (!pools[c.instance]) pools[c.instance] = { cpu: c.cpu, memGB: c.memGB, count: 0, usedBy: [] };
        pools[c.instance].count += c.replicas;
        pools[c.instance].usedBy.push(c.name + (c.replicas > 1 ? ` ×${c.replicas}` : ""));
      });
      const nodes = Object.values(pools).reduce((s, p) => s + p.count, 0);
      const cpu   = Object.values(pools).reduce((s, p) => s + p.cpu   * p.count, 0);
      const mem   = Object.values(pools).reduce((s, p) => s + p.memGB * p.count, 0);
      return { pools, nodes, cpu, mem, clusterCpu: Math.ceil(cpu * 1.15), clusterMem: Math.ceil(mem * 1.15) };
    };
    const addClusterPlan = (comps, site) => {
      const p = clusterPlan(comps);
      Object.entries(p.pools).sort((a, b) => b[1].count - a[1].count)
        .forEach(([inst, info]) => summary.push([site, inst, info.cpu, info.memGB, info.count, info.usedBy.join(", ")]));
      summary.push([site + " — worker capacity",             "", p.cpu,        p.mem,        p.nodes, ""]);
      summary.push([site + " — provision (incl. ~15% sys)", "", p.clusterCpu, p.clusterMem, "",       ""]);
    };
    summary.push([], [], ["Kubernetes Cluster Plan"], [],
      ["Site", "Node Pool (VM size)", r.cpuLabel, "RAM (GB)", "Nodes", "Runs"]);
    addClusterPlan(r.components, isMulti ? siteA : "Cluster");
    if (isMulti && r.passiveComponents) addClusterPlan(r.passiveComponents, siteB);
  }
  addSheet("Summary", summary);

  /* ---- Sheet 3: Components ---- */
  const compRows = [
    ["Site", "Component", "Replicas", `${r.cpuLabel} (each)`, "RAM GB (each)", "Disk GB (each)",
     "IOPS", "Instance / VM", `Total ${r.cpuLabel}`, "Total RAM (GB)", "Total Disk (GB)", "Notes"]
  ];
  const pushComps = (comps, site) => comps.forEach(c =>
    compRows.push([site, c.name, c.replicas, c.cpu, c.memGB, c.diskGB, c.iops, c.instance,
                   c.cpu * c.replicas, c.memGB * c.replicas, c.diskGB * c.replicas, c.note]));
  pushComps(r.components, isMulti ? siteA : "—");
  if (isMulti && r.passiveComponents) pushComps(r.passiveComponents, siteB);
  addSheet("Components", compRows);

  /* ---- Sheet 4: Databases ---- */
  const dbMode = r.dbMode === "external" ? "External" : "Co-located";
  const dbRows = [["Service", "Database", "User", "Mode"]];
  dbRows.push(["Artifactory", "artifactory", "artifactory", dbMode]);
  if (r.xrayEnabled) dbRows.push([`Xray${r.svc.jas ? " + JAS" : ""}`, "xraydb", "xray", dbMode]);
  if (r.svc.distribution) dbRows.push(["Distribution", "distribution", "distribution", dbMode]);
  if (r.svc.curation)     dbRows.push(["Catalog (Curation)", "catalogdb", "catalog", dbMode]);
  if (r.svc.runtime)      dbRows.push(["Runtime Security", "runtime", "runtime", dbMode]);
  if (r.dbProducts && r.dbProducts.length) {
    dbRows.push([], ["Instance sizing"], [],
      ["Instance / VM", r.cpuLabel, "RAM (GB)", "Disk (GB)", "IOPS", "Max connections", "Serves"]);
    r.dbProducts.forEach(d =>
      dbRows.push([d.instance, d.cpu, d.memGB, d.diskGB, d.iops, d.maxConns, d.label]));
  }
  addSheet("Databases", dbRows);

  /* ---- Sheet 5: Binary Store ---- */
  const bs = BINARY_STORE[r.cloud];
  if (bs) {
    const bsRows = [["Option", "Recommended", "binarystore.xml template", "Notes"]];
    bsRows.push([bs.best.name, "Yes (best)", bs.best.template, bs.best.note]);
    bs.alternatives.forEach(a => bsRows.push([a.name, "No", a.template, a.note]));
    addSheet("Binary Store", bsRows);
  }

  /* ---- Sheet 6: Licensing ---- */
  const lic = licenseCount(r);
  const licRows = [["Field", "Value"]];
  licRows.push(["Minimum subscription tier", lic.tier]);
  if (lic.jas) licRows.push(["Add-on", "JFrog Advanced Security (JAS)"]);
  if (r.licenseMode && lic.purchased != null) licRows.push(["Licenses purchased", lic.purchased]);
  if (isMulti) {
    licRows.push([`Artifactory licenses — ${siteA}`, lic.active]);
    licRows.push([`Artifactory licenses — ${siteB}`, lic.passive]);
  }
  licRows.push(["Artifactory licenses — deployed", lic.total]);
  if (r.licenseMode && lic.unused > 0) licRows.push(["Licenses unused", lic.unused]);
  if (r.biasDelta && (r.biasDelta.isOverBaseline || r.biasDelta.isUnderBaseline)) {
    licRows.push(["vs load baseline", r.biasDelta.isOverBaseline ? "Over-allocated" : "Under-allocated"]);
  }
  if (lic.edge) licRows.push(["Distribution Edge", "Edge nodes carry separate Edge licenses"]);
  addSheet("Licensing", licRows);

  /* ---- Sheet 7: External Services (only when present) ---- */
  const extRows = [["Service", "Cluster / Nodes", "Per-node spec", "Disk"]];
  if (r.xrayEnabled && r.externalRMQ && r.externalRmqSpec) {
    const s = r.externalRmqSpec;
    extRows.push(["RabbitMQ", `${s.replicas} × ${s.instance}`, `${s.cpu} ${r.cpuLabel} / ${s.memGB} GB`, fmtGB(s.diskGB)]);
  }
  if (r.svc.curation && r.externalValkey && r.externalValkeySpec) {
    const v = r.externalValkeySpec;
    extRows.push(["Valkey", `${v.replicas} × ${v.instance}`, `${v.cpu} ${r.cpuLabel} / ${v.memGB} GB`, fmtGB(v.diskGB)]);
  }
  if (extRows.length > 1) addSheet("External Services", extRows);

  return wb;
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

function downloadXlsx(r) {
  if (!r) return;
  const XLSX = window.XLSX;
  if (!XLSX) {
    alert("SheetJS not loaded — check your internet connection and reload the page.");
    return;
  }
  const wb = buildSizingXlsx(r);
  XLSX.writeFile(wb, `jfrog-site-sizing-${r.cloud}-${r.tier}-${new Date().toISOString().slice(0, 10)}.xlsx`);
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
  const xray    = findComp(r, "Xray") || findComp(r, "Xray + JAS");
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
  p("# Generated by the JFrog Platform Site Sizing Calculator, aligned with jf-k8s/ reference values:");
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
  const xray    = findComp(r, "Xray") || findComp(r, "Xray + JAS");
  const rmq     = findComp(r, "RabbitMQ (Xray)");
  const catalog = findComp(r, "Catalog");
  const L = [];
  const group = (name, comp, n) => {
    if (!n) return;
    L.push("[" + name + "]" + (comp ? "   # " + comp.cpu + " " + r.cpuLabel + " / " + comp.memGB + " GB each" : ""));
    for (let i = 1; i <= n; i++) L.push(name + "-" + i + " ansible_host=<ip-" + i + ">");
    L.push("");
  };
  group("artifactory_servers", arti, arti ? arti.replicas : 1);
  if (r.provisionNginx && nginx) group("nginx_servers", nginx, nginx.replicas);
  if (r.xrayEnabled && xray)     group("xray_servers", xray, xray.replicas);
  if (r.xrayEnabled && !r.externalRMQ && rmq) group("rabbitmq_servers", rmq, rmq.replicas);
  if (r.svc.curation && catalog) {
    group("catalog_servers", catalog, catalog.replicas);
    if (r.externalValkey) {
      const catReplicas = r.ha ? 3 : 1;
      L.push("[valkey_servers]   # " + catReplicas + " node(s) — external Valkey (separate from Catalog)");
      for (let i = 1; i <= catReplicas; i++) L.push("valkey-" + i + " ansible_host=<ip-" + i + ">");
      L.push("");
    }
  }
  if (r.svc.runtime) group("runtime_servers", findComp(r, "Runtime (server)"), r.ha ? 2 : 1);
  if (r.dbMode === "colocated") group("postgres_servers", null, r.ha ? 2 : 1);
  L.push("[jfrog_site:children]");
  L.push("artifactory_servers");
  if (r.provisionNginx) L.push("nginx_servers");
  if (r.xrayEnabled) L.push("xray_servers");
  if (r.svc.curation) L.push("catalog_servers");
  if (r.svc.runtime) L.push("runtime_servers");
  return L.join("\n");
}

function buildAnsibleVarsFile(r) {
  const L = [];
  const dbHost = r.dbMode === "colocated"
    ? "{{ hostvars[groups['postgres_servers'][0]]['ansible_host'] }}"
    : "<db-host>";
  L.push("# group_vars/all/vars.yml — jfrog.platform collection variables.");
  L.push("# Use Ansible Vault for secrets: ansible-vault encrypt_string 'value' --name 'master_key'");
  L.push("");
  L.push('master_key: "{{ vault_master_key }}"     # openssl rand -hex 32');
  L.push('join_key:   "{{ vault_join_key }}"        # openssl rand -hex 32');
  L.push('jfrog_url: "https://<jpd-fqdn>"');
  L.push("");
  L.push("artifactory_enabled: true");
  L.push('artifactory_version: "7.x.x"             # pin to your target release');
  L.push("artifactory_ha_enabled: " + r.ha);
  L.push("artifactory_db_type: postgresql");
  L.push("artifactory_db_driver: org.postgresql.Driver");
  L.push("artifactory_db_name: artifactory");
  L.push("artifactory_db_user: artifactory");
  L.push('artifactory_db_password: "{{ vault_artifactory_db_password }}"');
  L.push('artifactory_db_url: "jdbc:postgresql://' + dbHost + ':5432/{{ artifactory_db_name }}"');
  if (r.xrayEnabled) {
    L.push("");
    L.push("xray_enabled: true");
    L.push('xray_version: "3.x.x"                  # pin to your target release');
    L.push("xray_db_type: postgresql");
    L.push("xray_db_driver: org.postgresql.Driver");
    L.push("xray_db_name: xray");
    L.push("xray_db_user: xray");
    L.push('xray_db_password: "{{ vault_xray_db_password }}"');
    L.push('xray_db_url: "postgres://' + dbHost + ':5432/{{ xray_db_name }}?sslmode=disable"');
    if (!r.externalRMQ) {
      L.push('xray_rabbitmq_url: "amqp://{{ hostvars[groups[\'rabbitmq_servers\'][0]][\'ansible_host\'] }}:5672/"');
    } else {
      L.push('xray_rabbitmq_url: "amqp://<rmq-host>:5672/"');
    }
  }
  if (r.svc.distribution) {
    L.push("");
    L.push("distribution_enabled: true");
    L.push('distribution_version: "2.x.x"');
    L.push("distribution_db_type: postgresql");
    L.push("distribution_db_driver: org.postgresql.Driver");
    L.push("distribution_db_name: distribution");
    L.push("distribution_db_user: distribution");
    L.push('distribution_db_password: "{{ vault_distribution_db_password }}"');
    L.push('distribution_db_url: "jdbc:postgresql://' + dbHost + ':5432/{{ distribution_db_name }}?sslmode=disable"');
  }
  if (r.dbMode === "colocated") {
    L.push("");
    L.push("postgres_enabled: true");
    L.push("database:");
    L.push("  artifactory:");
    L.push("    name: artifactory");
    L.push("    owner: artifactory");
    L.push("    username: artifactory");
    L.push('    password: "{{ vault_artifactory_db_password }}"');
    L.push("    enabled: true");
    if (r.xrayEnabled) {
      L.push("  xray:");
      L.push("    name: xray");
      L.push("    owner: xray");
      L.push("    username: xray");
      L.push('    password: "{{ vault_xray_db_password }}"');
      L.push("    enabled: true");
    }
    if (r.svc.distribution) {
      L.push("  distribution:");
      L.push("    name: distribution");
      L.push("    owner: distribution");
      L.push("    username: distribution");
      L.push('    password: "{{ vault_distribution_db_password }}"');
      L.push("    enabled: true");
    }
  }
  L.push("");
  L.push("ansible_python_interpreter: /usr/bin/python3");
  return L.join("\n");
}

function buildAnsiblePlaybook(r) {
  const L = [];
  L.push("# site.yml — install JFrog Platform using the jfrog.platform Ansible collection.");
  L.push("# Install deps first:");
  L.push("#   ansible-galaxy collection install jfrog.platform community.general community.postgresql");
  L.push("# Secrets go in group_vars/all/vars.yml (encrypt with Ansible Vault).");
  if (r.dbMode === "colocated") {
    L.push("");
    L.push("- name: Install PostgreSQL");
    L.push("  hosts: postgres_servers");
    L.push("  become: true");
    L.push("  collections: [community.postgresql, community.general]");
    L.push("  roles:");
    L.push("    - role: jfrog.platform.postgres");
    L.push("      when: postgres_enabled | bool");
  }
  L.push("");
  L.push("- name: Install Artifactory");
  L.push("  hosts: artifactory_servers");
  L.push("  become: true");
  L.push("  serial:");
  L.push("    - 1");
  L.push("    - 100%");
  L.push("  collections: [community.general]");
  L.push("  roles:");
  L.push("    - role: jfrog.platform.artifactory");
  if (r.provisionNginx) {
    L.push("");
    L.push("- name: Install NGINX reverse proxy");
    L.push("  hosts: nginx_servers");
    L.push("  become: true");
    L.push("  collections: [community.general]");
    L.push("  roles:");
    L.push("    - role: jfrog.platform.artifactory_nginx");
  }
  if (r.xrayEnabled) {
    L.push("");
    L.push("- name: Install Xray");
    L.push("  hosts: xray_servers");
    L.push("  become: true");
    L.push("  collections: [community.general]");
    L.push("  roles:");
    L.push("    - role: jfrog.platform.xray");
    L.push("      when: xray_enabled | bool");
  }
  if (r.svc.distribution) {
    L.push("");
    L.push("- name: Install Distribution");
    L.push("  hosts: distribution_servers");
    L.push("  become: true");
    L.push("  collections: [community.general]");
    L.push("  roles:");
    L.push("    - role: jfrog.platform.distribution");
    L.push("      when: distribution_enabled | bool");
  }
  if (r.svc.curation) {
    L.push("");
    L.push("# Curation: no dedicated role in jfrog.platform yet.");
    L.push("# Enable via Artifactory system.yaml: artifactory.curation.enabled: true");
    L.push("# Install Catalog and Valkey manually using the archive + installService.sh pattern.");
    L.push("- name: Install JFrog Catalog");
    L.push("  hosts: catalog_servers");
    L.push("  become: true");
    L.push("  vars:");
    L.push('    catalog_version: "3.x.x"');
    L.push('    install_root: /opt/jfrog/catalog');
    L.push('    valkey_host: "' + (r.externalValkey ? "<valkey-host>" : "{{ groups['catalog_servers'][0] }}") + '"');
    L.push("  tasks:");
    L.push("    - name: Download & unpack Catalog");
    L.push("      ansible.builtin.unarchive:");
    L.push('        src: "https://releases.jfrog.io/artifactory/jfrog-catalog/{{ catalog_version }}/jfrog-catalog-{{ catalog_version }}-linux.tar.gz"');
    L.push("        dest: '{{ install_root }}'");
    L.push("        remote_src: true");
    L.push("        extra_opts: [--strip-components=1]");
    L.push("    - name: Render system.yaml");
    L.push("      ansible.builtin.template:");
    L.push("        src: templates/catalog-system.yaml.j2");
    L.push("        dest: '{{ install_root }}/var/etc/system.yaml'");
    L.push("    - name: Install & start Catalog service");
    L.push("      ansible.builtin.shell: |");
    L.push("        {{ install_root }}/app/bin/installService.sh");
    L.push("        systemctl enable --now catalog");
  }
  if (r.svc.runtime) {
    L.push("");
    L.push("# Runtime Security: no dedicated role in jfrog.platform yet.");
    L.push("# Install jfrog-runtime and jfrog-runtime-sensors using the archive pattern.");
    L.push("- name: Install JFrog Runtime (server)");
    L.push("  hosts: runtime_servers");
    L.push("  become: true");
    L.push("  vars: { runtime_version: \"1.x.x\" }");
    L.push("  tasks:");
    L.push("    - name: Install jfrog-runtime; system.yaml db url = postgres://<db-host>:5432/runtime");
    L.push("      ansible.builtin.debug: { msg: 'Download archive, render system.yaml, run installService.sh' }");
    L.push("");
    L.push("- name: Install Runtime sensors (per-node agent)");
    L.push("  hosts: all");
    L.push("  become: true");
    L.push("  tasks:");
    L.push("    - name: Deploy runtime sensor on every node, registered to Runtime server :8082");
    L.push("      ansible.builtin.debug: { msg: 'Download jfrog-runtime-sensors archive, configure, run installService.sh' }");
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
      <button class="export" id="artifactBtn">⤓ Download Helm values</button>
      <div class="hint" style="margin-top:8px;">Secrets are placeholders — supply <code>masterKey</code>/<code>joinKey</code>/DB &amp; Valkey passwords via Kubernetes Secrets. Resources use burstable QoS (requests ≈ 50%, limits = full tier). Autoscaling bounds are derived from the sized replica count. Reference: <a href="https://docs.jfrog.com/installation/docs/helm-charts-for-advanced-users" target="_blank">Install JFrog Platform with Helm</a>.</div>
    </details>`;
  }
  const inv = buildAnsibleInventory(r);
  const play = buildAnsiblePlaybook(r);
  const vars = buildAnsibleVarsFile(r);
  return `
    <details class="panel">
      <summary style="font-size:14px;">Deployment artifacts — Servers / Ansible</summary>
      <p style="margin:10px 0 4px; font-size:13px; color:var(--muted);">Uses the official <a href="https://galaxy.ansible.com/ui/repo/published/jfrog/platform/" target="_blank">jfrog.platform</a> Ansible collection. Install deps: <code>ansible-galaxy collection install jfrog.platform community.general community.postgresql</code>. Set secrets in <code>group_vars/all/vars.yml</code> (Ansible Vault recommended), then run <code>ansible-playbook -i inventory.ini site.yml</code>.</p>
      <p style="margin:12px 0 4px; font-size:13px; color:var(--muted);"><strong>inventory.ini</strong> (hosts grouped by role, counts from the sizing):</p>
      <blockquote style="white-space:pre; font-family:monospace; font-style:normal; max-height:200px; overflow:auto;">${escapeHtml(inv)}</blockquote>
      <p style="margin:12px 0 4px; font-size:13px; color:var(--muted);"><strong>site.yml</strong>:</p>
      <blockquote style="white-space:pre; font-family:monospace; font-style:normal; max-height:300px; overflow:auto;">${escapeHtml(play)}</blockquote>
      <p style="margin:12px 0 4px; font-size:13px; color:var(--muted);"><strong>group_vars/all/vars.yml</strong>:</p>
      <blockquote style="white-space:pre; font-family:monospace; font-style:normal; max-height:240px; overflow:auto;">${escapeHtml(vars)}</blockquote>
      <button class="export" id="artifactBtn">⤓ Download Ansible bundle</button>
      <div class="hint" style="margin-top:8px;">Reference: <a href="https://galaxy.ansible.com/ui/repo/published/jfrog/platform/" target="_blank">jfrog.platform collection</a> &middot; <a href="https://jfrog.com/help/r/jfrog-installation-setup-documentation/installing-artifactory" target="_blank">Installing Artifactory</a>.</div>
    </details>`;
}

function downloadArtifact(r) {
  if (!r) return;
  if (r.deployment === "k8s") {
    downloadText(`jfrog-site-helm-${r.cloud}-${r.tier}-${new Date().toISOString().slice(0,10)}.yaml`, buildHelmValues(r), "application/x-yaml");
  } else {
    const bundle =
      "# ===== inventory.ini =====\n" + buildAnsibleInventory(r) +
      "\n\n# ===== site.yml =====\n" + buildAnsiblePlaybook(r) +
      "\n\n# ===== group_vars/all/vars.yml =====\n" + buildAnsibleVarsFile(r);
    downloadText(`jfrog-site-ansible-${r.cloud}-${r.tier}-${new Date().toISOString().slice(0,10)}.txt`, bundle, "text/plain");
  }
}

/* =============================================================================
   Calculator application — calculate() + render() + UI wiring.
   Single source for the calculator page (index.html). Handles both single and
   Active-Passive topologies, VM and Kubernetes. Runs the initial calculate() at
   load (this script is included at end of <body>, so the DOM is ready).
   ============================================================================= */

/* ---------- Calculator ---------- */

function buildSiteComponents(ctx) {
  const {
    tier, artiReplicas, siteNotePrefix, cloud, deployment, ha, svc, arch, cpuLabel,
    cacheFsGB, cacheFsPct, binaryTB, provisionNginx, externalLB, lbDisplay,
    xrayEnabled, xrayArtifacts, externalRMQ, externalValkey, dbMode, dbInstances
  } = ctx;
  const prefix = siteNotePrefix ? `${siteNotePrefix} — ` : "";

  function buildRow(key, displayName, opts = {}) {
    const archEntry = arch[key][tier];
    let replicas    = ha ? REPLICAS[key][tier] : 1;
    if (opts.forceReplicas != null) replicas = opts.forceReplicas;
    const storage   = opts.storage || STORAGE[key][tier];
    return {
      name: displayName, replicas, instance: archEntry.instance,
      cpu: archEntry.cpu, memGB: archEntry.memGB,
      diskGB: storage.gb, iops: storage.iops, mbps: storage.mbps,
      note: (opts.note || "") ? prefix + opts.note : prefix.slice(0, -3)
    };
  }

  const components = [];
  let artiDisk = STORAGE.artifactory[tier].gb;
  let artiNote = "Each replica on its own VM (JFrog dedicated-instance rule).";
  let artiExtraCpu = 0, artiExtraMem = 0;

  if (svc.distribution) {
    if (deployment === "k8s") artiNote += " Distribution runs as a separate pod — see Distribution row.";
    else {
      artiDisk += 200; artiExtraCpu += 2; artiExtraMem += 2;
      artiNote += ` Distribution co-located (+2 ${cpuLabel} / +2 GB / +200 GB — no separate VMs).`;
    }
  }
  if (cacheFsGB > 0) {
    artiDisk += cacheFsGB;
    artiNote += ` Cache-fs +${cacheFsGB} GB local SSD (${cacheFsPct}% of binaries) fronting the object store.`;
  }
  if (svc.appTrust) {
    if (deployment === "k8s") artiNote += " AppTrust + UnifiedPolicy run as separate pods on this node pool (see pool total).";
    else {
      artiExtraCpu = 4; artiExtraMem = 2; artiDisk += 100;
      artiNote += ` AppTrust + UnifiedPolicy co-locate on this host (+4 ${cpuLabel} / +2 GB / +100 GB included in node sizing — no separate VMs).`;
    }
  }
  const artiComp = buildRow("artifactory", "Artifactory", {
    forceReplicas: artiReplicas,
    storage: { gb: artiDisk, iops: STORAGE.artifactory[tier].iops, mbps: STORAGE.artifactory[tier].mbps },
    note: artiNote
  });
  if (artiExtraCpu > 0) { artiComp.cpu += artiExtraCpu; artiComp.memGB += artiExtraMem; }
  components.push(artiComp);

  if (provisionNginx) {
    components.push(buildRow("nginx", "Nginx (reverse proxy / TLS)", {
      storage: { gb: 50, iops: 3000, mbps: 200 },
      note: externalLB
        ? `Dedicated VM per replica, sitting behind the ${lbDisplay}.`
        : "Dedicated VM per replica (JFrog rule). Acts as the reverse proxy / TLS terminator."
    }));
  }

  let externalRmqSpec = null;
  if (xrayEnabled) {
    let xrayName = "Xray", xrayExtraCpu = 0, xrayExtraMemGB = 0, xrayExtraDiskGB = 0;
    let xrayNote = "Dedicated VM per replica. Index time scales with artifact count.";
    if (svc.jas && deployment === "k8s") {
      const jasCpu = xrayArtifacts <= 100000 ? 6 : 8, jasMemGB = 24, jasDiskGB = xrayArtifacts <= 100000 ? 500 : 300;
      xrayExtraCpu = jasCpu; xrayExtraMemGB = jasMemGB; xrayExtraDiskGB = jasDiskGB;
      xrayName = "Xray + JAS";
      xrayNote = `JAS runs inside the Xray pod (extraSystemYaml.jas.enabled: true) — no separate JAS node pool on K8s. JAS overhead per replica: +${jasCpu} ${cpuLabel} / +${jasMemGB} GB RAM / +${jasDiskGB} GB disk. Ephemeral scanner jobs (exposuresscannersjob etc.) need additional node headroom — see Notes &amp; warnings.`;
    }
    const xrayBaseArch = arch.xray[tier], xrayBaseStor = STORAGE.xray[tier];
    const xrayRow = buildRow("xray", xrayName, {
      storage: { gb: xrayBaseStor.gb + xrayExtraDiskGB, iops: xrayBaseStor.iops, mbps: xrayBaseStor.mbps },
      note: xrayNote
    });
    if (xrayExtraCpu > 0) { xrayRow.cpu = xrayBaseArch.cpu + xrayExtraCpu; xrayRow.memGB = xrayBaseArch.memGB + xrayExtraMemGB; }
    components.push(xrayRow);
    const oddify = n => (n <= 1 ? n : (n % 2 === 0 ? n + 1 : n));
    const rmqBase = ha ? REPLICAS.rabbitmq[tier] : (xrayArtifacts > 100000 ? 3 : 1);
    const rmqReplicas = oddify(rmqBase);
    const rmqArch = arch.rabbitmq[tier], rmqStor = STORAGE.rabbitmq[tier];
    const quorumNote = rmqReplicas >= 3
      ? `Odd node count (${rmqReplicas}) enforced for quorum — tolerates ${(rmqReplicas - 1) / 2} node failure${(rmqReplicas - 1) / 2 === 1 ? "" : "s"}.`
      : "Single-node mode — no quorum / no failure tolerance.";
    if (externalRMQ) {
      externalRmqSpec = { replicas: rmqReplicas, instance: rmqArch.instance, cpu: rmqArch.cpu, memGB: rmqArch.memGB,
        diskGB: rmqStor.gb, iops: rmqStor.iops, mbps: rmqStor.mbps, quorumNote };
    } else {
      const splitNote = xrayArtifacts > 100000 || ha
        ? "Split mode — RabbitMQ on separate VMs from Xray (JFrog HA rule)."
        : "Co-located permitted at ≤100K artifacts (still split here for safety).";
      components.push(buildRow("rabbitmq", "RabbitMQ (Xray)", {
        forceReplicas: rmqReplicas, note: `${splitNote} ${quorumNote}`
      }));
    }
  }

  if (svc.jas && xrayEnabled && deployment === "vm") {
    let jasNodes, jasCpu, jasMemGB, jasDiskGB;
    if (xrayArtifacts <= 100000) { jasNodes = 1; jasCpu = 6; jasMemGB = 24; jasDiskGB = 500; }
    else if (xrayArtifacts <= 1000000) { jasNodes = 2; jasCpu = 8; jasMemGB = 24; jasDiskGB = 300; }
    else if (xrayArtifacts <= 2000000) { jasNodes = 4; jasCpu = 8; jasMemGB = 24; jasDiskGB = 300; }
    else { jasNodes = 8; jasCpu = 8; jasMemGB = 24; jasDiskGB = 300; }
    components.push({
      name: "JAS (Advanced Security)", replicas: jasNodes, instance: arch.jas[tier].instance,
      cpu: jasCpu, memGB: jasMemGB, diskGB: jasDiskGB, iops: 3000, mbps: 500,
      note: prefix + `JFrog JAS prerequisites: ${jasNodes} dedicated server${jasNodes > 1 ? "s" : ""} for ${xrayArtifacts.toLocaleString()} indexed artifacts (${jasCpu} ${cpuLabel} / ${jasMemGB} GB RAM / ${jasDiskGB} GB SSD @ 3K IOPS). JAS modules run alongside Xray but on dedicated hosts.`
    });
  }

  if (svc.workers) {
    components.push({
      name: "Workers", replicas: ha ? 2 : 1, instance: arch.nginx[tier].instance,
      cpu: 4, memGB: 4, diskGB: 50, iops: 3000, mbps: 200,
      note: prefix + "Hardware sizing matrix: 4 CPU / 4 GB / 50 GB. Requires Artifactory ≥ 7.98.4."
    });
  }
  if (svc.appTrust && deployment === "k8s") {
    const atReplicas = ha ? 2 : 1;
    components.push({
      name: "AppTrust", replicas: atReplicas, instance: arch.artifactory[tier].instance,
      cpu: 1, memGB: 2, diskGB: 0, iops: 0, mbps: 0,
      note: prefix + `Separate pod on the Artifactory node pool — no dedicated pool. Pod limits: 1 ${cpuLabel} / 2 GB.`
    });
    components.push({
      name: "UnifiedPolicy", replicas: atReplicas, instance: arch.artifactory[tier].instance,
      cpu: 1, memGB: 1, diskGB: 0, iops: 0, mbps: 0,
      note: prefix + `Separate pod on the Artifactory node pool — no dedicated pool. Pod limits: 0.5 ${cpuLabel} / 1 GB.`
    });
  }
  if (svc.distribution && deployment === "k8s") {
    const distReplicas = ha ? 2 : 1, distDisk = ha ? 20 : 5;
    components.push({
      name: "Distribution", replicas: distReplicas, instance: arch.nginx[tier].instance,
      cpu: 1, memGB: 2, diskGB: distDisk, iops: 3000, mbps: 200,
      note: prefix + `Separate StatefulSet pod — own PVC (${distDisk} GB per replica). Pod limits: 1 ${cpuLabel} / 2 GB.`
    });
  }

  let externalValkeySpec = null;
  if (svc.curation) {
    const proxyVM = arch.nginx[tier].instance;
    let catalogMem = 16;
    let catalogNote = "Catalog service — metadata store for Curation. Curation itself runs as a feature inside the existing Artifactory + Xray pods (no additional VMs/pods).";
    if (!externalValkey) { catalogMem += 8; catalogNote += " Valkey co-located on the Catalog nodes (+8 GB RAM, no new VMs)."; }
    components.push({
      name: "Catalog", replicas: ha ? 2 : 1, instance: proxyVM,
      cpu: 8, memGB: catalogMem, diskGB: 100, iops: 3000, mbps: 500,
      note: prefix + catalogNote
    });
    if (externalValkey) {
      externalValkeySpec = { replicas: ha ? 3 : 1, instance: proxyVM, cpu: 2, memGB: 8, diskGB: 20, iops: 3000, mbps: 200 };
    }
  }

  if (svc.runtime) {
    components.push({
      name: "Runtime (server)", replicas: ha ? 2 : 1, instance: arch.nginx[tier].instance,
      cpu: 2, memGB: 4, diskGB: 50, iops: 3000, mbps: 200,
      note: prefix + "JFrog Runtime server (separate jfrog/runtime release). Uses its own 'runtime' database. Sensors run as a per-node DaemonSet (no dedicated nodes)."
    });
  }

  const dbProducts = [];
  {
    const adb = arch.artifactoryDb[tier], adbStor = STORAGE.artifactoryDb[tier];
    dbProducts.push({ label:"Artifactory", db:"artifactory", user:"artifactory", cpu:adb.cpu, memGB:adb.memGB,
      instance:adb.instance, maxConns:adb.maxConns, diskGB:Math.max(100, Math.round(binaryTB*1024*adbStor.frac)), iops:adbStor.iops, mbps:adbStor.mbps });
    if (xrayEnabled) {
      const xdb = arch.xrayDb[tier], xdbStor = STORAGE.xrayDb[tier];
      dbProducts.push({ label:"Xray", db:"xraydb", user:"xray", cpu:xdb.cpu, memGB:xdb.memGB, instance:xdb.instance, maxConns:xdb.maxConns, diskGB:xdbStor.gb, iops:xdbStor.iops, mbps:xdbStor.mbps });
    }
    const sdb = arch.xrayDb.small;
    if (svc.distribution) dbProducts.push({ label:"Distribution", db:"distribution", user:"distribution", cpu:sdb.cpu, memGB:sdb.memGB, instance:sdb.instance, maxConns:sdb.maxConns, diskGB:100, iops:4000, mbps:500 });
    if (svc.curation)     dbProducts.push({ label:"Catalog", db:"catalogdb", user:"catalog", cpu:sdb.cpu, memGB:sdb.memGB, instance:sdb.instance, maxConns:sdb.maxConns, diskGB:200, iops:4000, mbps:500 });
    if (svc.runtime)      dbProducts.push({ label:"Runtime", db:"runtime", user:"runtime", cpu:sdb.cpu, memGB:sdb.memGB, instance:sdb.instance, maxConns:sdb.maxConns, diskGB:50, iops:4000, mbps:500 });
  }
  const dbReplicas = dbMode === "colocated" && ha ? 2 : 1;
  const dbTotalConns = dbProducts.reduce((s, d) => s + d.maxConns, 0);
  if (dbInstances === "dedicated" && dbProducts.length > 1) {
    dbProducts.forEach(d => components.push({
      name: `PostgreSQL (${d.label} DB)`, replicas: dbReplicas,
      instance: dbMode === "external" ? d.instance : `Co-located ${d.cpu} ${cpuLabel} / ${d.memGB} GB`,
      cpu: d.cpu, memGB: d.memGB, diskGB: d.diskGB, iops: d.iops, mbps: d.mbps,
      note: prefix + `${dbMode === "external" ? `External managed RDBMS (max ${d.maxConns} conns)` : "Co-located"} — dedicated instance for the ${d.label} database (${d.db}).${dbReplicas > 1 ? " Primary+standby for HA." : ""}`
    }));
  } else {
    const big = dbProducts[0];
    const sumDisk = dbProducts.reduce((s, d) => s + d.diskGB, 0);
    components.push({
      name: "PostgreSQL (shared)", replicas: dbReplicas,
      instance: dbMode === "external" ? big.instance : `Co-located ${big.cpu} ${cpuLabel} / ${big.memGB} GB`,
      cpu: big.cpu, memGB: big.memGB, diskGB: sumDisk, iops: big.iops, mbps: big.mbps,
      note: prefix + `${dbMode === "external" ? "External managed RDBMS" : "Co-located"} — single instance hosting ${dbProducts.length} database${dbProducts.length === 1 ? "" : "s"} (${dbProducts.map(d => d.db).join(", ")}). Sized to the dominant (Artifactory) DB; set max_connections ≥ ${dbTotalConns}.${dbReplicas > 1 ? " Primary+standby for HA." : ""}`
    });
  }

  return {
    components, dbProducts, externalRmqSpec, externalValkeySpec,
    artiDbMaxConns: arch.artifactoryDb[tier].maxConns,
    xrayDbMaxConns: arch.xrayDb[tier].maxConns,
    dbTotalConns
  };
}

let lastLicenseSplitKey = "";

function syncLicenseSplitFields(total, topology, passiveScale, ha, force) {
  const primaryEl = document.getElementById("licensePrimary");
  const secondaryEl = document.getElementById("licenseSecondary");
  if (!primaryEl || !secondaryEl || !total || total < 1) return;
  const key = `${total}|${topology}|${passiveScale}|${ha}`;
  if (!force && key === lastLicenseSplitKey) return;
  const split = defaultLicenseSplit(total, topology, passiveScale);
  primaryEl.value = split.primary;
  secondaryEl.value = split.secondary;
  lastLicenseSplitKey = key;
}

function toggleConditionalFields() {
  const deployment = document.querySelector('input[name="deployment"]:checked').value;
  const topology   = document.querySelector('input[name="topology"]:checked').value;
  document.getElementById("k8sPlacementField").style.display = deployment === "k8s" ? "" : "none";
  document.getElementById("infraTypeField").style.display = deployment === "vm" ? "" : "none";
  document.getElementById("passiveScaleField").style.display = topology === "active-passive" ? "" : "none";

  const licenseRaw = document.getElementById("licensePurchased").value.trim();
  const licensePurchased = licenseRaw !== "" ? parseInt(licenseRaw, 10) : 0;
  const licenseMode = licensePurchased > 0;
  const ha = document.querySelector('input[name="ha"]:checked').value === "yes";
  const isMulti = topology !== "single";
  const isWarm = topology === "active-passive" && document.querySelector('input[name="passiveScale"]:checked')?.value === "warm";
  const showAllocation = licenseMode && ha && isMulti && !isWarm;

  document.getElementById("licenseAllocationField").style.display = showAllocation ? "" : "none";
  document.getElementById("licenseWarmHint").style.display = licenseMode && isWarm ? "" : "none";

  const usingLB = document.querySelector('input[name="lb"]:checked').value === "external";
  const nginxSkip = document.getElementById("nginxSkipRadio");
  if (nginxSkip) {
    nginxSkip.disabled = !usingLB;
    if (!usingLB) document.querySelector('input[name="nginx_rp"][value="provision"]').checked = true;
  }
  document.getElementById("valkeyField").style.display = document.getElementById("svcCuration").checked ? "" : "none";
  // Xray artifacts dropdown — only when Xray is enabled.
  const xrayEnabledCb = document.getElementById("xrayEnabled");
  if (xrayEnabledCb) {
    document.getElementById("xrayArtifactsField").style.display = xrayEnabledCb.checked ? "" : "none";
  }
  // Cache-fs: no toggle — always enabled when cacheFsPct > 0.
  // RabbitMQ is always Helm-deployed on K8s — hide the external toggle for K8s deployments.
  const rmqField = document.getElementById("rmqField");
  if (rmqField) {
    rmqField.style.display = deployment === "k8s" ? "none" : "";
    if (deployment === "k8s") {
      const bundledRadio = document.querySelector('input[name="rmq"][value="bundled"]');
      if (bundledRadio) bundledRadio.checked = true;
    }
  }

  const isVm = deployment === "vm";

  // Valkey: Servers always use external Valkey; K8s bundles it in the Helm chart
  // ("Helm deployed") or externalises it. Relabel the co-located option accordingly.
  const valkeyColocatedOption = document.getElementById("valkeyColocatedOption");
  if (valkeyColocatedOption) {
    if (isVm) {
      valkeyColocatedOption.style.display = "none";
      document.querySelector('input[name="valkey"][value="external"]').checked = true;
    } else {
      valkeyColocatedOption.style.display = "";
      document.getElementById("valkeyColocatedText").textContent = "Helm deployed";
    }
  }

  paintRadioStates();
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

  const licenseRawEarly = document.getElementById("licensePurchased").value.trim();
  const licensePurchasedEarly = licenseRawEarly !== "" ? parseInt(licenseRawEarly, 10) : 0;
  const isMultiEarly = topology === "active-passive" || topology === "active-active";
  const isWarmEarly = topology === "active-passive" && passiveScale === "warm";
  const showAllocationEarly = licensePurchasedEarly > 0 && ha && isMultiEarly && !isWarmEarly;
  const splitKeyEarly = licenseSplitContextKey(licensePurchasedEarly, topology, passiveScale, ha);
  if (showAllocationEarly && splitKeyEarly !== lastLicenseSplitKey) {
    syncLicenseSplitFields(licensePurchasedEarly, topology, passiveScale, ha, true);
  }

  const growthPct     = Math.max(0, parseFloat(document.getElementById("growthPct").value) || 0);
  const growthFactor  = 1 + growthPct / 100;

  // Raw inputs describe today's load. Sizing plans for the future, so the demand
  // drivers are scaled by the growth factor and the deployment is sized for the
  // projected state. Base values are kept for "today → projected" display.
  const activeClientsInput = parseInt(document.getElementById("activeClients").value, 10) || 0;
  const rpmInput           = parseInt(document.getElementById("rpm").value, 10) || 0;
  const binaryTBInput      = parseFloat(document.getElementById("binaryStorageTB").value) || 0;
  const xrayChecked        = document.getElementById("xrayEnabled").checked;
  const xrayArtifactsInput = xrayChecked ? (parseInt(document.getElementById("xrayArtifacts").value, 10) || 0) : 0;

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
  // store. Enabled when cacheFsPct > 0 (set to 0 to disable).
  const cacheFs    = true; // kept for result-object compat; disable by setting cacheFsPct to 0
  const cacheFsPct = Math.max(0, parseFloat(document.getElementById("cacheFsPct").value) || 0);
  const cacheFsGB  = Math.round(binaryTB * 1024 * cacheFsPct / 100);

  // Load balancer and NGINX are independent: an external LB is optional, and NGINX
  // can be provisioned with or without one. NGINX is required when there is no LB.
  const lb         = document.querySelector('input[name="lb"]:checked').value; // none | external
  const nginxRp    = document.querySelector('input[name="nginx_rp"]:checked').value; // provision | skip
  const externalLB = lb === "external";
  const provisionNginx = nginxRp === "provision";

  // RabbitMQ (Xray messaging). External removes the RMQ nodes from this footprint;
  // the recommended external spec + plugin/config requirements are surfaced separately.
  const externalRMQ  = document.querySelector('input[name="rmq"]:checked').value === "external";
  const sizingBias   = document.querySelector('input[name="sizingBias"]:checked')?.value || "normal";
  const licenseRaw   = document.getElementById("licensePurchased").value.trim();
  const licensePurchased = licenseRaw !== "" ? parseInt(licenseRaw, 10) : 0;
  const licenseMode  = licensePurchased > 0;
  const licensePrimaryInput = parseInt(document.getElementById("licensePrimary").value, 10);
  const licenseSecondaryInput = parseInt(document.getElementById("licenseSecondary").value, 10);

  const connsTier  = tierFromConns(activeClients);
  const rpmTierKey = tierFromRpm(rpm);
  const loadTier   = maxTier(connsTier, rpmTierKey);
  const arch       = REF_ARCH[cloud];
  const cloudLabel = { aws:"AWS", azure:"Azure", gcp:"GCP", onprem:"Private Datacenter" }[cloud];

  const lbDisplay = !externalLB
    ? "JFrog NGINX (bundled reverse proxy)"
    : { aws:"AWS ALB/NLB", azure:"Azure LB / Application Gateway", gcp:"Google Cloud Load Balancing", onprem:"External / hardware LB" }[cloud];

  const xrayEnabled = xrayChecked;

  const infraType  = document.querySelector('input[name="infra_type"]:checked')?.value || "vm";
  const cpuLabel   = infraType === "baremetal" ? "cores" : "vCPU";
  const nodeLabel  = deployment === "k8s" ? "replica" : "node";
  const nodesLabel = deployment === "k8s" ? "replicas" : "nodes";
  const isMulti    = topology === "active-passive" || topology === "active-active";

  const baseline = computeBaseline({ loadTier, ha, topology, passiveScale });
  const siteCtxBase = {
    cloud, deployment, ha, svc, arch, cpuLabel, cacheFsGB, cacheFsPct, binaryTB,
    provisionNginx, externalLB, lbDisplay, xrayEnabled, xrayArtifacts, externalRMQ,
    externalValkey, dbMode, dbInstances
  };

  let tier, tierMeta, components, dbProducts, externalRmqSpec, externalValkeySpec;
  let artiDbMaxConns, xrayDbMaxConns, dbTotalConns;
  let passiveComponents = null, passiveTotals = null;
  let licenseAllocation = null, licenseSnapWarnings = [];
  let effectiveActiveNodes = 0, effectivePassiveNodes = 0, passiveTier = null;
  let resilienceOverride = false;

  if (!licenseMode) {
    tier = sizingBias === "performance" ? bumpTier(loadTier, 1) : loadTier;
    tierMeta = TIER_RPM[tier];
    const activeArti = ha ? REPLICAS.artifactory[tier] : 1;
    const activeSite = buildSiteComponents({ ...siteCtxBase, tier, artiReplicas: activeArti });
    components = activeSite.components;
    dbProducts = activeSite.dbProducts;
    externalRmqSpec = activeSite.externalRmqSpec;
    externalValkeySpec = activeSite.externalValkeySpec;
    artiDbMaxConns = activeSite.artiDbMaxConns;
    xrayDbMaxConns = activeSite.xrayDbMaxConns;
    dbTotalConns = activeSite.dbTotalConns;
    effectiveActiveNodes = activeArti;

    if (isMulti) {
      resilienceOverride = sizingBias === "resilience" && topology === "active-passive" && passiveScale === "warm";
      passiveComponents = buildPassiveFromActive(components, { topology, passiveScale, resilienceOverride });
      passiveTotals = totalsOf(passiveComponents);
      const passArti = passiveComponents.find(c => c.name === "Artifactory");
      effectivePassiveNodes = passArti ? passArti.replicas : 0;
      if (passiveComponents.length && topology === "active-active") {
        passiveTier = tier;
      } else if (passArti) {
        passiveTier = tierFromArtiReplicas(passArti.replicas, ha);
      }
    }
  } else {
    let alloc = allocateLicenses({
      total: licensePurchased, topology, passiveScale, ha,
      licensePrimary: licensePrimaryInput,
      licenseSecondary: licenseSecondaryInput
    });
    if (sizingBias !== "normal") {
      alloc = applySizingBias(alloc, sizingBias, baseline, { topology, passiveScale });
    } else {
      alloc = { ...alloc, biased: false };
    }
    licenseAllocation = alloc;

    const snapPrimary = snapArtiReplicas(alloc.primary, ha);
    const snapSecondary = snapArtiReplicas(alloc.secondary, ha);
    if (snapPrimary.snapped) licenseSnapWarnings.push(`Primary site: ${snapPrimary.requested} licenses snapped to ${snapPrimary.nodes} nodes (published HA counts: 1/2/3/4/6).`);
    if (snapSecondary.snapped && alloc.secondary > 0) licenseSnapWarnings.push(`Secondary site: ${snapSecondary.requested} licenses snapped to ${snapSecondary.nodes} nodes.`);

    tier = tierFromArtiReplicas(snapPrimary.nodes, ha);
    tierMeta = TIER_RPM[tier];
    effectiveActiveNodes = ha ? snapPrimary.nodes : 1;
    effectivePassiveNodes = alloc.secondary > 0 ? (ha ? snapSecondary.nodes : 1) : 0;

    const activeSite = buildSiteComponents({ ...siteCtxBase, tier, artiReplicas: effectiveActiveNodes });
    components = activeSite.components;
    dbProducts = activeSite.dbProducts;
    externalRmqSpec = activeSite.externalRmqSpec;
    externalValkeySpec = activeSite.externalValkeySpec;
    artiDbMaxConns = activeSite.artiDbMaxConns;
    xrayDbMaxConns = activeSite.xrayDbMaxConns;
    dbTotalConns = activeSite.dbTotalConns;

    if (isMulti && alloc.secondary > 0) {
      passiveTier = tierFromArtiReplicas(effectivePassiveNodes, ha);
      const passiveSite = buildSiteComponents({
        ...siteCtxBase, tier: passiveTier, artiReplicas: effectivePassiveNodes,
        siteNotePrefix: topology === "active-active" ? "Active site B" : (passiveScale === "warm" ? "Warm standby" : "Active-Standby")
      });
      passiveComponents = passiveSite.components;
      passiveTotals = totalsOf(passiveComponents);
    }
  }

  const activeTotals = totalsOf(components);
  const biasDelta = compareEffectiveToBaseline(
    { activeTier: tier, passiveTier, activeNodes: effectiveActiveNodes, passiveNodes: effectivePassiveNodes },
    baseline,
    { sizingBias, licenseMode }
  );

  const binaryStorageTarget = STORAGE_CLASS[cloud].object;

  render({
    cloud, cloudLabel, deployment, ha, dbMode, dbInstances, k8sPlacement, topology, passiveScale,
    tier, tierMeta, connsTier, rpmTierKey, loadTier, baseline,
    activeClients, rpm, binaryTB,
    growthPct, activeClientsInput, rpmInput, binaryTBInput, xrayArtifactsInput,
    cacheFs, cacheFsPct, cacheFsGB,
    lbDisplay, externalLB, provisionNginx,
    externalRMQ, externalRmqSpec,
    valkeyMode, externalValkey, externalValkeySpec,
    artiDbMaxConns, xrayDbMaxConns, dbProducts, dbTotalConns,
    xrayArtifacts, xrayEnabled, svc,
    components, activeTotals,
    passiveComponents, passiveTotals, passiveTier,
    binaryStorageTarget,
    infraType, cpuLabel, nodeLabel, nodesLabel,
    sizingBias, licenseMode, licensePurchased, licenseAllocation,
    biasDelta, licenseSnapWarnings, resilienceOverride
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
    if (r.topology === "active-passive") notes.push("Active-Passive: also allow cross-site replication — the active Artifactory reaches the passive over <code>443/8082</code> (federation/replication), plus your chosen DB replication path.");
    if (r.topology === "active-active") notes.push("Active-Active: allow <strong>bidirectional</strong> cross-site traffic between both sites' Artifactory over <code>443/8082</code> (Federated repositories + Access Federation), and front both sites with a global LB / GSLB.");
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
    if (r.topology === "active-passive") notes.push("Active-Passive: open cross-cluster ingress on <code>443</code> between sites for federation/replication.");
    if (r.topology === "active-active") notes.push("Active-Active: open <strong>bidirectional</strong> cross-cluster ingress on <code>443</code> between both sites (federation), and use a global LB / GSLB across both clusters' ingresses.");
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
  if (r.topology === "active-passive") add("Active-Passive — multi-site &amp; Federation", "Enterprise+", "Multi-site, Federated repositories and Access Federation are Enterprise+.");
  if (r.topology === "active-active")  add("Active-Active — multi-site &amp; bidirectional Federation", "Enterprise+", "Two active sites, Federated repositories + Access Federation — Enterprise+.");
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
  const total = active + passive;
  const purchased = r.licenseMode ? r.licensePurchased : null;
  const unused = purchased != null ? Math.max(0, purchased - total) : 0;
  return {
    tier:    licenseEffectiveTier(r),
    active, passive, total,
    purchased, unused,
    jas:     !!r.svc.jas,
    edge:    !!r.svc.distribution
  };
}

/* =============================================================================
   Deployment architecture diagram — a self-contained, dynamically generated SVG
   (no dependencies, renders over file://). Reacts to cloud, deployment model,
   topology, HA, and the selected products. Schematic: Region → VPC/VNet →
   public/private subnets across AZs → component boxes → in-region managed
   services, with a cross-region replication arrow for Active-Passive.
   ============================================================================= */
const DIAGRAM_REGIONS = {
  aws:    { vpc:"VPC", az:"Availability Zones", k8s:"EKS", db:"RDS for PostgreSQL", obj:"Amazon S3", active:"Primary Region", passive:"DR Region", lb:"ALB / NLB" },
  azure:  { vpc:"VNet", az:"Availability Zones", k8s:"AKS", db:"Azure DB for PostgreSQL", obj:"Azure Blob Storage", active:"Primary Region", passive:"DR Region", lb:"Application Gateway" },
  gcp:    { vpc:"VPC network", az:"zones", k8s:"GKE", db:"Cloud SQL", obj:"Cloud Storage", active:"Primary Region", passive:"DR Region", lb:"Cloud Load Balancing" },
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
    c.push(T(innerX, y, REG.vpc, { fill: C.muted, size: 11, weight: 600 })); y += 18;
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
  const r2label = isAA ? "Active B" : `Passive · ${r.passiveScale === "hot" ? "Active-Standby" : "Warm Standby"}`;
  const r2 = regionSvg(x2, `${r.cloudLabel} · ${REG.passive} (${r2label})`, r.passiveComponents || r.components);
  const H = Math.max(r1.h, r2.h) + pad, W = x2 + regW + pad;
  const midY = Math.round(H / 2), ax1 = pad + regW, ax2 = x2;
  // Active-Active = bidirectional federation arrow; Active-Passive = one-way replication.
  const arrow = `<defs><marker id="jpd-ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="${C.accent}"/></marker><marker id="jpd-ah2" markerWidth="9" markerHeight="9" refX="2" refY="3" orient="auto"><path d="M7,0 L0,3 L7,6 Z" fill="${C.accent}"/></marker></defs>`
    + `<line x1="${ax1 + 6}" y1="${midY}" x2="${ax2 - 6}" y2="${midY}" stroke="${C.accent}" stroke-width="1.5" marker-end="url(#jpd-ah)"${isAA ? ` marker-start="url(#jpd-ah2)"` : ""}/>`
    + T((ax1 + ax2) / 2, midY - 8, "Federation /", { fill: C.muted, size: 10, anchor: "middle" })
    + T((ax1 + ax2) / 2, midY + 14, isAA ? "(bidirectional)" : "replication", { fill: C.muted, size: 10, anchor: "middle" });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;height:auto;background:#0f1115;border-radius:8px;" xmlns="http://www.w3.org/2000/svg">${arrow}${r1.svg}${r2.svg}</svg>`;
}

function buildDiagramPanel(r) {
  return `
    <details class="panel" open>
      <summary style="font-size:14px;">Deployment architecture — ${r.cloudLabel}${r.topology === "active-passive" ? " (Active-Passive)" : r.topology === "active-active" ? " (Active-Active)" : ""}</summary>
      <p style="margin:10px 0 8px; font-size:13px; color:var(--muted);">Schematic of the ${r.deployment === "k8s" ? "Kubernetes" : "VM"} deployment for the selected products. Component boxes show <em>name ×replicas</em>; dashed boxes are managed / external services.</p>
      <div style="margin-top:8px;">${buildArchitectureDiagram(r)}</div>
      <button class="export" id="diagramBtn">⤓ Download diagram (.svg)</button>
      <div class="hint" style="margin-top:8px;">Schematic only — CIDRs and region names are illustrative. ${r.ha ? "HA replicas spread across multiple AZs/zones." : "Single-AZ (no HA)."} Managed / external services sit outside the subnets. Sensors (Runtime) run as a per-node DaemonSet and aren't drawn as separate boxes.</div>
    </details>`;
}

/* ---------- License allocation advisory panel ---------- */

// Valid Artifactory node counts matching the published tier thresholds.
const ARTI_TIER_STEPS = [
  { nodes: 1, key: "small",   name: "Small"   },
  { nodes: 2, key: "medium",  name: "Medium"  },
  { nodes: 3, key: "large",   name: "Large"   },
  { nodes: 4, key: "xlarge",  name: "XLarge"  },
  { nodes: 6, key: "2xlarge", name: "2XLarge" },
];

function artiTierFromNodes(n) {
  // Highest published tier reachable with n nodes.
  for (let i = ARTI_TIER_STEPS.length - 1; i >= 0; i--) {
    if (n >= ARTI_TIER_STEPS[i].nodes) return ARTI_TIER_STEPS[i];
  }
  return ARTI_TIER_STEPS[0];
}

function nextArtiTier(n) {
  // The next tier that requires more nodes than n; null if already at 2XLarge.
  return ARTI_TIER_STEPS.find(t => t.nodes > n) || null;
}

function buildLicenseAllocationPanel(r) {
  if (!r.licensePurchased || r.licensePurchased < 1) return "";

  const N       = r.licensePurchased;
  // Map sizingBias values: "normal" → balanced, "performance" → performance, "resilience" → resiliency
  const bias    = r.sizingBias === "performance" ? "performance" : r.sizingBias === "resilience" ? "resiliency" : "balanced";
  const isAP    = r.topology === "active-passive";
  const isAA    = r.topology === "active-active";
  const isMulti = isAP || isAA;

  const arti          = findComp(r, "Artifactory");
  const currentActive = arti ? arti.replicas : 1;
  const currentPassive = isMulti
    ? ((r.passiveComponents || []).find(c => c.name === "Artifactory")?.replicas || 0)
    : 0;
  const currentTotal = currentActive + currentPassive;
  const gap          = currentTotal - N;

  const siteA = isAA ? "Site A" : "Primary";
  const siteB = isAA ? "Site B" : "Passive";

  const NL  = r.nodeLabel;   // "replica" (K8s) or "node" (Servers)
  const NLS = r.nodesLabel;  // "replicas" or "nodes"
  const Cap = s => s.charAt(0).toUpperCase() + s.slice(1); // capitalise first letter

  let html = `
    <details class="panel" open>
      <summary style="font-size:14px;">License allocation — ${N} purchased Artifactory license${N === 1 ? "" : "s"}</summary>
      <div class="notice info" style="margin-top:10px; font-size:12px;">
        <strong>How licensing maps to your deployment:</strong>
        1 Artifactory license = 1 Artifactory ${NL}
        ${r.deployment === "k8s"
          ? "(a running pod/container in the StatefulSet — set via <code>replicaCount</code> in the Helm chart)."
          : "(a dedicated server or VM running the Artifactory process)."}
        Other JFrog services (Xray, Nginx, RabbitMQ, Catalog …) do <em>not</em> consume Artifactory licenses.
      </div>
      <div class="notice ${gap > 0 ? "danger" : "info"}" style="margin-top:8px;">
        <strong>Your current sizing consumes ${currentTotal} Artifactory license${currentTotal === 1 ? "" : "s"}</strong>
        ${isMulti ? ` (${currentActive} ${siteA} + ${currentPassive} ${siteB} Artifactory ${NLS})` : ` (${currentActive} Artifactory ${currentActive === 1 ? NL : NLS})`}.
        ${gap > 0
          ? `You are <strong>${gap} license${gap === 1 ? "" : "s"} short</strong> — increase your license count or reduce the tier.`
          : N === currentTotal
            ? "Your purchased licenses exactly match this sizing."
            : `You have <strong>${N - currentTotal} spare license${N - currentTotal === 1 ? "" : "s"}</strong> — see the allocation options below.`}
      </div>
  `;

  if (!isMulti) {
    // ── Single site ────────────────────────────────────────────────────────────
    const usable  = Math.min(N, 6); // 2XLarge cap
    const surplus = N - usable;
    const tier    = artiTierFromNodes(usable);
    const next    = nextArtiTier(usable);

    html += `
      <table style="margin-top:12px;">
        <thead><tr><th>Artifactory ${NLS}</th><th>Tier</th><th>Licenses used</th><th>Banked</th></tr></thead>
        <tbody>
          <tr style="background:rgba(64,191,106,0.15);font-weight:600;">
            <td>${usable}</td>
            <td><span class="chip ok">${tier.name}</span></td>
            <td>${usable}</td>
            <td>${surplus > 0 ? surplus : "—"}</td>
          </tr>
        </tbody>
      </table>`;

    if (next) {
      const needed = next.nodes - usable;
      html += `<div class="notice" style="margin-top:10px;"><strong>Next upgrade:</strong> ${needed} more license${needed === 1 ? "" : "s"} (${next.nodes} total) → <strong>${next.name}</strong> (${next.nodes} Artifactory ${next.nodes === 1 ? NL : NLS}).</div>`;
    } else {
      html += `<div class="hint" style="margin-top:10px;">You are at the maximum published tier (2XLarge, 6 Artifactory ${NLS}). For scale beyond 2XLarge contact JFrog Support.</div>`;
    }

  } else {
    // ── Multi-site ─────────────────────────────────────────────────────────────
    // Generate one row per valid primary tier. Secondary gets the highest tier
    // reachable with the remaining budget (capped at 6 / 2XLarge).
    const rows = [];
    for (const pt of ARTI_TIER_STEPS) {
      if (pt.nodes >= N) continue;          // must leave at least 1 for the other site
      const remaining = N - pt.nodes;
      const st = artiTierFromNodes(Math.min(remaining, 6));
      const surplus = remaining - st.nodes;
      rows.push({ pNodes: pt.nodes, pTier: pt, sNodes: st.nodes, sTier: st, used: pt.nodes + st.nodes, surplus });
    }

    // Recommended split based on bias.
    function recommendedSplit() {
      if (bias === "performance") {
        // Maximise primary.
        return rows[rows.length - 1];
      }
      if (bias === "resiliency") {
        // Both sites at the same (or closest) tier.
        return rows.reduce((best, row) => {
          const diff    = Math.abs(row.pNodes - row.sNodes);
          const bestDiff = Math.abs(best.pNodes - best.sNodes);
          return diff < bestDiff ? row : best;
        });
      }
      // Balanced: primary roughly 60 % — pick the row closest to that ratio.
      const target = N * 0.6;
      return rows.reduce((best, row) => Math.abs(row.pNodes - target) < Math.abs(best.pNodes - target) ? row : best);
    }

    const rec = recommendedSplit();

    // For A/A flag if sites aren't equal-tier.
    const aaImbalanceNote = isAA ? `<div class="notice" style="margin-top:10px;">In Active-Active both sites serve live traffic. Unequal tiers create an imbalanced system — a <strong>balanced (equal) split is strongly recommended</strong>.</div>` : "";

    html += aaImbalanceNote;

    html += `
      <table style="margin-top:12px;">
        <thead>
          <tr>
            <th>${siteA} ${Cap(NLS)}</th><th>${siteA} tier</th>
            <th>${siteB} ${Cap(NLS)}</th><th>${siteB} tier</th>
            <th>Licenses used</th><th>Banked</th><th></th>
          </tr>
        </thead>
        <tbody>`;

    // Sort: performance-first (most primary nodes first).
    rows.slice().reverse().forEach(row => {
      const isRec = row === rec;
      const biasChip = isRec ? `<span class="chip warn" style="font-size:10px;padding:1px 5px;">★ ${bias}</span>` : "";
      const aaWarn   = isAA && row.pTier.name !== row.sTier.name ? `<span class="chip" style="font-size:10px;padding:1px 5px;opacity:0.7;">unbalanced</span>` : "";
      html += `
        <tr${isRec ? ' style="background:rgba(64,191,106,0.15);font-weight:600;"' : ""}>
          <td>${row.pNodes}</td>
          <td><span class="chip ${isRec ? "ok" : ""}">${row.pTier.name}</span></td>
          <td>${row.sNodes}</td>
          <td><span class="chip ${isRec && row.sTier.name === row.pTier.name ? "ok" : ""}">${row.sTier.name}</span></td>
          <td>${row.used}</td>
          <td>${row.surplus > 0 ? row.surplus : "—"}</td>
          <td>${biasChip}${aaWarn}</td>
        </tr>`;
    });

    html += `</tbody></table>`;

    // ── Scaling path ────────────────────────────────────────────────────────────
    const milestones = [];
    const seen = new Set();

    // For each tier step above each site in the recommended split, compute
    // how many additional licenses unlock it.
    for (const step of ARTI_TIER_STEPS) {
      if (step.nodes > rec.pNodes) {
        const extra = step.nodes - rec.pNodes;
        const label = `${siteA}: ${rec.pNodes} → ${step.nodes} Artifactory ${NLS} → <strong>${step.name}</strong>`;
        const key   = `${extra}|${label}`;
        if (!seen.has(key)) { milestones.push({ extra, label }); seen.add(key); }
      }
      if (step.nodes > rec.sNodes) {
        const extra = step.nodes - rec.sNodes;
        const label = `${siteB}: ${rec.sNodes} → ${step.nodes} Artifactory ${NLS} → <strong>${step.name}</strong>`;
        const key   = `${extra}|${label}`;
        if (!seen.has(key)) { milestones.push({ extra, label }); seen.add(key); }
      }
    }

    // "Equal tiers on both sites" milestones.
    if (rec.pTier.name !== rec.sTier.name) {
      const target = Math.max(rec.pNodes, rec.sNodes);
      const extra  = (target - rec.pNodes) + (target - rec.sNodes);
      if (extra > 0) {
        const t    = artiTierFromNodes(target);
        const key  = `${extra}|equal`;
        if (!seen.has(key)) { milestones.push({ extra, label: `Equal tiers: ${target}+${target} Artifactory ${NLS} → <strong>${t.name}+${t.name}</strong> on both sites` }); seen.add(key); }
      }
    }

    // "Fully scaled" (6+6 = 2XLarge both) milestone.
    const fullExtra = (6 - rec.pNodes) + (6 - rec.sNodes);
    if (fullExtra > 0) {
      const key = `${fullExtra}|full`;
      if (!seen.has(key)) { milestones.push({ extra: fullExtra, label: `Fully scaled: 6+6 Artifactory ${NLS} → <strong>2XLarge+2XLarge</strong> on both sites` }); seen.add(key); }
    }

    milestones.sort((a, b) => a.extra - b.extra);

    if (milestones.length) {
      html += `
        <p style="margin:14px 0 6px;"><strong>Scaling path from recommended allocation (${rec.pNodes}+${rec.sNodes} Artifactory ${NLS}, ${rec.used} licenses):</strong></p>
        <table>
          <thead><tr><th>+Licenses</th><th>Total</th><th>Upgrade</th></tr></thead>
          <tbody>`;
      milestones.slice(0, 5).forEach(m => {
        html += `<tr><td>+${m.extra}</td><td>${N + m.extra}</td><td>${m.label}</td></tr>`;
      });
      html += `</tbody></table>`;
    }
  }

  html += `</details>`;
  return html;
}

function buildLicensePanel(r) {
  const items     = licenseItems(r);
  const lic       = licenseCount(r);
  const effective = lic.tier;
  const effClass  = effective === "Enterprise+" ? "danger" : effective === "Enterprise X" ? "warn" : "ok";

  const isMulti   = r.topology === "active-passive" || r.topology === "active-active";
  const totalArti = lic.total;
  const splitNote = r.topology === "active-passive" ? ` (${lic.active} active + ${lic.passive} passive)`
                  : r.topology === "active-active"  ? ` (${lic.active} site A + ${lic.passive} site B)`
                  : "";

  const rows = items.map(it => {
    const cls = it.tier === "Enterprise+" ? "danger" : it.tier === "Enterprise X" ? "warn" : "ok";
    return `<tr><td><strong>${it.name}</strong></td><td><span class="chip ${cls}">${it.tier}</span></td><td><span class="hint">${it.note}</span></td></tr>`;
  }).join("");

  const purchasedNote = r.licenseMode && lic.purchased != null
    ? ` Purchased: <strong>${lic.purchased}</strong>${lic.unused > 0 ? ` (${lic.unused} unused)` : ""}.`
    : "";
  const baselineNote = r.baseline
    ? ` Load baseline: <strong>${TIER_LABEL[r.baseline.tier]}</strong> (${r.baseline.activeNodes}${r.baseline.passiveNodes ? ` + ${r.baseline.passiveNodes}` : ""} node${r.baseline.totalLicenses === 1 ? "" : "s"}).`
    : "";

  return `
    <details class="panel">
      <summary style="font-size:14px;">Licensing — minimum subscription: ${effective} · ${totalArti} Artifactory license${totalArti === 1 ? "" : "s"}</summary>
      <div class="notice ${effClass}" style="margin-top:10px;">
        <strong>Minimum subscription for this configuration: ${effective}.</strong>
        ${r.svc.jas ? " Plus the <strong>JFrog Advanced Security</strong> add-on (on top of the Xray entitlement)." : ""}
        One subscription licenses the whole JFrog Platform Site — Xray, Distribution, Mission Control, etc. are entitlements within that tier, not separately-licensed servers.
      </div>
      <div class="notice ${effClass}" style="margin-top:10px;">
        <strong>Licenses needed for this configuration: ${totalArti} Artifactory license${totalArti === 1 ? "" : "s"}${splitNote}.</strong>${purchasedNote}
        The platform is licensed per Artifactory ${r.nodeLabel} — <strong>1 license = 1 Artifactory ${r.nodeLabel}</strong>${isMulti ? ", per site" : ""}.${lic.edge ? " Distribution Edge nodes carry their own <strong>Edge licenses</strong> (counted separately)." : ""}
      </div>
      ${baselineNote ? `<div class="hint" style="margin-top:8px;">${baselineNote}</div>` : ""}
      ${r.biasDelta && r.biasDelta.isOverBaseline ? `<div class="notice info" style="margin-top:10px;"><strong>Sized above load baseline</strong> — effective sizing exceeds what projected load alone requires.${r.sizingBias !== "normal" ? ` ${r.sizingBias === "performance" ? "Performance" : "Resilience"} bias applied.` : ""}</div>` : ""}
      ${r.biasDelta && r.biasDelta.isUnderBaseline ? `<div class="notice warn" style="margin-top:10px;"><strong>Sized below load baseline</strong> — ${r.licenseMode ? "purchased licenses" : "current settings"} provide fewer Artifactory nodes than projected load implies (${TIER_LABEL[r.loadTier]}). Capacity may be insufficient.</div>` : ""}
      <table>
        <thead><tr><th>Product / capability</th><th>Min. subscription</th><th>Notes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="hint" style="margin-top:10px;"><strong>License count:</strong> each Artifactory ${r.nodeLabel} consumes one license — this deployment uses <strong>${totalArti}</strong> license${totalArti === 1 ? "" : "s"}${splitNote} from your license bucket.${r.svc.distribution ? " Distribution Edge nodes are licensed separately (Edge licenses)." : ""}</div>
      <div class="hint" style="margin-top:6px;"><strong>How it's applied:</strong> ${r.deployment === "k8s"
        ? "supply the license to the Helm chart via a Secret (<code>artifactory.license.secret</code> / <code>licenseKey</code>) or post-install through the UI / Access API."
        : "drop <code>artifactory.lic</code> into <code>$JFROG_HOME/artifactory/var/etc/artifactory/</code> (or apply via the UI / Access API) at install time."}</div>
      <div class="hint" style="margin-top:6px;">Subscription tiers, inclusions and pricing change over time — <strong>confirm exact entitlements with your JFrog account team</strong>. Reference: <a href="https://jfrog.com/pricing/" target="_blank">JFrog subscriptions</a> &middot; <a href="https://jfrog.com/help/r/jfrog-installation-setup-documentation/manage-the-artifactory-license" target="_blank">Managing the license</a>.</div>
    </details>
  `;
}

/* ---------- Render ---------- */

let lastResult = null; // most recent render() input, for CSV export

function fmtInstance(inst, r) {
  if (r.infraType !== "baremetal") return inst;
  return inst.replace(/\bVM\b/g, "Server").replace(/\bvCPU\b/g, "core");
}

function render(r) {
  lastResult = r;
  const deployLabel = r.deployment === "k8s" ? "Kubernetes" : "Virtual Machines";
  const tierName    = TIER_LABEL[r.tier];
  const isAP        = r.topology === "active-passive";
  const isAA        = r.topology === "active-active";
  const isMulti     = isAP || isAA;                           // two-site topology
  const siteALabel  = isAA ? "Site A (active)" : "Active site";
  const siteBLabel  = isAA ? "Site B (active)" : `Passive site (${r.passiveScale === "hot" ? "Active-Standby" : "Warm Standby"})`;
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
        <div class="stat"><div class="label">Topology</div><div class="value">${isAA ? "Active-Active" : isAP ? "Active-Passive" : "Single"}</div></div>
      </div>
      <div style="margin-top:14px;">
        <span class="chip">${r.activeClients.toLocaleString()} concurrent conns → ${TIER_LABEL[r.connsTier]}</span>
        <span class="chip">${r.rpm.toLocaleString()} RPM → ${TIER_LABEL[r.rpmTierKey]}</span>
        <span class="chip">Load baseline: ${TIER_LABEL[r.loadTier]}</span>
        <span class="chip warn">Effective tier: ${tierName}${r.licenseMode ? " (license-driven)" : r.sizingBias !== "normal" ? ` (${r.sizingBias} bias)` : ""}</span>
        ${r.xrayEnabled ? `<span class="chip">Xray ${r.xrayArtifacts.toLocaleString()} indexed</span>` : `<span class="chip">No Xray</span>`}
        ${r.growthPct > 0 ? `<span class="chip warn">+${r.growthPct}% growth headroom</span>` : ""}
        ${r.cacheFsGB > 0 ? `<span class="chip ok">Cache-fs ${fmtGB(r.cacheFsGB)}/node</span>` : ""}
      </div>
      <div style="margin-top:10px;">
        <span class="chip ok">${r.ha ? "HA enabled" : "Single replica"}</span>
        <span class="chip">${r.sizingBias === "performance" ? "Performance bias" : r.sizingBias === "resilience" ? "Resilience bias" : "Normal sizing"}</span>
        ${r.licenseMode ? `<span class="chip ok">${r.licensePurchased} licenses purchased</span>` : `<span class="chip">Licenses: auto (from load)</span>`}
        ${r.licenseMode && r.licenseAllocation && r.licenseAllocation.secondary > 0 ? `<span class="chip">${r.licenseAllocation.primary} + ${r.licenseAllocation.secondary} split</span>` : ""}
        ${r.biasDelta && r.biasDelta.isOverBaseline ? `<span class="chip ok">Above load baseline</span>` : ""}
        ${r.biasDelta && r.biasDelta.isUnderBaseline ? `<span class="chip warn">Below load baseline</span>` : ""}
        <span class="chip ok">Placement: ${placement}</span>
        <span class="chip ok">LB: ${r.lbDisplay}</span>
        ${r.externalLB && !r.provisionNginx ? `<span class="chip warn">No Nginx tier</span>` : ""}
        ${r.externalRMQ && r.xrayEnabled ? `<span class="chip warn">External RabbitMQ</span>` : ""}
        ${r.svc.curation ? `<span class="chip ok">Curation + Catalog</span>` : ""}
        ${r.svc.curation && r.externalValkey ? `<span class="chip warn">External Valkey</span>` : ""}
        ${isAP ? `<span class="chip warn">Passive: ${r.passiveScale === "hot" ? "Active-Standby" : "Warm Standby"}</span>` : ""}
        ${isAA ? `<span class="chip warn">Active-Active (2 sites)</span>` : ""}
      </div>
      ${r.growthPct > 0 ? `
      <div class="notice info" style="margin-top:12px;">
        <strong>Sized for ${r.growthPct}% projected growth.</strong>
        Binary storage: ${r.binaryTBInput} TB → <strong>${r.binaryTB} TB</strong>.
        Load baseline tier is ${TIER_LABEL[r.loadTier]}; effective tier and replica counts follow ${r.licenseMode ? "purchased license allocation" : r.sizingBias !== "normal" ? `${r.sizingBias} bias` : "projected load"}.
      </div>` : ""}
      ${r.biasDelta && (r.biasDelta.isOverBaseline || r.biasDelta.isUnderBaseline) ? `
      <div class="notice ${r.biasDelta.isUnderBaseline ? "warn" : "info"}" style="margin-top:12px;">
        <strong>${r.biasDelta.isUnderBaseline ? "Under" : "Over"}-allocated vs load baseline.</strong>
        ${r.biasDelta.tierDelta !== 0 ? ` Tier: ${TIER_LABEL[r.baseline.tier]} → ${tierName} (${r.biasDelta.tierDelta > 0 ? "+" : ""}${r.biasDelta.tierDelta} step${Math.abs(r.biasDelta.tierDelta) === 1 ? "" : "s"}).` : ""}
        ${r.biasDelta.activeNodeDelta !== 0 ? ` Primary site: ${r.baseline.activeNodes} → ${licenseCount(r).active} Artifactory node${licenseCount(r).active === 1 ? "" : "s"}.` : ""}
        ${r.biasDelta.passiveNodeDelta !== 0 ? ` Secondary site: ${r.baseline.passiveNodes} → ${licenseCount(r).passive} Artifactory node${licenseCount(r).passive === 1 ? "" : "s"}.` : ""}
        ${r.sizingBias !== "normal" ? ` ${r.sizingBias === "performance" ? "Performance" : "Resilience"} bias influenced this recommendation.` : ""}
      </div>` : ""}
    </div>
  `;

  /* Warnings */
  const warnings = [];
  if (r.licenseMode && TIER_ORDER.indexOf(r.loadTier) > TIER_ORDER.indexOf(r.tier)) {
    warnings.push({type:"warn", text:`<strong>License capacity:</strong> projected load implies <strong>${TIER_LABEL[r.loadTier]}</strong> (${r.baseline.activeNodes} Artifactory node${r.baseline.activeNodes === 1 ? "" : "s"} per site) but purchased licenses size to <strong>${tierName}</strong>. Consider additional licenses or reduced load projections.`});
  }
  if (r.licenseSnapWarnings && r.licenseSnapWarnings.length) {
    r.licenseSnapWarnings.forEach(msg => warnings.push({type:"warn", text: msg}));
  }
  if (r.licenseMode && isMulti && r.licensePurchased < 2) {
    warnings.push({type:"danger", text:"Multi-site topology requires at least 2 Artifactory licenses (one per site minimum)."});
  }
  if (r.licenseMode && !r.ha) {
    const lic = licenseCount(r);
    const siteCount = isMulti ? 2 : 1;
    const maxNeeded = siteCount; // one Artifactory node per site in single-replica mode
    if (r.licensePurchased > maxNeeded || lic.unused > 0) {
      const excess = Math.max(r.licensePurchased - maxNeeded, lic.unused);
      warnings.push({type:"warn", text:`<strong>Excess licenses:</strong> single-replica mode needs at most <strong>${maxNeeded}</strong> Artifactory license${maxNeeded === 1 ? "" : "s"} (${lic.total} deployed across ${siteCount} site${siteCount === 1 ? "" : "s"}) — <strong>${excess}</strong> purchased license${excess === 1 ? " is" : "s are"} not needed.`});
    }
  } else if (r.licenseMode) {
    const lic = licenseCount(r);
    if (lic.unused > 0) {
      warnings.push({type:"info", text:`<strong>Unused licenses:</strong> <strong>${lic.unused}</strong> of ${r.licensePurchased} purchased license${r.licensePurchased === 1 ? " is" : "s are"} not assigned to an Artifactory node in this sizing.`});
    }
  }
  if (r.resilienceOverride) {
    warnings.push({type:"info", text:"<strong>Resilience bias:</strong> passive site sized at full mirror replica counts despite Warm Standby topology selection — this is a sizing recommendation for failover headroom, not a change to your topology input."});
  }
  if (!r.licenseMode && r.sizingBias === "performance" && r.tier !== r.loadTier) {
    warnings.push({type:"info", text:`<strong>Performance bias:</strong> sized one tier above load baseline (${TIER_LABEL[r.loadTier]} → <strong>${tierName}</strong>).`});
  }
  if (r.activeClients > 6000)            warnings.push({type:"danger", text:"Concurrent connections exceed 6,000 (2XLarge tier ceiling) — contact JFrog Support for custom Enterprise+ sizing."});
  if (r.rpm > 500000)                    warnings.push({type:"danger", text:"RPM exceeds published 2XLarge tier (500K). Custom sizing required."});
  if (r.xrayArtifacts > 10000000)        warnings.push({type:"danger", text:"Indexed artifacts exceed 10M — contact JFrog Support."});
  if (r.svc.jas && !r.xrayEnabled)       warnings.push({type:"warn",   text:"JAS requires Xray. Enable Xray or uncheck JAS — it has been skipped."});
  if (r.deployment === "k8s")            warnings.push({type:"info",   text:"<strong>Kubernetes:</strong> the per-replica vCPU/RAM below represent the worker-node capacity each pod needs. JFrog's Helm chart sizing presets (in <code>jfrog/charts</code>) define authoritative per-pod requests/limits — typically smaller because requests are floors, not host totals."});
  if (r.svc.jas && r.xrayEnabled && r.deployment === "k8s") {
    const jasConcurrent = r.xrayArtifacts <= 100000 ? 1 : r.xrayArtifacts <= 1000000 ? 2 : r.xrayArtifacts <= 2000000 ? 4 : 8;
    warnings.push({type:"info", text:`<strong>JAS ephemeral scan jobs:</strong> each scanner pod (exposuresscannersjob, secretsscannersjob, iacsscannersjob, sastscannersjob) needs <strong>2 vCPU / 4 GB RAM</strong> on top of the Xray pod overhead above. For ${r.xrayArtifacts.toLocaleString()} indexed artifacts, plan for up to <strong>${jasConcurrent} concurrent scan job${jasConcurrent > 1 ? "s" : ""}</strong> — reserve an extra <strong>${jasConcurrent * 2} vCPU / ${jasConcurrent * 4} GB RAM</strong> on the node pool. Set <code>xray.jas.executionService.cpuRequest: "2"</code> and <code>memRequest: "4Gi"</code> equal to the limits so jobs are scheduled predictably. Optionally pin scan jobs to a dedicated tainted node pool via <code>xray.jas.executionService.affinityLabelKey/Value</code>.`});
  }
  {
    const licTier = licenseEffectiveTier(r);
    warnings.push({type: licTier === "Enterprise+" ? "warn" : "info",
      text:`<strong>Licensing:</strong> this configuration needs at least a <strong>${licTier}</strong> self-hosted subscription${r.svc.jas ? " plus the <strong>JFrog Advanced Security</strong> add-on" : ""}${r.svc.runtime ? " plus the <strong>Runtime Security</strong> entitlement" : ""}. See the Licensing section for the per-product breakdown and license count. Confirm exact entitlements with your JFrog account team.`});
  }

  if (warnings.length) {
    html += `<details class="panel" open><summary style="font-size:14px;">Notes &amp; warnings</summary>`;
    warnings.forEach(w => {
      const cls = w.type === "danger" ? "danger" : w.type === "info" ? "info" : "";
      html += `<div class="notice ${cls}" style="margin-bottom:8px;">${w.text}</div>`;
    });
    html += `</details>`;
  }

  /* Aggregate footprint */
  const nodeStatLabel = r.deployment === "k8s" ? "Total nodes" : "VM instances";
  function footprintCard(label, t) {
    return `
      <details class="panel">
        <summary style="font-size:14px;">${label}</summary>
        <div class="summary-grid">
          <div class="stat"><div class="label">${nodeStatLabel}</div><div class="value">${t.nodes}</div></div>
          <div class="stat"><div class="label">${r.cpuLabel}</div><div class="value">${t.cpu}</div></div>
          <div class="stat"><div class="label">Memory</div><div class="value">${t.mem}<span class="unit">GB</span></div></div>
          <div class="stat"><div class="label">Storage</div><div class="value">${fmtGB(t.disk)}</div></div>
        </div>
      </details>
    `;
  }
  if (isMulti) {
    const gt = {
      nodes: r.activeTotals.nodes + r.passiveTotals.nodes,
      cpu:   r.activeTotals.cpu   + r.passiveTotals.cpu,
      mem:   r.activeTotals.mem   + r.passiveTotals.mem,
      disk:  r.activeTotals.disk  + r.passiveTotals.disk
    };
    html += footprintCard(`Grand total (${isAA ? "Active-Active" : "Active-Passive"})`, gt);
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
      ? `Self-managed control plane: add 3 dedicated control-plane nodes (4 ${r.cpuLabel} / 8 GB each, stacked etcd) per cluster for quorum — not counted in the worker totals.`
      : `Managed control plane (${cpName}) — control-plane sizing &amp; HA are handled by the cloud provider, at no worker-node cost.`;
    const placementNote = r.k8sPlacement === "antiaffinity"
      ? "Anti-affinity (shared pool): stateful pods are spread across nodes but may share them — node count is an upper bound that bin-packing can reduce."
      : "Dedicated node pool: one Artifactory/Nginx/Xray pod per node. Smaller stateless pods can share nodes — figures are a safe upper bound.";
    const k8sPlanCard = (label, plan) => `
      <details class="panel">
        <summary style="font-size:14px;">Kubernetes cluster plan — ${label}</summary>
        <div class="summary-grid">
          <div class="stat"><div class="label">Worker nodes</div><div class="value">${plan.workerNodes}</div></div>
          <div class="stat"><div class="label">Node pools</div><div class="value">${plan.pools.length}</div></div>
          <div class="stat"><div class="label">Cluster ${r.cpuLabel}</div><div class="value">${plan.clusterCPU}<span class="unit" title="Worker capacity + ~15% for kubelet, OS, CNI, system DaemonSets">incl. sys</span></div></div>
          <div class="stat"><div class="label">Cluster RAM</div><div class="value">${plan.clusterMem}<span class="unit" title="Worker capacity + ~15% for kubelet, OS, CNI, system DaemonSets">GB incl. sys</span></div></div>
        </div>
        <table style="margin-top:12px;">
          <thead><tr><th>Node pool (VM size)</th><th>${r.cpuLabel}</th><th>RAM</th><th>Nodes</th><th>Runs</th></tr></thead>
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
            <tr style="background:var(--panel-2);opacity:0.75;">
              <td><em>+ ~15% sys overhead (kubelet, OS, CNI, DaemonSets)</em></td>
              <td><em>+${plan.clusterCPU - plan.workerCPU}</em></td>
              <td><em>+${plan.clusterMem - plan.workerMem} GB</em></td>
              <td></td>
              <td></td>
            </tr>
            <tr style="background:var(--panel-2);font-weight:700;">
              <td>Provision target</td>
              <td>${plan.clusterCPU}</td>
              <td>${plan.clusterMem} GB</td>
              <td></td>
              <td></td>
            </tr>
          </tbody>
        </table>
        <div class="notice info" style="margin-top:12px;">
          <strong>Cluster sizing:</strong> ${plan.workerNodes} worker nodes across ${plan.pools.length} node pool${plan.pools.length === 1 ? "" : "s"} provide <strong>${plan.workerCPU} ${r.cpuLabel} / ${plan.workerMem} GB</strong> of pod-schedulable capacity. Adding ~15% for kubelet, OS, CNI and system DaemonSets, provision ≈ <strong>${plan.clusterCPU} ${r.cpuLabel} / ${plan.clusterMem} GB</strong>. ${controlPlaneNote}${plan.dbNote}
        </div>
        <div class="hint" style="margin-top:8px;">${placementNote}</div>
      </details>
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
    <details class="panel">
      <summary style="font-size:14px;">Storage &amp; network</summary>
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
    </details>
  `;

  /* Per-component table + procurement tally — rendered per cluster */
  const instColHeader = r.deployment === "k8s" ? "Recommended node-pool VM" : "VM instance";
  function clusterSection(label, comps) {
    let h = `
      <details class="panel" open>
        <summary style="font-size:14px;">${label} — per-component sizing (${r.cloudLabel} ${tierName}, ${deployLabel})</summary>
        <table>
          <thead>
            <tr>
              <th>Component</th><th>${r.nodesLabel.charAt(0).toUpperCase() + r.nodesLabel.slice(1)}</th><th>${r.cpuLabel}</th><th>RAM</th>
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
          <td><code>${fmtInstance(c.instance, r)}</code><br><span class="hint">${c.cpu} ${r.cpuLabel} / ${c.memGB} GB</span></td>
          <td><span class="hint">${c.note}</span></td>
        </tr>
      `;
    });
    if (r.svc.curation && r.externalValkey && r.externalValkeySpec) {
      const v = r.externalValkeySpec;
      h += `
        <tr style="opacity:0.8;">
          <td><strong>Valkey</strong>&nbsp;<span class="chip warn" style="font-size:10px;padding:1px 5px;vertical-align:middle;">external</span></td>
          <td>${v.replicas}</td>
          <td>${v.cpu}</td>
          <td>${v.memGB} GB</td>
          <td>${fmtGB(v.diskGB)} <span class="hint">/ ${v.iops.toLocaleString()} IOPS</span></td>
          <td><code>${fmtInstance(v.instance, r)}</code><br><span class="hint">${v.cpu} ${r.cpuLabel} / ${v.memGB} GB</span></td>
          <td><span class="hint">External Valkey cache for Catalog — provisioned separately, not counted in the footprint totals above. See the External Valkey section below for configuration details.</span></td>
        </tr>
      `;
    }
    h += `</tbody></table></details>`;

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
    if (r.deployment === "k8s") return h;
    const procTitle = `${label} — ${r.cloudLabel} VM procurement list`;
    h += `<details class="panel"><summary style="font-size:14px;">${procTitle}</summary>
      <table>
        <thead><tr><th>VM type</th><th>${r.cpuLabel}</th><th>RAM</th><th>Count</th><th>Used by</th></tr></thead>
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
      </tr></tbody></table></details>`;
    return h;
  }

  html += clusterSection(isMulti ? siteALabel : "Cluster", r.components);
  if (isMulti) html += clusterSection(siteBLabel, r.passiveComponents);

  /* Licensing */
  html += buildLicensePanel(r);
  html += buildLicenseAllocationPanel(r);

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
  if (r.svc.distribution) {
    if (r.deployment === "k8s") {
      applied.push(`Distribution runs as a separate StatefulSet pod — own PVC (${r.ha ? 20 : 5} GB per replica), pod limits 1 ${r.cpuLabel} / 2 GB. Not co-located with Artifactory on Kubernetes.`);
    } else {
      applied.push(`Distribution co-located on Artifactory VMs (+2 ${r.cpuLabel} / +2 GB / +200 GB per node — no separate VMs).`);
    }
  }
  if (r.svc.appTrust) {
    if (r.deployment === "k8s") {
      applied.push(`AppTrust + UnifiedPolicy run as separate pods on the Artifactory node pool (${r.ha ? 2 : 1} replica each). Pod limits: AppTrust 1 ${r.cpuLabel} / 2 GB, UnifiedPolicy 0.5 ${r.cpuLabel} / 1 GB — counted in the Artifactory pool capacity total.`);
    } else {
      applied.push(`AppTrust + UnifiedPolicy co-located on Artifactory VMs (+4 ${r.cpuLabel} / +2 GB / +100 GB per node — no separate VMs).`);
    }
  }
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
  if (r.svc.jas && r.xrayEnabled) {
    if (r.deployment === "vm") {
      applied.push("JAS deployed on dedicated server(s) separate from Xray (JFrog JAS prerequisites requirement).");
    } else {
      applied.push("JAS enabled via xray.jas.enabled in the Xray Helm chart — runs within the Xray release, no separate node pool required on Kubernetes.");
    }
  }
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
    applied.push(`<strong>Active-Passive DR topology</strong> — passive site sized as <em>${r.passiveScale === "hot" ? "Active-Standby" : "Warm Standby"}</em>: ${scaleDesc}. Use Artifactory federation / replication for data sync between sites.`);
  }
  if (isAA) {
    applied.push("<strong>Active-Active topology</strong> — two full active sites, each sized identically and both serving traffic. Use Artifactory Federated repositories (bidirectional) + Access Federation for cross-site sync, and a global LB / GSLB (geo or weighted DNS) to distribute clients. Each site has its own database, RabbitMQ and binary store; plan for replication lag and write-conflict handling.");
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
          <tr><td><strong>Service disks (block)</strong></td><td>${sc.block} — sized per-tier (Artifactory 500/1000 GB, Xray 100/200 GB, RabbitMQ 100 GB, JAS 500 GB for ≤100K artifacts / 300 GB per node otherwise)</td></tr>
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
        ${isAP ? `<li><strong>Active-Passive:</strong> run an independent database (or a cross-region read replica promoted on failover) at each site — size each site identically.</li>` : ""}
        ${isAA ? `<li><strong>Active-Active:</strong> each active site runs its own independent database (sized identically). Data sync is via Artifactory federation, not DB-level replication.</li>` : ""}
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
    <details class="panel">
      <summary style="font-size:14px;">External RabbitMQ — recommended sizing, plugins &amp; configuration</summary>
      <div class="notice info" style="margin-top:10px;">
        <strong>Recommended external cluster:</strong> ${s.replicas} × <code>${s.instance}</code> (${s.cpu} ${r.cpuLabel} / ${s.memGB} GB, ${fmtGB(s.diskGB)} disk @ ${s.iops.toLocaleString()} IOPS each)${isMulti ? " per site" : ""}. ${s.quorumNote} These nodes run on infrastructure you manage and are <strong>not</strong> counted in the platform footprint or Kubernetes cluster plan above.
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
        ${isMulti ? `<li><strong>${isAA ? "Active-Active" : "Active-Passive"}:</strong> run an independent external RabbitMQ cluster at each site (Xray does not replicate RMQ across sites) — the recommended size applies per site.</li>` : ""}
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
    <details class="panel">
      <summary style="font-size:14px;">External Valkey — recommended sizing &amp; configuration</summary>
      <div class="notice info" style="margin-top:10px;">
        <strong>Recommended external cache:</strong> ${v.replicas} × <code>${v.instance}</code> (${v.cpu} ${r.cpuLabel} / ${v.memGB} GB, ${fmtGB(v.diskGB)} disk each)${isMulti ? " per site" : ""}. ${v.replicas >= 3 ? "Odd node count for Sentinel/cluster quorum — tolerates 1 node failure." : "Single node — no failover."} Valkey (or Redis ≥ 7) backs the Catalog service; it runs on infrastructure you manage and is <strong>not</strong> counted in the platform footprint above.
      </div>
      <p style="margin:12px 0 4px;"><strong>Configuration checklist</strong>:</p>
      <ul style="margin:4px 0 10px; padding-left:20px; color:var(--muted); font-size:13px; line-height:1.7;">
        <li><strong>Engine:</strong> Valkey (or a compatible Redis ≥ 7) — a managed option (ElastiCache / Azure Cache for Redis / Memorystore) works too. Match the version in the Catalog system requirements.</li>
        <li><strong>Memory:</strong> set <code>maxmemory</code> to ~75% of node RAM with <code>maxmemory-policy allkeys-lru</code>; the cache grows with the size of the indexed package catalog.</li>
        <li><strong>HA:</strong> deploy an <strong>odd</strong> number of nodes (3/5) with Sentinel, or use cluster mode; expose a single endpoint to Catalog.</li>
        <li><strong>Persistence:</strong> the Catalog cache is rebuildable — RDB snapshots are usually enough; enable AOF only if you want faster warm restarts.</li>
        <li><strong>Ports:</strong> <code>6379</code> (Valkey/Redis), <code>6380</code> (TLS), <code>16379</code> (cluster bus) and <code>26379</code> (Sentinel) between Catalog ↔ Valkey and between Valkey nodes.</li>
        <li><strong>Auth/TLS:</strong> set <code>requirepass</code> (or ACL users) and terminate TLS on <code>6380</code> with CA-signed certs.</li>
        ${isMulti ? `<li><strong>${isAA ? "Active-Active" : "Active-Passive"}:</strong> run an independent Valkey cluster at each site — the recommended size applies per site.</li>` : ""}
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

  /* Replica / node count formula */
  const TIER_ROWS = [
    { tier:"Small",   conns:"≤ 100",   rpm:"≤ 6,000",   arti:1, nginx:1, xray:1, rmq:1  },
    { tier:"Medium",  conns:"≤ 500",   rpm:"≤ 50,000",  arti:2, nginx:2, xray:2, rmq:3  },
    { tier:"Large",   conns:"≤ 1,200", rpm:"≤ 100,000", arti:3, nginx:2, xray:2, rmq:3  },
    { tier:"XLarge",  conns:"≤ 3,000", rpm:"≤ 200,000", arti:4, nginx:2, xray:2, rmq:3  },
    { tier:"2XLarge", conns:"≤ 6,000", rpm:"≤ 500,000", arti:6, nginx:3, xray:3, rmq:3  },
  ];
  html += `
    <details>
      <summary>${r.nodesLabel.charAt(0).toUpperCase() + r.nodesLabel.slice(1)} count formula — how the tier and ${r.nodesLabel} count are derived</summary>
      <p style="margin-top:10px;"><strong>Step 1 — load baseline tier:</strong> classify concurrent connections and RPM independently, then take <code>max(connections tier, RPM tier)</code>. This is always computed as the reference baseline.</p>
      <p style="margin-top:8px;"><strong>Step 2 — effective sizing mode:</strong></p>
      <ul style="margin:4px 0 10px; padding-left:20px; font-size:13px; line-height:1.8;">
        <li><strong>No license entered:</strong> effective tier = load baseline (Normal bias), or +1 tier (Performance bias), or full passive mirror (Resilience bias on warm A/P).</li>
        <li><strong>License entered:</strong> licenses are split across sites (balanced, custom, or warm-fixed), optionally skewed by bias, then mapped to per-site Artifactory node counts (1/2/3/4/6). Each site's tier and all component specs cascade from that site's node count.</li>
      </ul>
      <p><strong>Step 3 — compare to baseline:</strong> effective sizing is highlighted when it over- or under-allocates vs the load baseline.</p>
      <p style="margin-top:10px;"><strong>Tier thresholds and ${r.nodesLabel} count (HA mode)</strong>:</p>
      <table style="margin-top:6px;">
        <thead>
          <tr>
            <th>Tier</th>
            <th>Concurrent Connections</th>
            <th>Requests / min (RPM)</th>
            <th>Artifactory<br><span style="font-weight:400;font-size:11px;">${r.nodesLabel} (HA) = licenses</span></th>
            <th>Nginx<br><span style="font-weight:400;font-size:11px;">${r.nodesLabel} (HA)</span></th>
            <th>Xray<br><span style="font-weight:400;font-size:11px;">${r.nodesLabel} (HA)</span></th>
            <th>RabbitMQ<br><span style="font-weight:400;font-size:11px;">${r.nodesLabel} (HA)</span></th>
          </tr>
        </thead>
        <tbody>
          ${TIER_ROWS.map(t => `
          <tr${t.tier === TIER_LABEL[r.tier] ? ' style="background:rgba(64,191,106,0.18);font-weight:600;"' : ""}>
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
        <strong>Load baseline: ${TIER_LABEL[r.loadTier]}</strong> &nbsp;·&nbsp; <strong>Effective tier: ${tierName}</strong>${r.ha ? ` → <strong>${REPLICAS.artifactory[r.tier]} Artifactory ${r.nodesLabel}</strong> = ${REPLICAS.artifactory[r.tier]} license${REPLICAS.artifactory[r.tier] > 1 ? "s" : ""}` : ` → <strong>1 Artifactory ${r.nodeLabel}</strong> = 1 license (HA disabled)`}.
        ${r.licenseMode ? `<br>Sized from <strong>${r.licensePurchased} purchased license${r.licensePurchased === 1 ? "" : "s"}</strong>${r.licenseAllocation && r.licenseAllocation.secondary > 0 ? ` (${r.licenseAllocation.primary} + ${r.licenseAllocation.secondary} split)` : ""}.` : ""}
        ${REPLICAS.artifactory[r.tier] < 4 ? `<br>To reach <strong>4 Artifactory ${r.nodesLabel}</strong> (XLarge tier, 4 licenses), set Concurrent Connections &gt; 1,200 or RPM &gt; 100,000.` : ""}
      </div>
      <ul style="margin:10px 0 4px; padding-left:20px; font-size:13px; line-height:1.8;">
        <li>${r.nodesLabel.charAt(0).toUpperCase() + r.nodesLabel.slice(1)} above are for HA mode. Single-${r.nodeLabel} mode always uses 1 ${r.nodeLabel} per component regardless of tier.</li>
        <li>RabbitMQ is only deployed when Xray is enabled and runs on dedicated nodes for HA or &gt;100K indexed artifacts.</li>
        <li>JAS (<strong>VMs</strong>): dedicated servers scaled by artifact volume — 1 node (≤100K), 2 nodes (≤1M), 4 nodes (≤2M), 8 nodes (≤10M). <strong>Kubernetes</strong>: JAS runs within the Xray Helm chart (xray.jas.enabled) — no separate node pool.</li>
        ${r.svc.distribution ? `<li><strong>Distribution</strong>: ${r.deployment === "k8s" ? "separate StatefulSet pod with its own PVC (5 GB non-HA / 20 GB HA), pod limits 1 vCPU / 2 GB" : "co-locates on Artifactory VMs (+2 vCPU / +2 GB / +200 GB per node — no separate VMs)"}.</li>` : ""}
      </ul>
    </details>
  `;

  /* Reference */
  html += `
    <details style="--link-color:#6dd4a0;">
      <summary>How these numbers are derived</summary>
      <p><strong>Load baseline tier</strong> = max of concurrent connections tier and RPM tier. When no license is entered, effective tier follows the baseline (with optional Performance/Resilience bias). When licenses are entered, per-site Artifactory node counts drive the effective tier and cascade to all component specs.</p>
      <p><strong>Per-cloud instance types &amp; replica counts</strong> are verbatim from JFrog's <a href="https://jfrog.com/reference-architecture/self-managed/deployment/sizing/" target="_blank">reference architecture pages</a>. Replicas by tier — Artifactory 1/2/3/4/6, Nginx and Xray 1/2/2/2/3, RabbitMQ 1/3/3/3/3. <strong>JAS</strong> deployment differs by model: on <em>VMs</em>, JAS requires dedicated servers scaled by artifact volume — 1 node (≤100K, 6 vCPU/24 GB/500 GB), 2 nodes (≤1M, 8 vCPU/24 GB/300 GB), 4 nodes (≤2M), 8 nodes (≤10M) per the <a href="https://docs.jfrog.com/installation/docs/jfrog-advanced-security-prerequisites" target="_blank">JAS prerequisites table</a>. On <em>Kubernetes</em>, JAS runs within the Xray Helm chart (xray.jas.enabled: true) — no separate node pool; ephemeral scan jobs run on the Xray pool or a tainted sub-pool.</p>
      <p><strong>Storage sizing</strong> (disk, IOPS, throughput) is from the <a href="https://jfrog.com/reference-architecture/self-managed/deployment/sizing/storage/" target="_blank">JFrog storage specification page</a>: Artifactory 500→1000 GB, Xray 100→200 GB, RabbitMQ 100 GB, JAS 300 GB; Artifactory DB = 1/3 of filestore at 4K–20K IOPS; Xray DB 500–2500 GB at 4K–12K IOPS.</p>
      <p><strong>Co-location (VMs)</strong>: On VMs, Distribution co-locates on each Artifactory host (+2 vCPU / +2 GB / +200 GB per node — those numbers are added to the Artifactory row). AppTrust + UnifiedPolicy also co-locate on Artifactory VMs (+4 vCPU / +2 GB / +100 GB per node). Artifactory, Nginx, and Xray each require a dedicated VM per replica. JAS on VMs requires dedicated servers separate from Xray. RabbitMQ runs split (separate VMs) for Xray HA or &gt;100K artifacts.</p>
      <p><strong>Co-location (Kubernetes)</strong>: On Kubernetes, Distribution is a separate StatefulSet pod with its own PVC (5 GB / 20 GB HA); pod limits 1 vCPU / 2 GB. AppTrust and UnifiedPolicy are separate pods that share the Artifactory node pool (no dedicated pool); their pod limits (AppTrust 1 CPU / 2 GB, UnifiedPolicy 0.5 CPU / 1 GB) are included in the pool capacity total. JAS runs within the Xray Helm chart (no extra node pool). <strong>Mission Control</strong> is bundled into the Artifactory router — no standalone node or database on any deployment model. <strong>Workers</strong> (4 CPU / 4 GB / 50 GB) and <strong>Runtime Security</strong> always get dedicated nodes. Workers and Runtime are not part of the <code>jfrog-platform</code> umbrella chart.</p>
      <p><strong>Onprem</strong>: JFrog does not publish a dedicated onprem sizing table, so this calculator mirrors the cloud CPU/RAM as generic VM sizes.</p>
      <p><strong>VM vs Kubernetes</strong>: capacity numbers are identical — they describe the worker-node footprint either way. On Kubernetes, per-pod <code>requests</code>/<code>limits</code> come from the JFrog Helm chart sizing presets and are typically smaller than the full VM allocation.</p>
    </details>
  `;

  document.getElementById("output").innerHTML = html;

  const artifactBtn = document.getElementById("artifactBtn");
  if (artifactBtn) artifactBtn.onclick = () => downloadArtifact(r);

  const diagramBtn = document.getElementById("diagramBtn");
  if (diagramBtn) diagramBtn.onclick = () => downloadText(`jfrog-site-architecture-${r.cloud}-${r.tier}-${new Date().toISOString().slice(0, 10)}.svg`, buildArchitectureDiagram(r), "image/svg+xml");
}

/* ---------- Wire up ---------- */

document.getElementById("exportBtn").addEventListener("click", () => downloadXlsx(lastResult));
document.getElementById("inputs").addEventListener("change", calculate);
document.getElementById("inputs").addEventListener("input", (e) => {
  const topology = document.querySelector('input[name="topology"]:checked').value;
  const passiveScale = document.querySelector('input[name="passiveScale"]:checked')?.value || "hot";
  const ha = document.querySelector('input[name="ha"]:checked').value === "yes";
  if (e.target.id === "licensePurchased") {
    const total = parseInt(e.target.value, 10);
    if (total > 0) syncLicenseSplitFields(total, topology, passiveScale, ha, true);
  } else if (e.target.id === "licensePrimary") {
    const total = parseInt(document.getElementById("licensePurchased").value, 10) || 0;
    const primary = parseInt(e.target.value, 10) || 0;
    const secondaryEl = document.getElementById("licenseSecondary");
    if (total > 0 && secondaryEl) secondaryEl.value = Math.max(0, total - primary);
    if (total > 0) lastLicenseSplitKey = licenseSplitContextKey(total, topology, passiveScale, ha);
  } else if (e.target.id === "licenseSecondary") {
    const total = parseInt(document.getElementById("licensePurchased").value, 10) || 0;
    const secondary = parseInt(e.target.value, 10) || 0;
    const primaryEl = document.getElementById("licensePrimary");
    if (total > 0 && primaryEl) primaryEl.value = Math.max(0, total - secondary);
    if (total > 0) lastLicenseSplitKey = licenseSplitContextKey(total, topology, passiveScale, ha);
  } else if (e.target.type === "number") {
    calculate();
    return;
  }
  calculate();
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

/* Load sizing-data.json for the latest JFrog-published numbers.
   Falls back to the hardcoded constants above when opened as file:// or when
   the file is unreachable (network error, missing file, etc.). */
fetch('./sizing-data.json')
  .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then(data => {
    if (data.REF_ARCH) REF_ARCH = data.REF_ARCH;
    if (data.STORAGE)  STORAGE  = data.STORAGE;
    if (data.REPLICAS) REPLICAS = data.REPLICAS;
    const badge = document.getElementById('data-freshness');
    if (badge && data.dataDate) badge.textContent = `Sizing data: ${data.dataDate}`;
    calculate();
  })
  .catch(() => calculate()); // Fallback: hardcoded constants are already set.

/* ---------- Input-panel tooltips ---------- */
(function initTooltips() {
  const bubble = document.createElement("div");
  bubble.id = "tooltip-bubble";
  document.body.appendChild(bubble);

  function move(e) {
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    const vw = window.innerWidth,  vh = window.innerHeight;
    let x = e.clientX + 16, y = e.clientY - Math.round(bh / 2);
    if (x + bw > vw - 8) x = e.clientX - bw - 12;
    if (y < 8) y = 8;
    if (y + bh > vh - 8) y = vh - bh - 8;
    bubble.style.left = x + "px";
    bubble.style.top  = y + "px";
  }

  document.querySelectorAll(".tip-icon").forEach(el => {
    el.addEventListener("mouseenter", e => {
      bubble.textContent = el.getAttribute("data-tip");
      bubble.classList.add("visible");
      move(e);
    });
    el.addEventListener("mousemove", move);
    el.addEventListener("mouseleave", () => bubble.classList.remove("visible"));
  });
})();
