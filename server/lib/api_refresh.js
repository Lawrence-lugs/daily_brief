/** Start API-feed ingestion in a detached brief worker.
 *
 * The worker uses the same CLI path as an explicit --refresh-api-feeds run,
 * which persists fetched API items into the shared candidate pool. Keep it
 * detached so normal brief generation does not wait on slow API endpoints.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export function startApiRefreshWorker({
  projectRoot,
  dataDir,
  specs,
  env = process.env,
  execPath = process.execPath,
  spawnProcess = spawn,
  onError = () => {},
} = {}) {
  const enabled = (specs ?? []).filter(spec =>
    spec?.kind === 'api' && (!spec.api_key_env || Boolean(env[spec.api_key_env]))
  );
  if (!enabled.length) return null;

  const script = join(projectRoot, 'scripts', 'run_brief.js');
  const child = spawnProcess(execPath, [script, '--refresh-api-feeds'], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...env,
      BRIEF_DATA_DIR: dataDir,
      ELECTRON_RUN_AS_NODE: '1',
    },
  });
  child.once?.('error', onError);
  child.unref?.();
  return { child, count: enabled.length };
}
