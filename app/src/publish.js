// Keeps the GitHub Pages verification site in step with the app: after an approval or revoke the
// server writes the site's files into a local clone of the site repository and pushes them.
// Uses the git credentials already saved on this computer, so no token is stored here.
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const CLONE_DIR = path.join(__dirname, '..', 'data', 'site-repo');
// The only paths the app writes in the repository; anything else there (README, app/) is left alone.
const MANAGED = ['index.html', '404.html', '.nojekyll', 'verify'];

// https://<owner>.github.io/<repo> -> https://github.com/<owner>/<repo>.git
function repoFor(siteUrl) {
  if (process.env.SITE_REPO) return process.env.SITE_REPO;
  const m = String(siteUrl || '').match(/^https?:\/\/([^./]+)\.github\.io\/([^/?#]+)/i);
  return m ? `https://github.com/${m[1]}/${m[2]}.git` : '';
}

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      // Never wait for a password prompt that nobody will answer.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim().split('\n').pop()}`));
      else resolve(stdout.trim());
    });
  });
}

async function syncClone(repo) {
  if (!fs.existsSync(path.join(CLONE_DIR, '.git'))) {
    fs.rmSync(CLONE_DIR, { recursive: true, force: true });
    await git(['clone', '--quiet', repo, CLONE_DIR]);
    return;
  }
  if (await git(['remote', 'get-url', 'origin'], CLONE_DIR) !== repo) await git(['remote', 'set-url', 'origin', repo], CLONE_DIR);
  // The clone is only written by this app, so match the remote exactly (keeps edits others made on GitHub).
  await git(['fetch', '--quiet', 'origin'], CLONE_DIR);
  const branch = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], CLONE_DIR).catch(() => 'origin/main'));
  await git(['reset', '--quiet', '--hard', branch], CLONE_DIR);
}

// files: [{ path, content }]. Adds and updates pages but never deletes one, so a printed QR code keeps working.
async function pushSite(repo, files) {
  await syncClone(repo);
  for (const f of files) {
    const dest = path.join(CLONE_DIR, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.content);
  }
  await git(['add', '--', ...MANAGED], CLONE_DIR);
  if (!(await git(['status', '--porcelain', '--', ...MANAGED], CLONE_DIR))) return false;
  await git(['commit', '--quiet', '-m', 'Update verification site'], CLONE_DIR);
  await git(['push', '--quiet', 'origin', 'HEAD'], CLONE_DIR);
  return true;
}

// One publish at a time; changes made while one is running are picked up by a single follow-up run.
const status = { state: 'idle', at: null, error: null, changed: null };
let running = null;
let again = false;

function publish(getFiles, siteUrl) {
  const repo = repoFor(siteUrl);
  if (!repo) return null;
  if (running) { again = true; return running; }
  running = (async () => {
    do {
      again = false;
      status.state = 'publishing';
      try {
        status.changed = await pushSite(repo, await getFiles());
        Object.assign(status, { state: 'ok', error: null, at: new Date().toISOString() });
        console.log(status.changed ? `Verification site published to ${repo}` : 'Verification site already up to date');
      } catch (e) {
        Object.assign(status, { state: 'error', error: e.message, at: new Date().toISOString() });
        console.error('Publishing the verification site failed:', e.message);
      }
    } while (again);
  })().finally(() => { running = null; });
  return running;
}

module.exports = { publish, repoFor, status };
