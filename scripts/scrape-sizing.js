#!/usr/bin/env node
'use strict';

/**
 * scrape-sizing.js
 *
 * Fetches the JFrog reference-architecture sizing pages, parses the HTML tables,
 * and updates sizing-data.json if anything changed.
 *
 * Exit codes:
 *   0 — no changes (sizing-data.json already up to date)
 *   1 — changes written to sizing-data.json (CI should open a PR)
 *   2 — parse/validation error (sizing-data.json not touched)
 *
 * Usage:
 *   node scripts/scrape-sizing.js [--dry-run]
 *
 * Requires Node >= 18 (native fetch). Install deps first: npm install (in scripts/).
 */

const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const DRY_RUN  = process.argv.includes('--dry-run');
const DATA_FILE = path.join(__dirname, '..', 'sizing-data.json');
const TIERS    = ['small', 'medium', 'large', 'xlarge', '2xlarge'];

const SOURCES = {
  aws:      'https://jfrog.com/reference-architecture/self-managed/deployment/sizing/aws/',
  azure:    'https://jfrog.com/reference-architecture/self-managed/deployment/sizing/azure/',
  gcp:      'https://jfrog.com/reference-architecture/self-managed/deployment/sizing/gcp/',
  storage:  'https://jfrog.com/reference-architecture/self-managed/deployment/sizing/storage/',
  rabbitmq: 'https://docs.jfrog.com/installation/docs/rabbitmq-split-for-xray',
};

/* ── HTTP helper ──────────────────────────────────────────────────────────── */

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; jpd-sizing-scraper/1.0; +https://github.com/rahulkj/jpd-sizing)',
      'Accept': 'text/html',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

/* ── Table parser ─────────────────────────────────────────────────────────── */

/**
 * Parse a single <table> into { rowLabel: [val0..val4] }.
 * Validates that the header row has the five tier columns in order.
 * Returns null if the table doesn't look like a sizing table.
 */
function parseTable($, table) {
  const rows = $(table).find('tr').toArray();
  if (rows.length < 2) return null;

  const headerCells = $(rows[0]).find('th, td').toArray().map(c =>
    $(c).text().trim().toLowerCase()
  );

  // Must have "size template" or tier names in the right slots.
  const expected = ['small', 'medium', 'large', 'xlarge', '2xlarge'];
  const tiersMatch = headerCells.slice(1, 6).every((c, i) =>
    c === expected[i] || c.replace(/\s+/g, '') === expected[i]
  );
  if (!tiersMatch) return null;

  const result = {};
  for (let i = 1; i < rows.length; i++) {
    const cells  = $(rows[i]).find('th, td').toArray();
    if (cells.length < 2) continue;
    const label  = $(cells[0]).text().trim();
    const values = cells.slice(1, 6).map(c => $(c).text().trim());
    if (label) result[label] = values;
  }
  return result;
}

/* ── Compute-page parser ──────────────────────────────────────────────────── */

/**
 * Parse an AWS/Azure/GCP sizing page.
 * Returns { arch: REF_ARCH[cloud], replicas: REPLICAS }.
 * replicas is identical across clouds — the caller picks one set (AWS).
 */
function parseComputePage(html) {
  const $ = cheerio.load(html);

  const arch = {
    artifactory: {}, nginx:  {}, xray: {}, rabbitmq: {}, jas: {},
    artifactoryDb: {}, xrayDb: {},
  };
  // JAS replicas are not published on the sizing pages — always 1.
  const replicas = {
    artifactory: {}, nginx: {}, xray: {}, rabbitmq: {},
    jas: Object.fromEntries(TIERS.map(t => [t, 1])),
  };

  let section  = null; // 'artifactory' | 'xray'
  let lastKey  = null; // last instance-row key, for the following vCPU/Memory rows

  $('h2, h3, h4, table').each((_, el) => {
    const tag  = el.tagName.toLowerCase();

    if (tag !== 'table') {
      const text = $(el).text().trim().toLowerCase();
      if      (text === 'artifactory' || text.startsWith('artifactory ')) section = 'artifactory';
      else if (text === 'xray'        || text.startsWith('xray '))        section = 'xray';
      return;
    }

    if (!section) return;

    const rows = parseTable($, el);
    if (!rows) return;

    for (const [label, vals] of Object.entries(rows)) {
      const lc = label.toLowerCase().replace(/\s+/g, ' ').trim();

      // ── Replica counts ────────────────────────────────────────────────────
      if (lc.includes('number of artifactory replicas')) {
        TIERS.forEach((t, i) => { replicas.artifactory[t] = parseInt(vals[i]) || 0; });
      } else if (lc.includes('number of nginx replicas')) {
        TIERS.forEach((t, i) => { replicas.nginx[t] = parseInt(vals[i]) || 0; });
      } else if (lc.includes('number of xray replicas')) {
        TIERS.forEach((t, i) => { replicas.xray[t] = parseInt(vals[i]) || 0; });
      } else if (lc.includes('number of rabbitmq replicas')) {
        TIERS.forEach((t, i) => { replicas.rabbitmq[t] = parseInt(vals[i]) || 0; });

      // ── Instance-type rows ────────────────────────────────────────────────
      } else if (lc.includes('artifactory node pool instance')) {
        lastKey = 'artifactory';
        TIERS.forEach((t, i) => { arch.artifactory[t] = { instance: vals[i] }; });
      } else if (lc.includes('nginx node pool instance')) {
        lastKey = 'nginx';
        TIERS.forEach((t, i) => { arch.nginx[t] = { instance: vals[i] }; });
      } else if (lc.includes('xray node pool instance')) {
        lastKey = 'xray';
        TIERS.forEach((t, i) => { arch.xray[t] = { instance: vals[i] }; });
      } else if (lc.includes('rabbitmq node pool instance')) {
        lastKey = 'rabbitmq';
        TIERS.forEach((t, i) => { arch.rabbitmq[t] = { instance: vals[i] }; });
      } else if (lc.includes('jas node pool instance')) {
        lastKey = 'jas';
        TIERS.forEach((t, i) => { arch.jas[t] = { instance: vals[i] }; });
      } else if (
        (lc.includes('postgresql') || lc.includes('cloud sql') || lc.includes('flexible server')) &&
        lc.includes('instance')
      ) {
        // Disambiguate Artifactory DB vs Xray DB by current section.
        const dbKey = section === 'artifactory' ? 'artifactoryDb' : 'xrayDb';
        lastKey = dbKey;
        TIERS.forEach((t, i) => { arch[dbKey][t] = { instance: vals[i] }; });

      // ── CPU / Memory / MaxConns rows (context: lastKey) ───────────────────
      } else if (lc === 'vcpu' && lastKey && arch[lastKey]) {
        TIERS.forEach((t, i) => {
          if (arch[lastKey][t]) arch[lastKey][t].cpu = parseInt(vals[i]) || 0;
        });
      } else if (lc === 'memory' && lastKey && arch[lastKey]) {
        TIERS.forEach((t, i) => {
          if (arch[lastKey][t]) arch[lastKey][t].memGB = parseInt(vals[i]) || 0;
        });
      } else if (lc === 'max connections' && lastKey && arch[lastKey]) {
        TIERS.forEach((t, i) => {
          if (arch[lastKey][t]) arch[lastKey][t].maxConns = parseInt(vals[i].replace(/,/g, '')) || 0;
        });
      }
    }
  });

  return { arch, replicas };
}

/* ── Storage-page parser ──────────────────────────────────────────────────── */

function parseStoragePage(html) {
  const $ = cheerio.load(html);

  const storage = {};
  ['artifactory', 'xray', 'rabbitmq', 'jas', 'artifactoryDb', 'xrayDb'].forEach(k => {
    storage[k] = {};
    TIERS.forEach(t => { storage[k][t] = {}; });
  });

  let section   = null; // 'artifactory' | 'xray'
  let component = null; // current component being written

  $('h2, h3, h4, table').each((_, el) => {
    const tag = el.tagName.toLowerCase();

    if (tag !== 'table') {
      const text = $(el).text().trim().toLowerCase();
      if      (text === 'artifactory' || text.startsWith('artifactory ')) { section = 'artifactory'; component = 'artifactory'; }
      else if (text === 'xray'        || text.startsWith('xray '))        { section = 'xray';        component = 'xray'; }
      return;
    }

    if (!section) return;

    const rows = parseTable($, el);
    if (!rows) return;

    for (const [label, vals] of Object.entries(rows)) {
      const lc = label.toLowerCase().replace(/\s+/g, ' ').trim();

      // Determine which component this row belongs to.
      let comp;
      if      (lc.includes('rabbitmq'))      comp = 'rabbitmq';
      else if (lc.includes('jas'))           comp = 'jas';
      else if (lc.includes('postgresql') || lc.includes('postgres') || lc.includes('cloud sql')) {
        comp = section === 'artifactory' ? 'artifactoryDb' : 'xrayDb';
      } else comp = component;

      if (!storage[comp]) continue;

      if (lc.includes('disk size') || (lc.includes('disk') && lc.includes('(gb)'))) {
        TIERS.forEach((t, i) => {
          const v = vals[i].toLowerCase();
          if (v.includes('1/3') || v.includes('filestore')) {
            storage[comp][t].frac = 1 / 3;
          } else {
            storage[comp][t].gb = parseInt(vals[i]) || 0;
          }
        });
      } else if (lc.includes('iops')) {
        TIERS.forEach((t, i) => {
          storage[comp][t].iops = parseInt(vals[i].replace(/,/g, '')) || 0;
        });
      } else if (lc.includes('throughput')) {
        TIERS.forEach((t, i) => {
          storage[comp][t].mbps = parseInt(vals[i].replace(/,/g, '')) || 0;
        });
      }
    }
  });

  return storage;
}

/* ── RabbitMQ-specific page parser ───────────────────────────────────────── */

/**
 * Parse the dedicated RabbitMQ split-deployment page.
 * The page has a simple (non-tiered) hardware table with minimum specs:
 *   Node Type | CPU | RAM (GB) | Disk Size (GB)
 * Returns { diskGB, cpu, memGB } for the RabbitMQ row, or null if unparseable.
 *
 * The storage page only shows 100 GB for RabbitMQ; this page documents
 * the correct 250 GB minimum. We use the higher value.
 */
function parseRabbitMQPage(html) {
  const $ = cheerio.load(html);
  let result = null;

  $('table').each((_, table) => {
    const rows = $(table).find('tr').toArray();
    // Look for a table whose header contains "Node Type" or "CPU"
    const firstRow = $(rows[0]).find('th, td').toArray().map(c => $(c).text().trim().toLowerCase());
    const hasCpuCol = firstRow.some(h => h === 'cpu');
    if (!hasCpuCol) return;

    for (let i = 1; i < rows.length; i++) {
      const cells = $(rows[i]).find('td, th').toArray().map(c => $(c).text().trim());
      const nodeType = cells[0]?.toLowerCase() ?? '';
      if (!nodeType.includes('rabbitmq')) continue;

      // Find column indices dynamically
      const cpuIdx    = firstRow.findIndex(h => h === 'cpu');
      const ramIdx    = firstRow.findIndex(h => h.includes('ram') || h.includes('memory'));
      const diskIdx   = firstRow.findIndex(h => h.includes('disk'));

      const cpu    = cpuIdx  >= 0 ? parseInt(cells[cpuIdx])  : null;
      const memGB  = ramIdx  >= 0 ? parseInt(cells[ramIdx])  : null;
      const diskGB = diskIdx >= 0 ? parseInt(cells[diskIdx]) : null;

      if (cpu && memGB && diskGB) {
        result = { cpu, memGB, diskGB };
        return false; // stop .each
      }
    }
  });

  return result;
}

/* ── Onprem derivation ────────────────────────────────────────────────────── */

/**
 * Derive onprem REF_ARCH from the cloud arch — use CPU/RAM but replace instance
 * names with generic "VM X vCPU / Y GB" labels (JFrog doesn't publish onprem SKUs).
 */
function deriveOnprem(cloudArch) {
  const onprem = {};
  for (const [role, tiers] of Object.entries(cloudArch)) {
    onprem[role] = {};
    for (const [tier, spec] of Object.entries(tiers)) {
      const label = role.endsWith('Db')
        ? `PostgreSQL VM ${spec.cpu} vCPU / ${spec.memGB} GB`
        : `VM ${spec.cpu} vCPU / ${spec.memGB} GB`;
      onprem[role][tier] = { instance: label, cpu: spec.cpu, memGB: spec.memGB };
      if (spec.maxConns !== undefined) onprem[role][tier].maxConns = spec.maxConns;
    }
  }
  return onprem;
}

/* ── Validation ───────────────────────────────────────────────────────────── */

function validate(data) {
  const errors = [];
  const clouds  = ['aws', 'azure', 'gcp'];
  const roles   = ['artifactory', 'nginx', 'xray', 'rabbitmq', 'jas', 'artifactoryDb', 'xrayDb'];
  const numericFields = ['cpu', 'memGB'];

  for (const cloud of clouds) {
    for (const role of roles) {
      for (const tier of TIERS) {
        const entry = data.REF_ARCH?.[cloud]?.[role]?.[tier];
        if (!entry) {
          errors.push(`Missing REF_ARCH.${cloud}.${role}.${tier}`);
          continue;
        }
        if (!entry.instance) {
          errors.push(`Missing instance: REF_ARCH.${cloud}.${role}.${tier}.instance`);
        }
        for (const f of numericFields) {
          if (!entry[f] || entry[f] <= 0) {
            errors.push(`Zero/missing REF_ARCH.${cloud}.${role}.${tier}.${f} = ${entry[f]}`);
          }
        }
      }
    }
  }

  // Validate REPLICAS
  const replicaRoles = ['artifactory', 'nginx', 'xray', 'rabbitmq'];
  for (const role of replicaRoles) {
    for (const tier of TIERS) {
      const v = data.REPLICAS?.[role]?.[tier];
      if (!v || v <= 0) {
        errors.push(`Zero/missing REPLICAS.${role}.${tier} = ${v}`);
      }
    }
  }

  return errors;
}

/* ── Deep diff ────────────────────────────────────────────────────────────── */

function deepDiff(a, b, path = '') {
  const changes = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) {
    const fp = path ? `${path}.${key}` : key;
    const av = (a ?? {})[key];
    const bv = (b ?? {})[key];
    if (
      typeof av === 'object' && av !== null &&
      typeof bv === 'object' && bv !== null
    ) {
      changes.push(...deepDiff(av, bv, fp));
    } else if (av !== bv) {
      changes.push(`  ${fp}: ${JSON.stringify(av)} → ${JSON.stringify(bv)}`);
    }
  }
  return changes;
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

async function main() {
  console.log('Fetching JFrog sizing pages…');

  const [awsHtml, azureHtml, gcpHtml, storageHtml, rmqHtml] = await Promise.all([
    fetchHtml(SOURCES.aws),
    fetchHtml(SOURCES.azure),
    fetchHtml(SOURCES.gcp),
    fetchHtml(SOURCES.storage),
    fetchHtml(SOURCES.rabbitmq),
  ]);

  console.log('Parsing pages…');

  const awsData   = parseComputePage(awsHtml);
  const azureData = parseComputePage(azureHtml);
  const gcpData   = parseComputePage(gcpHtml);
  const storage   = parseStoragePage(storageHtml);

  // The dedicated RabbitMQ page documents a 250 GB disk minimum — higher than
  // the 100 GB shown on the general storage page. Apply it as a floor.
  const rmqSpec = parseRabbitMQPage(rmqHtml);
  if (rmqSpec) {
    console.log(`RabbitMQ page: cpu=${rmqSpec.cpu} memGB=${rmqSpec.memGB} diskGB=${rmqSpec.diskGB}`);
    TIERS.forEach(t => {
      if (!storage.rabbitmq[t]) storage.rabbitmq[t] = {};
      if ((storage.rabbitmq[t].gb ?? 0) < rmqSpec.diskGB) {
        storage.rabbitmq[t].gb = rmqSpec.diskGB;
      }
    });
  } else {
    console.warn('Warning: could not parse RabbitMQ page — using storage-page values.');
  }

  // REPLICAS are cloud-agnostic — use the AWS parse (all clouds should agree).
  const REPLICAS = awsData.replicas;

  const REF_ARCH = {
    aws:    awsData.arch,
    azure:  azureData.arch,
    gcp:    gcpData.arch,
    onprem: deriveOnprem(awsData.arch),
  };

  const today   = new Date().toISOString().slice(0, 10);
  const newData = {
    _meta: {
      note: 'Generated by scripts/scrape-sizing.js — do not edit manually. Run `node scripts/scrape-sizing.js` to refresh from JFrog docs.',
      sources: SOURCES,
    },
    dataDate: today,
    REPLICAS,
    REF_ARCH,
    STORAGE: storage,
  };

  // Validate before touching the file.
  const errors = validate(newData);
  if (errors.length > 0) {
    console.error(`\nParse validation failed (${errors.length} error(s)):\n${errors.join('\n')}`);
    console.error('\nsizing-data.json was NOT updated.');
    process.exit(2);
  }

  // Diff against current file.
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) { /* first run */ }

  // Diff only the sizing data, not _meta or dataDate (date always changes).
  const { _meta: _n, dataDate: _nd, ...newCore }      = newData;
  const { _meta: _e, dataDate: _ed, ...existingCore } = (existing ?? {});
  const changes = deepDiff(existingCore, newCore);

  // Always stamp dataDate so the UI shows when data was last verified.
  if (!DRY_RUN) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(newData, null, 2) + '\n');
  }

  if (changes.length === 0) {
    console.log(`\nNo data changes — dataDate stamped as ${today}.`);
    process.exit(0); // No PR needed.
  }

  console.log(`\n${changes.length} data change(s) detected:`);
  console.log(changes.join('\n'));

  if (DRY_RUN) {
    console.log('\n--dry-run: sizing-data.json was NOT updated.');
    process.exit(1);
  }

  console.log(`\nUpdated: ${DATA_FILE}`);
  process.exit(1); // Signal to CI that a PR should be opened.
}

main().catch(err => {
  console.error('Scraper error:', err.message);
  process.exit(2);
});
