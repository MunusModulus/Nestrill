#!/usr/bin/env python3
"""Build Nestrill Standard v0.2.4 Windows assets from this release source snapshot.

Requires Python 3.9+ and Go 1.23+. The included Nestrill.exe is the
byte-verified RC08 launcher. Set NESTRILL_REBUILD_LAUNCHER=1 to recompile
launcher.go (this changes its hash and therefore the package hashes).
"""
from pathlib import Path
import os, shutil, tempfile, json, hashlib, zipfile, subprocess
ROOT=Path(__file__).resolve().parent
OUT=ROOT/'dist'
OUT.mkdir(exist_ok=True)

def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def archive(source,target):
    with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=8) as z:
        for p in sorted(source.rglob('*')):
            if p.is_file():
                info=zipfile.ZipInfo(p.relative_to(source).as_posix(), date_time=(2026,11,24,0,0,0))
                info.compress_type=zipfile.ZIP_DEFLATED
                info.create_system=3
                info.external_attr=(0o100644<<16)
                z.writestr(info,p.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=8)
    with zipfile.ZipFile(target) as z:
        assert z.testzip() is None

def run_go(filename,output,cwd):
    env=dict(os.environ,GOOS='windows',GOARCH='amd64',CGO_ENABLED='0')
    subprocess.run(['go','build','-trimpath','-ldflags=-s -w -H windowsgui','-o',str(output),filename],cwd=cwd,env=env,check=True)

with tempfile.TemporaryDirectory(prefix='nestrill-v023-build-') as tmp:
    temp=Path(tmp);app=temp/'app';setup=temp/'setup'
    shutil.copytree(ROOT/'app',app)
    shutil.copytree(ROOT/'setup',setup,ignore=shutil.ignore_patterns('payload.zip'))
    if (setup/'installer.ps1').read_bytes()!=(app/'scripts'/'Nestrill-Installer.ps1').read_bytes():
        raise SystemExit('Installer source and packaged script differ: refusing build')
    if os.environ.get('NESTRILL_REBUILD_LAUNCHER')=='1':
        run_go('launcher.go',app/'Nestrill.exe',setup)
    manifest=app/'RELEASE_FILE_HASHES.json'
    existing=json.loads(manifest.read_text(encoding='utf-8'))
    assert existing['release']=='Nestrill v0.2.4' and existing['kind']=='release'
    records=[{'path':p.relative_to(app).as_posix(),'sha256':digest(p)} for p in sorted(app.rglob('*')) if p.is_file() and p!=manifest]
    if len(records)!=77:raise SystemExit('Unexpected managed file count')
    if os.environ.get('NESTRILL_REBUILD_LAUNCHER')=='1':
        existing['files']=records
        manifest.write_text(json.dumps(existing,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    elif records!=existing['files']:
        raise SystemExit('Release manifest mismatch: source was modified')
    portable=OUT/'Nestrill-v0.2.4-Portable.zip'
    archive(app,portable)
    shutil.copy2(portable,setup/'payload.zip')
    exe=OUT/'Nestrill-Setup-v0.2.4.exe'
    run_go('setup.go',exe,setup)
    zipname=OUT/'Nestrill-Setup-v0.2.4.zip'
    with zipfile.ZipFile(zipname,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=8) as z:
        info=zipfile.ZipInfo(exe.name,date_time=(2026,11,24,0,0,0))
        info.compress_type=zipfile.ZIP_DEFLATED
        info.create_system=3
        info.external_attr=(0o100644<<16)
        z.writestr(info,exe.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=8)
    (OUT/'SHA256SUMS.txt').write_text(''.join(digest(p)+'  '+p.name+'\n' for p in [exe,portable,zipname]),encoding='utf-8')
    print('Build complete:',OUT)
