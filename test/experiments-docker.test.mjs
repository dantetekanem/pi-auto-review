import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dockerConfiguration, runDocker } from '../src/experiments-docker.ts';

const seccompPath = resolve('src/experiments-seccomp.json');
const seccomp = readFileSync(seccompPath, 'utf8');
const imageId = 'sha256:' + 'a'.repeat(64);
test('container configuration contains only read-only input and quota-bound scratch', () => {
  const config = dockerConfiguration(imageId, '/tmp/private-bundle', ['-e', 'console.log(1)'], seccomp, 'attempt');
  assert.equal(config.Image, imageId);
  assert.equal(config.User, '1000:1000');
  assert.equal(config.HostConfig.ReadonlyRootfs, true);
  assert.equal(config.HostConfig.NetworkMode, 'none');
  assert.equal(config.HostConfig.Memory, 512 * 1024 ** 2);
  assert.equal(config.HostConfig.MemorySwap, config.HostConfig.Memory);
  assert.equal(config.HostConfig.PidsLimit, 64);
  assert.deepEqual(config.HostConfig.Mounts.map(m => [m.Target, m.ReadOnly]), [['/bundle', true]]);
  assert.equal(config.HostConfig.LogConfig.Type, 'none');
});

const configured = process.env.PI_AUTO_REVIEW_DOCKER_TEST_BACKEND;
test('real restricted worker enforces isolation and cleans complete/timeout/flood/cancelled workloads', { skip: !configured, timeout: 90000 }, async t => {
  const saved = JSON.parse(readFileSync(configured, 'utf8'));
  const backend = { socketPath: saved.endpoint.replace(/^unix:\/\//, ''), engineId: saved.engine.ID,
    imageId: saved.imageId, platform: saved.platform, seccompPath,
    seccompSha256: createHash('sha256').update(seccomp).digest('hex') };
  const root = mkdtempSync(join(tmpdir(), 'autoreview-docker-'));
  const bundle = join(root, 'bundle');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(bundle, { mode: 0o755 });
  writeFileSync(join(root, 'host-sentinel'), 'private host value');
  writeFileSync(join(bundle, 'input'), 'read only');
  chmodSync(root, 0o755);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const execute = (code, limits = {}, signal) => runDocker(backend, bundle, ['-e', code], { timeoutMs: 10000, maxOutputBytes: 32768, ...limits }, signal);
  const result = await execute(`
    const fs=require('fs'),assert=require('assert/strict'),net=require('net');
    assert.equal(fs.readFileSync('/bundle/input','utf8'),'read only');
    for(const path of ['/bundle/input','/etc/sentinel','${root}/host-sentinel']) assert.throws(()=>fs.writeFileSync(path,'no'));
    assert.throws(()=>fs.readFileSync('${root}/host-sentinel'));
    assert.throws(()=>fs.readFileSync('/var/run/docker.sock'));
    assert.equal(process.env.HOME,'/scratch');
    assert.equal(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),'536870912');
    assert.equal(fs.readFileSync('/sys/fs/cgroup/memory.swap.max','utf8').trim(),'0');
    assert.equal(fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),'64');
    assert.match(fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8'),/^100000 100000/);
    const server=net.createServer();server.on('error',e=>{assert.equal(e.code,'EPERM');console.log('isolated '+process.version)});server.listen(0,'127.0.0.1');
  `);
  assert.equal(result.status, 'completed', result.detail + JSON.stringify(result.configuration && { image: result.configuration.Image, config: result.configuration.Config, host: { ...result.configuration.HostConfig, SecurityOpt: result.configuration.HostConfig.SecurityOpt.map(s => s.slice(0, 80)) } }));
  assert.equal(result.exitCode, 0, result.stderr.toString());
  assert.match(result.stdout.toString(), /isolated v22\./);
  assert.equal(result.cleanup, 'container-removed');
  assert.equal(readFileSync(join(root, 'host-sentinel'), 'utf8'), 'private host value');
  const detached = await execute(`require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();console.log('detached');`);
  assert.equal(detached.status, 'completed', detached.detail);
  assert.equal(detached.cleanup, 'container-removed');
  const timeout = await execute('setInterval(()=>{},1000)', { timeoutMs: 200 });
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.cleanup, 'container-removed');
  const flood = await execute("process.stdout.write('x'.repeat(20000))", { maxOutputBytes: 100 });
  assert.equal(flood.status, 'output_limit');
  assert.ok(flood.stdout.length + flood.stderr.length <= 100);
  assert.equal(flood.cleanup, 'container-removed');
  const disk = await execute(`
    const fs=require('fs'),assert=require('assert/strict');let bytes=0,files=0;
    try { for(let i=0;i<300;i++){fs.writeFileSync('/scratch/bytes-'+i,Buffer.alloc(524288));bytes+=524288;} } catch(e){assert.equal(e.code,'ENOSPC');}
    assert.ok(bytes>60000000&&bytes<=67108864);for(const p of fs.readdirSync('/scratch'))fs.unlinkSync('/scratch/'+p);
    try { for(let i=0;i<5000;i++){fs.writeFileSync('/scratch/inode-'+i,'');files++;} } catch(e){assert.equal(e.code,'ENOSPC');}
    assert.ok(files>4000&&files<=4096);console.log('scratch quotas');
  `);
  assert.equal(disk.exitCode, 0, disk.stderr.toString());
  assert.match(disk.stdout.toString(), /scratch quotas/);
  const pids = await execute(`
    const cp=require('child_process'),fs=require('fs'),assert=require('assert/strict');let denied=0;const children=[];
    Promise.all(Array.from({length:80},()=>new Promise(resolve=>{const p=cp.spawn('/bin/sleep',['20'],{stdio:'ignore'});children.push(p);p.once('spawn',resolve);p.once('error',e=>{assert.equal(e.code,'EAGAIN');denied++;resolve();});}))).then(()=>{
      assert.ok(denied>0);assert.ok(Number(fs.readFileSync('/sys/fs/cgroup/pids.current','utf8'))<=64);for(const p of children)if(p.pid)p.kill('SIGKILL');console.log('pid quota');
    });
  `);
  assert.equal(pids.exitCode, 0, pids.stderr.toString());
  assert.match(pids.stdout.toString(), /pid quota/);
  const memory = await execute(`
    const cp=require('child_process'),fs=require('fs'),assert=require('assert/strict');global.held=Buffer.alloc(200*1024*1024,1);
    const p=cp.spawn(process.execPath,['-e','global.held=Buffer.alloc(400*1024*1024,1);setInterval(()=>{},1000)'],{stdio:'ignore'});
    p.on('exit',()=>{const events=fs.readFileSync('/sys/fs/cgroup/memory.events','utf8');assert.ok(Number(/oom_kill (\\d+)/.exec(events)[1])>0);console.log('aggregate memory quota');});
  `);
  assert.equal(memory.exitCode, 0, memory.stderr.toString());
  assert.match(memory.stdout.toString(), /aggregate memory quota/);
  const controller = new AbortController();
  const cancelled = execute('setInterval(()=>{},1000)', {}, controller.signal);
  const timer = setTimeout(() => controller.abort(), 300);
  try { assert.equal((await cancelled).status, 'cancelled'); } finally { clearTimeout(timer); }
});
