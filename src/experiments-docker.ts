import { request as httpRequest } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { digestBytes } from './experiments-contract.ts';
import { assertDockerIdentity, type RestrictedRequest } from './experiments-restricted-contract.ts';

type Backend = RestrictedRequest['backend'];
type Limits = RestrictedRequest['limits'];
type DockerStatus = 'completed' | 'setup_error' | 'process_error' | 'timeout' | 'output_limit' | 'cancelled' | 'cleanup_failed';
const apiVersion = '/v1.47';
const environment = ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', 'LANG=C', 'TZ=UTC', 'NODE_OPTIONS=', 'NODE_VERSION=', 'YARN_VERSION='];

export function dockerConfiguration(imageId: string, bundle: string, argv: string[], seccomp: string, owner: string) {
  return {
    Image: imageId, User: '1000:1000', WorkingDir: '/scratch', Hostname: 'autoreview',
    Entrypoint: ['/usr/local/bin/node'], Cmd: argv, Env: environment,
    AttachStdout: true, AttachStderr: true, AttachStdin: false, OpenStdin: false, Tty: false,
    Labels: { 'pi-auto-review.attempt': owner },
    HostConfig: {
      ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true', `seccomp=${seccomp}`],
      NetworkMode: 'none', IpcMode: 'private', CgroupnsMode: 'private', Init: true,
      Memory: 536870912, MemorySwap: 536870912, PidsLimit: 64, NanoCpus: 1000000000,
      ShmSize: 8388608, LogConfig: { Type: 'none', Config: {} },
      Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }, { Name: 'nofile', Soft: 128, Hard: 128 }],
      Mounts: [{ Type: 'bind', Source: bundle, Target: '/bundle', ReadOnly: true, BindOptions: { Propagation: 'rprivate', NonRecursive: true } }],
      Tmpfs: { '/scratch': 'rw,nosuid,nodev,noexec,size=64m,nr_inodes=4096,mode=0700,uid=1000,gid=1000' },
    },
  };
}

class DockerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function dockerJson(socketPath: string, method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({ socketPath, method, path: apiVersion + path, signal,
      headers: encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {},
    }, response => {
      const chunks: Buffer[] = [];
      let count = 0;
      response.on('data', (chunk: Buffer) => {
        count += chunk.length;
        if (count > 1048576) request.destroy(new Error('Docker control response exceeds its limit.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new DockerError(status, text.slice(0, 1000)));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch {
          reject(new Error('Malformed Docker control response.'));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Docker control request timed out.')));
    request.on('error', reject);
    request.end(encoded);
  });
}

type Inspection = {
  Id: string; Image: string; State: { ExitCode: number; Running: boolean; OOMKilled: boolean };
  Config: { User: string; Env: string[]; Entrypoint: string[]; Cmd: string[]; Labels: Record<string, string>; Tty: boolean };
  HostConfig: ReturnType<typeof dockerConfiguration>['HostConfig'] & { PidMode?: string; Binds?: string[]; Devices?: unknown[]; CapAdd?: string[]; PortBindings?: object };
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
};

function assertContainer(actual: Inspection, expected: ReturnType<typeof dockerConfiguration>) {
  const host = actual.HostConfig;
  if (actual.Image !== expected.Image || actual.Config.User !== expected.User || actual.Config.Tty
    || JSON.stringify(actual.Config.Entrypoint) !== JSON.stringify(expected.Entrypoint)
    || JSON.stringify(actual.Config.Cmd) !== JSON.stringify(expected.Cmd)
    || JSON.stringify([...actual.Config.Env].sort()) !== JSON.stringify([...expected.Env].sort())
    || actual.Config.Labels['pi-auto-review.attempt'] !== expected.Labels['pi-auto-review.attempt']
    || !host.ReadonlyRootfs || host.Privileged || host.PidMode
    || host.NetworkMode !== 'none' || host.IpcMode !== 'private' || host.CgroupnsMode !== 'private'
    || !host.Init || host.Memory !== 536870912 || host.MemorySwap !== 536870912 || host.PidsLimit !== 64
    || host.NanoCpus !== 1000000000 || host.ShmSize !== 8388608 || host.LogConfig.Type !== 'none'
    || JSON.stringify(host.CapDrop) !== '["ALL"]' || host.CapAdd?.length || host.Devices?.length
    || host.Binds?.length || Object.keys(host.PortBindings ?? {}).length
    || JSON.stringify(host.Tmpfs) !== JSON.stringify(expected.HostConfig.Tmpfs)
    || host.Ulimits.length !== expected.HostConfig.Ulimits.length
    || !expected.HostConfig.Ulimits.every(limit => host.Ulimits.some(actual => actual.Name === limit.Name && actual.Soft === limit.Soft && actual.Hard === limit.Hard))
    || !host.SecurityOpt.includes('no-new-privileges:true')
    || !host.SecurityOpt.includes(expected.HostConfig.SecurityOpt[1])) throw new Error('Docker did not enforce the requested profile.');
  const binds = actual.Mounts.filter(mount => mount.Type !== 'tmpfs');
  if (binds.length !== 1 || binds[0].RW || binds[0].Destination !== '/bundle'
    || binds[0].Source !== expected.HostConfig.Mounts[0].Source) throw new Error('Unexpected Docker mount.');
}

export class DockerFrames {
  private stdout: Buffer[] = [];
  private stderr: Buffer[] = [];
  private pending = Buffer.alloc(0);
  private size = 0;
  private frames = 0;
  private limit: number;
  constructor(limit: number) { this.limit = limit; }
  write(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 8) {
      const channel = this.pending[0];
      const length = this.pending.readUInt32BE(4);
      if (![1, 2].includes(channel) || !length || this.pending.subarray(1, 4).some(byte => byte !== 0)) throw new Error('Invalid Docker output frame.');
      if (length > this.limit - this.size) throw new Error('output_limit');
      if (this.pending.length < length + 8) return;
      if (++this.frames > 4096) throw new Error('Too many Docker output frames.');
      (channel === 1 ? this.stdout : this.stderr).push(Buffer.from(this.pending.subarray(8, 8 + length)));
      this.size += length;
      this.pending = this.pending.subarray(8 + length);
    }
  }
  finish(): void { if (this.pending.length) throw new Error('Truncated Docker output frame.'); }
  buffers() { return { stdout: Buffer.concat(this.stdout), stderr: Buffer.concat(this.stderr) }; }
}

function attachOutput(socketPath: string, id: string, limit: number, signal: AbortSignal) {
  const collector = new DockerFrames(limit);
  let stream: Readable | undefined;
  let finish: (error?: Error) => void;
  let finished = false;
  const done = new Promise<void>((resolve, reject) => {
    finish = error => {
      if (finished) return;
      finished = true;
      if (error) reject(error);
      else resolve();
    };
  });
  // Attach failure must be observed even if starting the container subsequently fails.
  void done.catch(() => {});
  const ready = new Promise<void>((resolve, reject) => {
    const consume = (source: Readable, head = Buffer.alloc(0)) => {
      stream = source;
      const data = (chunk: Buffer) => {
        try {
          collector.write(chunk);
        } catch (error) {
          finish(error as Error);
          source.destroy();
        }
      };
      const end = () => {
        try {
          collector.finish();
          finish();
        } catch (error) { finish(error as Error); }
      };
      source.on('data', data);
      source.on('error', error => finish(error));
      source.on('end', end);
      source.on('close', end);
      if (head.length) data(head);
      resolve();
    };
    const request = httpRequest({ socketPath, method: 'POST', path: `${apiVersion}/containers/${id}/attach?stream=true&stdout=true&stderr=true`, signal,
      headers: { Connection: 'Upgrade', Upgrade: 'tcp' },
    });
    request.on('upgrade', (_response, socket, head) => consume(socket, head));
    request.on('response', response => {
      if (response.statusCode !== 200) { response.destroy(); reject(new Error('Docker attach failed.')); return; }
      consume(response);
    });
    request.on('error', error => { reject(error); finish(error); });
    request.setTimeout(15000, () => request.destroy(new Error('Docker attach timed out.')));
    request.end();
  });
  const abort = () => { stream?.destroy(); finish(new Error('cancelled')); };
  signal.addEventListener('abort', abort, { once: true });
  return { ready, done, buffers: () => collector.buffers(),
    close: () => { signal.removeEventListener('abort', abort); stream?.destroy(); } };
}

type DockerExecution = {
  status: DockerStatus;
  detail: string;
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  containerId: string | null;
  cleanup: string;
  configuration: Inspection | null;
  profileVerified: boolean;
  durationMs: number;
  outputTruncated: boolean;
};

/** Trusted control plane only. It never pulls an image or executes a host fallback. */
export async function runDocker(backend: Backend, bundleRoot: string, argv: string[], limits: Limits, signal?: AbortSignal, attemptId = randomUUID()): Promise<DockerExecution> {
  const started = performance.now();
  let status: DockerStatus = 'setup_error', detail = '', exitCode: number | null = null;
  let cleanup = 'not-created', containerId: string | null = null, configuration: Inspection | null = null;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
  if (!/^[a-f0-9-]{36}$/.test(attemptId)) throw new Error('Invalid restricted attempt identity.');
  const owner = attemptId;
  const name = `autoreview-${owner}`;
  let profileVerified = false;
  const controller = new AbortController();
  const abort = () => { status = 'cancelled'; controller.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let output: ReturnType<typeof attachOutput> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let creationAttempted = false;
  timer = setTimeout(() => { status = 'timeout'; controller.abort(); }, limits.timeoutMs);
  try {
    controller.signal.throwIfAborted();
    if (!(await stat(backend.socketPath)).isSocket()) throw new Error('A local Docker socket is required.');
    const seccomp = await readFile(backend.seccompPath, 'utf8');
    const builtIn = await readFile(new URL('./experiments-seccomp.json', import.meta.url), 'utf8');
    if (digestBytes(seccomp) !== backend.seccompSha256 || seccomp !== builtIn) throw new Error('Restricted seccomp identity changed.');
    const info = await dockerJson(backend.socketPath, 'GET', '/info', undefined, controller.signal);
    const image = await dockerJson(backend.socketPath, 'GET', `/images/${backend.imageId}/json`, undefined, controller.signal);
    assertDockerIdentity(backend, info, image);
    const bundle = await realpath(bundleRoot);
    const config = dockerConfiguration(backend.imageId, bundle, argv, JSON.stringify(JSON.parse(seccomp)), owner);
    creationAttempted = true;
    const created = await dockerJson(backend.socketPath, 'POST', `/containers/create?name=${name}`, config, controller.signal) as { Id: string; Warnings: string[] | null };
    if (!/^[a-f0-9]{64}$/.test(created.Id)) throw new Error('Invalid Docker container identity.');
    containerId = created.Id;
    if (created.Warnings?.length) throw new Error(`Docker could not enforce profile: ${created.Warnings.join('; ')}`);
    configuration = await dockerJson(backend.socketPath, 'GET', `/containers/${containerId}/json`, undefined, controller.signal) as Inspection;
    assertContainer(configuration, config);
    profileVerified = true;
    output = attachOutput(backend.socketPath, containerId, limits.maxOutputBytes, controller.signal);
    await output.ready;
    controller.signal.throwIfAborted();
    status = 'completed';
    await dockerJson(backend.socketPath, 'POST', `/containers/${containerId}/start`, undefined, controller.signal);
    const waited = dockerJson(backend.socketPath, 'POST', `/containers/${containerId}/wait?condition=not-running`, undefined, controller.signal, limits.timeoutMs + 5000);
    const [, result] = await Promise.all([output.done, waited]) as [void, { StatusCode: number; Error?: { Message: string } }];
    if (result.Error?.Message) throw new Error(result.Error.Message);
    if (!Number.isInteger(result.StatusCode)) throw new Error('Missing container exit status.');
    exitCode = result.StatusCode;
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
    if (detail === 'output_limit') status = 'output_limit';
    else if (status === 'completed') status = 'process_error';
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', abort);
    if (output) {
      ({ stdout, stderr } = output.buffers());
      output.close();
    }
    if (creationAttempted) {
      try {
        // The exclusive name also recovers an ambiguous create response without creating again.
        const owned = await dockerJson(backend.socketPath, 'GET', `/containers/${containerId ?? name}/json`) as Inspection;
        if (owned.Config.Labels['pi-auto-review.attempt'] !== owner) throw new Error('Container ownership changed.');
        containerId = owned.Id;
        await dockerJson(backend.socketPath, 'DELETE', `/containers/${containerId}?force=true&v=true`);
        try {
          await dockerJson(backend.socketPath, 'GET', `/containers/${containerId}/json`);
          throw new Error('Container still exists after removal.');
        } catch (error) {
          if (!(error instanceof DockerError) || error.status !== 404) throw error;
        }
        cleanup = 'container-removed';
      } catch (error) {
        if (error instanceof DockerError && error.status === 404) cleanup = 'container-absent';
        else {
          cleanup = 'unconfirmed';
          status = 'cleanup_failed';
          detail += ` Cleanup: ${String(error)}`;
        }
      }
    }
  }
  return { status, detail, exitCode, stdout, stderr, containerId, cleanup, configuration, profileVerified,
    durationMs: Math.round(performance.now() - started), outputTruncated: status === 'output_limit' };
}
