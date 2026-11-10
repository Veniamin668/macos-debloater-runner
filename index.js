'use strict';
/**
 * macOS Runner Debloater
 *
 * Zero dependencies. Called from the composite action.yml via `node index.js`.
 *
 * How deletion works: every target is instantly renamed (mv) into a hidden folder on the
 * same APFS volume, and the real `rm -rf` runs in the background (3 workers). Huge trees
 * (Xcode = ~60k files) therefore never block the remaining steps.
 *
 * Safety: Tailscale and Sunshine/Apollo are never touched. The node/python that is currently
 * active in PATH (and the newest node/python family in Homebrew) are kept, so the script
 * never saws off the branch it is sitting on.
 */
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/* ───────────────────────── helpers ───────────────────────── */
const HOME = os.homedir();
const env = process.env;
const T0 = Date.now();

// Reads INPUT_XCODE_STRIP_PLATFORMS (composite) and INPUT_XCODE-STRIP-PLATFORMS (JS action).
const input = (n, d = '') => {
  const k = `INPUT_${n.toUpperCase()}`;
  const v = env[k.replace(/-/g, '_')] ?? env[k];
  return v == null || v.trim() === '' ? d : v.trim();
};
const bool = (n, d) => /^(true|1|yes|on)$/i.test(input(n, String(d)));
const list = (n) => input(n).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
const glob = (g) =>
  new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const gib = (kb) => (kb / 1048576).toFixed(2);
const secs = (t) => ((Date.now() - t) / 1000).toFixed(1);
const dur = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };

const DRY = bool('dry-run', false);
const SIZES = DRY || bool('report-sizes', false);

/* ───────────────────────── pretty output ───────────────────────── */
const COLOR = !env.NO_COLOR;
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint(1), dim = paint(2), red = paint(31), green = paint(32), yellow = paint(33), cyan = paint(36);
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const log = (s = '') => console.log(s);
const warn = (m) => console.log(`::warning::${m}`);

function box(title, lines) {
  const width = Math.max(strip(title).length, ...lines.map((l) => strip(l).length)) + 2;
  const pad = (s) => s + ' '.repeat(width - strip(s).length - 1);
  log(cyan('╭' + '─'.repeat(width) + '╮'));
  log(cyan('│') + ' ' + pad(bold(title)) + cyan('│'));
  log(cyan('├' + '─'.repeat(width) + '┤'));
  for (const l of lines) log(cyan('│') + ' ' + pad(l) + cyan('│'));
  log(cyan('╰' + '─'.repeat(width) + '╯'));
}

/* ───────────────────────── shell ───────────────────────── */
const ENV = {
  ...env,
  PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${env.PATH || ''}`,
  HOMEBREW_NO_AUTO_UPDATE: '1',
  HOMEBREW_NO_ANALYTICS: '1',
  HOMEBREW_NO_INSTALL_CLEANUP: '1',
  HOMEBREW_NO_ENV_HINTS: '1',
  NONINTERACTIVE: '1',
};

function sh(cmd, { timeout = 0 } = {}) {
  const r = cp.spawnSync('/bin/bash', ['-c', cmd], {
    encoding: 'utf8', env: ENV, maxBuffer: 1 << 28, timeout,
  });
  return { code: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
}

/* ───────────────────────── system auto-detection ───────────────────────── */
// Nothing to configure: macOS version, CPU architecture and Homebrew prefix are detected at runtime.
const SYS = (() => {
  const ver = sh('sw_vers -productVersion').out.trim() || '?';
  const arch = sh('uname -m').out.trim() || '?';
  const intel = arch === 'x86_64';
  return { ver, major: parseInt(ver, 10) || 0, arch, intel, brewPrefix: intel ? '/usr/local' : '/opt/homebrew' };
})();

const sizeKB = (p) => Number(sh(`sudo -n du -sk ${q(p)} 2>/dev/null | cut -f1`).out.trim()) || 0;

function freeKB() {
  let r = sh('df -k /System/Volumes/Data | tail -1');
  if (r.code !== 0 || !r.out.trim()) r = sh('df -k / | tail -1');
  return Number(r.out.trim().split(/\s+/)[3]) || 0;
}

/* Versions: "27" == "27.0" == "27.0.0" */
const verKey = (s) => {
  const a = String(s).split('.').map((x) => parseInt(x, 10) || 0);
  while (a.length && a[a.length - 1] === 0) a.pop();
  return a;
};
const cmpVer = (a, b) => {
  const x = verKey(a), y = verKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
};

/* ───────────────────────── protection ───────────────────────── */
// Tailscale and Sunshine/Apollo are never touched.
const PROT_RE = /tailscale|sunshine|apollo/i;
const PROT_PREFIX = [
  `${HOME}/actions-runner`, `${HOME}/work`, `${HOME}/bootstrap`,
  env.RUNNER_TEMP, env.GITHUB_WORKSPACE, ...list('keep-paths'),
].filter(Boolean).map((p) => path.resolve(p));

const isProtected = (p) => {
  const r = path.resolve(p);
  return PROT_RE.test(r) ||
    PROT_PREFIX.some((x) => r === x || r.startsWith(x + '/') || x.startsWith(r + '/'));
};

/* ───────────────────────── deletion engine ───────────────────────── */
const TRASH = '/private/var/tmp/.debloat-trash';
const rows = [];          // { cat, p, kb }
const jobs = [];          // background rm promises
const timeline = [];      // per-step stats for the summary
const kept = [];          // protected paths that were skipped
let seq = 0, running = 0;
const waiting = [];

function bgRm(target) {
  return new Promise((resolve) => {
    const go = () => {
      running++;
      const c = cp.spawn('sudo', ['-n', 'rm', '-rf', target], { stdio: 'ignore' });
      c.on('close', () => { running--; const n = waiting.shift(); if (n) n(); resolve(); });
    };
    if (running < 3) go(); else waiting.push(go);
  });
}

function remove(p, cat, quiet = false) {
  const st = lstat(p);
  if (!st) return false;
  if (isProtected(p)) {
    kept.push(p);
    if (!quiet) log(`  ${cyan('keep')} ${p} ${dim('(protected)')}`);
    return false;
  }
  const kb = SIZES && !st.isSymbolicLink() ? sizeKB(p) : 0;
  rows.push({ cat, p, kb });
  if (!quiet) log(`  ${DRY ? yellow('would remove') : red('remove')} ${p}${kb ? dim(`  ${gib(kb)} GiB`) : ''}`);
  if (DRY) return true;
  const dest = `${TRASH}/${seq++}-${path.basename(p)}`;
  const r = sh(`sudo -n mkdir -p ${q(TRASH)} && sudo -n mv ${q(p)} ${q(dest)}`);
  jobs.push(bgRm(r.code === 0 ? dest : p));
  return true;
}

// Removes every child of a directory (so protected children survive), logs one summary line.
function wipeContents(dir, cat) {
  if (!lstat(dir)) return;
  let kids = [];
  try { kids = fs.readdirSync(dir); } catch { return; }
  const r0 = rows.length;
  for (const k of kids) remove(path.join(dir, k), cat, true);
  const added = rows.slice(r0);
  const kb = added.reduce((a, r) => a + r.kb, 0);
  if (added.length) log(`  ${DRY ? yellow('would clean') : red('clean')} ${dir}/*  ${dim(`${added.length} entries${kb ? `, ${gib(kb)} GiB` : ''}`)}`);
}

const step = (icon, name, fn) => {
  const t = Date.now(), r0 = rows.length;
  log(`::group::${icon}  ${name}`);
  try { fn(); } catch (e) { warn(`${name}: ${e.message}`); }
  const added = rows.slice(r0);
  const kb = added.reduce((a, r) => a + r.kb, 0);
  timeline.push({ icon, name, n: added.length, kb, t: secs(t) });
  log(dim(`  → ${added.length} item(s) ${DRY ? 'would be removed' : 'removed'}${kb ? `, ~${gib(kb)} GiB` : ''} · ${secs(t)}s`));
  log('::endgroup::');
};

/* ───────────────────────── disk analysis ───────────────────────── */
function analyze() {
  if (!(DRY || bool('analyze', false))) { log(dim('  skipped (set analyze: true to enable)')); return; }
  for (const d of ['/Applications', '/Library', HOME, '/opt', '/usr/local', '/private/var']) {
    const r = sh(`sudo -n du -xk -d1 ${q(d)} 2>/dev/null | sort -rn | head -12`, { timeout: 900000 });
    log(`\n${bold(d)}`);
    for (const line of r.out.trim().split('\n').filter(Boolean)) {
      const [kb, ...rest] = line.split('\t');
      log(`  ${gib(Number(kb)).padStart(8)} GiB  ${rest.join('\t')}`);
    }
  }
}

/* ───────────────────────── Xcode ───────────────────────── */
function planXcode() {
  const want = input('xcode', 'default').toLowerCase().replace(/^xcode_?/, '').replace(/\.app$/, '');
  if (want === 'all') return { skip: true, want };

  let names = [];
  try { names = fs.readdirSync('/Applications').filter((n) => /^Xcode.*\.app$/.test(n)); } catch { /* */ }
  const entries = names.map((n) => {
    const p = `/Applications/${n}`;
    const link = lstat(p).isSymbolicLink();
    let real = null;
    try { real = fs.realpathSync(p); } catch { /* dangling symlink */ }
    return { p, name: n, link, real, ver: (n.match(/^Xcode_([\d.]+)\.app$/) || [])[1] };
  });
  const dirs = entries.filter((e) => !e.link && e.real);

  let keep = null;
  if (want === 'none') {
    keep = null;
  } else if (want === 'default') {
    const d = entries.find((e) => e.name === 'Xcode.app');
    keep = d && d.real;
    if (!keep) throw new Error('Xcode.app not found - use xcode: latest, a version, or none');
  } else if (want === 'latest') {
    const top = dirs.filter((e) => e.ver).sort((a, b) => cmpVer(b.ver, a.ver))[0];
    keep = top && top.real;
    if (!keep) throw new Error('No Xcode_*.app found for "latest"');
  } else {
    const m = entries.find((e) => e.real && e.ver && cmpVer(e.ver, want) === 0);
    keep = m && m.real;
    if (!keep) {
      const have = [...new Set(entries.filter((e) => e.ver).map((e) => e.ver))].join(', ');
      throw new Error(`Xcode "${want}" not found. Installed: ${have || 'none'}`);
    }
  }
  return { skip: false, want, keep, entries };
}

function applyXcode(plan) {
  if (plan.skip) { log('  xcode=all → leaving every Xcode untouched'); return; }
  const { keep, entries } = plan;
  log(`  keeping: ${keep ? green(keep) : yellow('nothing (all Xcode versions go)')}`);

  for (const e of entries) {
    if (keep && e.real === keep) continue;      // keep the bundle and all of its symlinks
    remove(e.p, 'Xcode');
  }

  if (keep && !DRY) {
    const cur = (() => { try { return fs.realpathSync('/Applications/Xcode.app'); } catch { return null; } })();
    if (cur !== keep) sh(`sudo -n ln -sfn ${q(keep)} /Applications/Xcode.app`);
    const r = sh(`sudo -n xcode-select -s ${q(keep + '/Contents/Developer')}`);
    if (r.code !== 0) warn(`xcode-select: ${r.err.trim()}`);
  } else if (!keep && !DRY && fs.existsSync('/Library/Developer/CommandLineTools')) {
    sh('sudo -n xcode-select -s /Library/Developer/CommandLineTools');
    log('  xcode-select → Command Line Tools');
  }

  // Strip extra platforms from the kept Xcode.
  const platforms = list('xcode-strip-platforms').map((s) => s.toLowerCase());
  if (keep && platforms.length) {
    const MAP = {
      ios: ['iPhoneOS', 'iPhoneSimulator'],
      tvos: ['AppleTVOS', 'AppleTVSimulator'],
      watchos: ['WatchOS', 'WatchSimulator'],
      visionos: ['XROS', 'XRSimulator'],
      driverkit: ['DriverKit'],
    };
    const wanted = platforms.includes('all') ? Object.values(MAP).flat()
      : platforms.flatMap((s) => MAP[s] || []);
    for (const n of wanted) remove(`${keep}/Contents/Developer/Platforms/${n}.platform`, 'Xcode platforms');
  }
}

function simulators() {
  if (!bool('simulators', true)) { log(dim('  disabled')); return; }
  if (!DRY) {
    // On macOS 26+/27 runtimes are mounted disk images - unmount them before deleting.
    sh('sudo -n xcrun simctl runtime delete all', { timeout: 300000 });
    sh('sudo -n killall -9 com.apple.CoreSimulator.CoreSimulatorService');
    const mounts = [...sh('mount').out.matchAll(/ on (\/Library\/Developer\/CoreSimulator\/[^\s(]+) \(/g)].map((m) => m[1]);
    for (const mp of mounts) {
      log(`  unmount ${mp}`);
      sh(`sudo -n diskutil unmount force ${q(mp)} || sudo -n hdiutil detach -force ${q(mp)}`);
    }
  }
  remove('/Library/Developer/CoreSimulator', 'Simulators');
  remove(`${HOME}/Library/Developer`, 'Simulators / DerivedData');
}

/* ───────────────────────── Homebrew ───────────────────────── */
function brewUninstall(B, kind, names) {
  if (!names.length) return;
  const flags = kind === 'cask' ? '--cask --force' : '--formula --force --ignore-dependencies';
  const r = sh(`${B} uninstall ${flags} ${names.map(q).join(' ')}`, { timeout: 1800000 });
  if (r.code === 0) return;
  log('  batch uninstall failed, retrying one by one');
  for (const n of names) {
    const x = sh(`${B} uninstall ${flags} ${q(n)}`, { timeout: 600000 });
    if (x.code !== 0) warn(`brew uninstall ${n}: ${x.err.split('\n')[0]}`);
  }
}

function homebrew() {
  if (!bool('homebrew', true)) { log(dim('  disabled')); return; }
  const B = [`${SYS.brewPrefix}/bin/brew`, '/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((p) => fs.existsSync(p)) || 'brew';
  const short = (n) => n.split('/').pop();
  const full = (kind) => sh(`${B} list --${kind} --full-name -1`).out.split('\n').map((s) => s.trim()).filter(Boolean);
  const fFull = full('formula'), cFull = full('cask');
  const fShort = fFull.map(short), cShort = cFull.map(short);
  log(`  installed: ${fShort.length} formulae, ${cShort.length} casks`);

  /* 1. Protected set: tailscale/sunshine/apollo + their dependency closure + homebrew-keep */
  const keepGlobs = list('homebrew-keep').map(glob);
  const userKept = (n) => keepGlobs.some((g) => g.test(n));
  const seeds = new Set(fShort.filter((n) => PROT_RE.test(n)));
  for (const c of cShort.filter((n) => PROT_RE.test(n))) {
    try {
      const j = JSON.parse(sh(`${B} info --json=v2 --cask ${q(c)}`).out);
      for (const d of (j.casks?.[0]?.depends_on?.formula || [])) seeds.add(short(d));
    } catch { /* */ }
  }
  const closure = new Set(seeds);
  if (seeds.size) {
    for (const d of sh(`${B} deps --installed --union ${[...seeds].map(q).join(' ')}`).out.split('\n')) {
      if (d.trim()) closure.add(short(d.trim()));
    }
  }
  log(`  ${cyan('protected')} (tailscale/sunshine/apollo + deps): ${[...closure].join(', ') || '-'}`);

  /* 2. node@N and python@X.Y: keep the active one and the newest one */
  const cellarOf = (bin) => {
    const w = sh(`command -v ${bin}`).out.trim();
    if (!w) return null;
    try { const m = fs.realpathSync(w).match(/\/Cellar\/([^/]+)\//); return m && m[1]; } catch { return null; }
  };
  const nodeFs = fShort.filter((n) => /^node(@\d+)?$/.test(n));
  const pyFs = fShort.filter((n) => /^python@\d+\.\d+$/.test(n));
  const nodeKey = (n) => (n === 'node' ? 1e9 : Number(n.split('@')[1]));
  const keepFam = new Set([cellarOf('node'), cellarOf('python3')].filter(Boolean));
  if (nodeFs.length) keepFam.add([...nodeFs].sort((a, b) => nodeKey(b) - nodeKey(a))[0]);
  if (pyFs.length) keepFam.add([...pyFs].sort((a, b) => cmpVer(b.split('@')[1], a.split('@')[1]))[0]);
  const oldFam = [...nodeFs, ...pyFs].filter((n) => !keepFam.has(n));
  log(`  node/python kept: ${green([...keepFam].join(', ') || '-')}  ·  older: ${oldFam.join(', ') || '-'}`);

  /* 3. Deny lists */
  const browsers = bool('browsers', true), android = bool('android', true);
  const javaKeep = input('java-keep', '21').toLowerCase();
  const DENY_F = [
    /^gcc(@\d+)?$/, /^llvm(@\d+)?$/, /^azure-cli$/, /^awscli$/, /^aws-sam-cli$/,
    /^session-manager-plugin$/, /^bicep$/, /^packer$/, /^bazel(isk)?$/, /^azcopy$/,
    /^maven$/, /^ant$/, /^gradle$/, /^kotlin$/, /^carthage$/, /^cocoapods$/, /^fastlane$/,
    /^swiftformat$/, /^xcbeautify$/, /^xcodes$/,
    ...(browsers ? [/^selenium-server$/, /^chromedriver$/] : []),   // geckodriver stays (Firefox is kept)
  ];
  const DENY_C = [
    ...(browsers ? [/^google-chrome/, /^chromedriver$/, /^microsoft-edge/, /^selenium-server$/] : []),   // Firefox is kept
    ...(bool('powershell', true) ? [/^powershell/] : []),
    ...(android ? [/^android-/] : []),
    ...(bool('dotnet', true) ? [/^dotnet/] : []),
  ];
  const extra = list('homebrew-remove').map(glob);
  const hit = (n, deny) => deny.some((r) => r.test(n)) || extra.some((g) => g.test(n));

  const fRemove = fFull.filter((f, i) => {
    const n = fShort[i];
    if (closure.has(n) || userKept(n) || keepFam.has(n)) return false;
    return hit(n, DENY_F) || oldFam.includes(n);
  });
  const cRemove = cFull.filter((c, i) => {
    const n = cShort[i];
    if (PROT_RE.test(n) || userKept(n)) return false;
    const t = n.match(/^temurin(?:@(\d+))?$|^zulu(?:@(\d+))?$|^microsoft-openjdk(?:@(\d+))?$/);
    if (t && javaKeep !== 'all') {
      const ver = t[1] || t[2] || t[3];
      return !(javaKeep !== 'none' && ver === javaKeep);
    }
    return hit(n, DENY_C);
  });

  log(`  formulae to remove (${fRemove.length}): ${fRemove.join(' ') || '-'}`);
  log(`  casks to remove (${cRemove.length}): ${cRemove.join(' ') || '-'}`);
  rows.push(...[...fRemove, ...cRemove].map((n) => ({ cat: 'Homebrew', p: `brew:${n}`, kb: 0 })));
  if (DRY) { log(dim('  [dry-run] autoremove / cleanup skipped')); return; }

  brewUninstall(B, 'cask', cRemove);
  brewUninstall(B, 'formula', fRemove);

  /* 4. autoremove, minus the protected set */
  const ar = sh(`${B} autoremove --dry-run`).out.split('\n')
    .map((s) => s.trim()).filter((s) => s && !s.startsWith('==>') && !/\s/.test(s));
  const orphans = ar.filter((n) => !closure.has(short(n)) && !keepFam.has(short(n)) && !userKept(short(n)));
  log(`  orphaned dependencies (${orphans.length}): ${orphans.join(' ') || '-'}`);
  brewUninstall(B, 'formula', orphans);

  sh(`${B} cleanup --prune=all -s`, { timeout: 600000 });
  const cache = sh(`${B} --cache`).out.trim();
  if (cache) wipeContents(cache, 'Homebrew cache');
}

/* ───────────────────────── hostedtoolcache ───────────────────────── */
function toolcache() {
  const root = env.RUNNER_TOOL_CACHE || `${HOME}/hostedtoolcache`;
  if (!lstat(root)) { log(dim('  toolcache not found')); return; }
  const dirs = fs.readdirSync(root);
  const find = (name) => dirs.find((d) => d.toLowerCase() === name.toLowerCase());

  for (const name of list('toolcache-keep-latest')) {
    const d = find(name);
    if (!d) continue;
    const vers = fs.readdirSync(path.join(root, d)).filter((v) => /^\d+(\.\d+)*/.test(v))
      .sort((a, b) => cmpVer(b.replace(/-.*$/, ''), a.replace(/-.*$/, '')));
    log(`  ${d}: keeping ${green(vers[0] || '-')}`);
    for (const v of vers.slice(1)) remove(path.join(root, d, v), `toolcache ${d}`);
  }
  for (const name of list('toolcache-remove')) {
    const d = find(name);
    if (d) remove(path.join(root, d), `toolcache ${d}`);
  }
}

/* ───────────────────────── everything else ───────────────────────── */
function android() {
  if (!bool('android', true)) { log(dim('  disabled')); return; }
  remove(`${HOME}/Library/Android`, 'Android SDK');
  remove(`${HOME}/.android`, 'Android SDK');
}

function java() {
  const keep = input('java-keep', '21').toLowerCase();
  if (keep === 'all') { log(dim('  java-keep=all → untouched')); return; }
  const base = '/Library/Java/JavaVirtualMachines';
  if (!lstat(base)) return;
  const re = new RegExp(`(^|[^0-9])${keep}([^0-9]|$)`);
  for (const n of fs.readdirSync(base)) {
    if (keep !== 'none' && re.test(n)) { log(`  keeping ${green(n)}`); continue; }
    remove(`${base}/${n}`, 'Java');
  }
}

function dotnet() {
  if (!bool('dotnet', true)) { log(dim('  disabled')); return; }
  for (const p of ['/usr/local/share/dotnet', `${HOME}/.dotnet`, `${HOME}/.nuget`, '/usr/local/bin/dotnet']) remove(p, '.NET');
}

function powershell() {
  if (!bool('powershell', true)) { log(dim('  disabled')); return; }
  for (const p of ['/usr/local/microsoft/powershell', '/usr/local/bin/pwsh', '/usr/local/share/powershell', `${HOME}/.local/share/powershell`]) remove(p, 'PowerShell');
}

function rust() {
  if (!bool('rust', true)) { log(dim('  disabled')); return; }
  remove(`${HOME}/.rustup`, 'Rust'); remove(`${HOME}/.cargo`, 'Rust');
}

function browsers() {
  if (!bool('browsers', true)) { log(dim('  disabled')); return; }
  for (const a of ['Google Chrome.app', 'Google Chrome for Testing.app', 'Microsoft Edge.app']) remove(`/Applications/${a}`, 'Browsers');   // Safari and Firefox are kept
  for (const p of [`/usr/local/share/chromedriver-mac-${SYS.intel ? 'x64' : 'arm64'}`, '/usr/local/share/chromedriver', '/usr/local/share/edge_driver',
    '/usr/local/bin/chromedriver', '/usr/local/bin/msedgedriver', '/usr/local/share/selenium']) remove(p, 'Browsers');
  for (const p of ['Google', 'Microsoft Edge']) remove(`${HOME}/Library/Application Support/${p}`, 'Browsers');
}

function caches() {
  if (!bool('caches', true)) { log(dim('  disabled')); return; }
  for (const d of [`${HOME}/Library/Caches`, `${HOME}/Library/Logs`, `${HOME}/.cache`, `${HOME}/.npm`,
    `${HOME}/.gradle`, `${HOME}/.m2`, `${HOME}/.cocoapods`]) wipeContents(d, 'Caches');
}

function misc() {
  if (!bool('misc', true)) { log(dim('  disabled')); return; }
  remove(env.VCPKG_INSTALLATION_ROOT || '/usr/local/share/vcpkg', 'Misc');
  remove(`${HOME}/image-generation`, 'Misc');
  remove(`${HOME}/actionarchivecache`, 'Misc');
}

/* ───────────────────────── step summary (markdown) ───────────────────────── */
function writeSummary({ before, after, freed, estimate, macos, arch, plan }) {
  const bar = (v, max) => '█'.repeat(max ? Math.max(1, Math.round((v / max) * 20)) : 0);
  let md = `## 🧹 macOS Runner Debloater${DRY ? ' · dry run' : ''}\n\n`;
  md += `\`macOS ${macos}\` · \`${arch}\` · Xcode policy: \`${plan.skip ? 'all (untouched)' : plan.keep ? path.basename(plan.keep) : 'none'}\`\n\n`;
  md += `| | GiB |\n|---|---:|\n| Free before | ${gib(before)} |\n`;
  if (DRY) {
    md += `| Estimated reclaimable | **~${gib(estimate)}** |\n\n`;
  } else {
    md += `| Free after | ${gib(after)} |\n| **Freed** | **${gib(freed)}** |\n\n`;
  }
  const byCat = {};
  for (const r of rows) byCat[r.cat] = (byCat[r.cat] || 0) + r.kb;
  const cats = Object.entries(byCat).filter(([, kb]) => kb > 0).sort((a, b) => b[1] - a[1]);
  if (cats.length) {
    const max = cats[0][1];
    md += `### Biggest wins\n\n| Category | GiB | |\n|---|---:|---|\n`;
    for (const [c, kb] of cats) md += `| ${c} | ${gib(kb)} | ${bar(kb, max)} |\n`;
    md += '\n';
  }
  md += `### Steps\n\n| Step | Items | Time |\n|---|---:|---:|\n`;
  for (const s of timeline) md += `| ${s.icon} ${s.name} | ${s.n} | ${s.t}s |\n`;
  md += `\n<sub>Total ${dur(Date.now() - T0)} · Tailscale and Sunshine/Apollo are always kept.</sub>\n`;
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md);
}

/* ───────────────────────── main ───────────────────────── */
(async () => {
  const plan = planXcode();            // throws BEFORE any deletion if the requested version is missing
  const macos = SYS.ver, arch = SYS.arch;
  const before = freeKB();

  box(`macOS Runner Debloater${DRY ? '  [DRY RUN]' : ''}`, [
    `Runner       macOS ${macos} (${arch}${SYS.intel ? ', Intel' : ', Apple silicon'})  ·  detected automatically`,
    `Free space   ${bold(gib(before) + ' GiB')}`,
    `Xcode        ${plan.skip ? 'untouched' : plan.keep ? 'keep ' + path.basename(plan.keep) : 'remove all'}`,
    `Always kept  Tailscale, Sunshine/Apollo, latest node & python`,
  ]);

  if (!DRY && bool('disable-spotlight', true)) sh('sudo -n mdutil -a -i off');

  step('🔍', 'Disk analysis', analyze);
  step('📱', 'Simulators', simulators);          // must run before Xcode removal (needs xcrun)
  step('🔧', 'Xcode', () => applyXcode(plan));
  step('🍺', 'Homebrew', homebrew);
  step('📦', 'Tool cache', toolcache);
  step('🤖', 'Android SDK', android);
  step('☕', 'Java', java);
  step('🟣', '.NET', dotnet);
  step('💠', 'PowerShell', powershell);
  step('🦀', 'Rust', rust);
  step('🌐', 'Browsers', browsers);
  step('🧽', 'Caches', caches);
  step('📁', 'Misc', misc);

  log('Waiting for background deletion to finish…');
  await Promise.all(jobs);
  if (!DRY) sh(`sudo -n rm -rf ${q(TRASH)}`);

  const after = freeKB();
  const freed = after - before;
  const estimate = rows.reduce((a, r) => a + r.kb, 0);

  log();
  box(DRY ? 'Dry run complete - nothing was deleted' : 'Done', DRY ? [
    `Free space     ${gib(before)} GiB`,
    `Reclaimable    ${green('~' + gib(estimate) + ' GiB')}`,
    `Duration       ${dur(Date.now() - T0)}`,
  ] : [
    `Free before   ${gib(before)} GiB`,
    `Free after    ${bold(gib(after) + ' GiB')}`,
    `Freed         ${green('+' + gib(freed) + ' GiB')}`,
    `Duration      ${dur(Date.now() - T0)}`,
  ]);
  log(`::notice title=macOS Runner Debloater::${DRY ? `Estimated reclaimable ~${gib(estimate)} GiB` : `Freed ${gib(freed)} GiB (${gib(before)} -> ${gib(after)} GiB free)`}`);

  writeSummary({ before, after, freed, estimate, macos, arch, plan });
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, `freed-gb=${gib(freed)}\nfree-before-gb=${gib(before)}\nfree-after-gb=${gib(after)}\n`);
  }
})().catch((e) => {
  console.log(`::error title=macOS Runner Debloater::${e.message}`);
  process.exit(1);
});
