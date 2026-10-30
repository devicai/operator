#!/usr/bin/env python3
"""Run against a dedicated local Operator (port 3329, a *_qa Mongo database).

Start a local instance with imageCache.enabled=true and commitLive=true, and a
private config.yml. This smoke creates and deletes only its own sandboxes and
snapshot. Requires Python 3, Docker and an existing node:24 image. Never targets
DEV or PROD. Run from the Operator repository root.
"""
import json,time,urllib.request,urllib.error
from pathlib import Path
cfg=json.loads(Path('config.yml').read_text()); assert cfg['server']['port']==3329 and cfg['database']['uri'].endswith('_qa'), 'Dedicated local QA configuration required'; key=cfg['auth']['apiKeys'][0]['key']; base='http://127.0.0.1:3329/api/v1'
sandboxes=[]; snapshots=[]; result={}
def req(method,path,body=None):
    r=urllib.request.Request(base+path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={'Content-Type':'application/json','x-api-key':key})
    try:
        with urllib.request.urlopen(r,timeout=120) as f:
            raw=f.read(); return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise RuntimeError(str(e.code)+': '+e.read().decode()[:400])
def restore(sid,ttl=600):
    r=req('POST',f'/snapshots/{sid}/restore',{'linked':True,'ttlSeconds':ttl}); sandboxes.append(r['sandboxId']); return r['sandboxId']
def cmd(sid,text):
    t=time.monotonic(); r=req('POST',f'/sandboxes/{sid}/command',{'command':text}); assert r['code']==0,r; return r,time.monotonic()-t
try:
    first=req('POST','/sandboxes',{'image':'node:24','ttlSeconds':600,'memoryMib':256}); sid=first['sandboxId'];sandboxes.append(sid)
    cmd(sid,'mkdir -p /workspace; echo seed > /workspace/seed.txt; head -c 8388608 /dev/urandom > /workspace/payload.bin')
    snap=req('POST','/snapshots',{'sandboxId':sid,'scope':'full'}); snapshot=snap['snapshotId'];snapshots.append(snapshot)
    req('POST',f'/sandboxes/{sid}/stop',{'save':False})
    sid=restore(snapshot)
    times=[]
    for n in range(3):
        _,elapsed=cmd(sid,f'echo command-{n} >> /workspace/session.txt');times.append(round(elapsed,3))
    before=req('GET',f'/snapshots/{snapshot}')
    t=time.monotonic(); req('POST',f'/sandboxes/{sid}/stop',{'save':True}); result['stopSeconds']=round(time.monotonic()-t,3)
    after=req('GET',f'/snapshots/{snapshot}')
    assert after['lastSaveMethod']=='commit', after.get('lastSaveMethod')
    assert after['persistVersion']==before.get('persistVersion',0)+1
    sid=restore(snapshot,60)
    read,_=cmd(sid,'cat /workspace/session.txt; echo expiry > /workspace/expiry.txt')
    assert all('command-'+str(i) in read['stdout'] for i in range(3))
    result.update(commandSeconds=times,saveMethod=after['lastSaveMethod'],saveDurationMs=after['lastSaveDurationMs'],stopRestoreVerified=True)
    print(json.dumps(result),flush=True)
    end=time.monotonic()+85
    while time.monotonic()<end:
        status=req('GET',f'/sandboxes/{sid}/status')
        if status['status']=='expired': break
        time.sleep(2)
    else: raise AssertionError('TTL did not expire')
    sid=restore(snapshot)
    read,_=cmd(sid,'cat /workspace/expiry.txt; cat /workspace/session.txt')
    assert 'expiry' in read['stdout'] and 'command-2' in read['stdout']
    result['expiryRestoreVerified']=True
    Path('/tmp/operator-persistence-e2e-result.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result),flush=True)
finally:
    for sid in sandboxes:
        try: req('DELETE','/sandboxes/'+sid)
        except Exception as e: print('cleanup sandbox:', str(e)[:100],flush=True)
    for sid in snapshots:
        try: req('DELETE','/snapshots/'+sid)
        except Exception as e: print('cleanup snapshot:', str(e)[:100],flush=True)
