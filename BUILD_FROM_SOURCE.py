#!/usr/bin/env python3
"""Build Nestrill v0.2.0 distribution from this source archive (Python 3.9+, Go 1.23+)."""
from pathlib import Path
import os, shutil, tempfile, json, hashlib, zipfile, subprocess
ROOT=Path(__file__).resolve().parent
OUT=ROOT/'dist'
OUT.mkdir(exist_ok=True)

def archive(root, target):
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=8) as z:
        for p in sorted(root.rglob('*')):
            if p.is_file():
                info=zipfile.ZipInfo(p.relative_to(root).as_posix(),date_time=(2026,11,15,0,0,0))
                info.compress_type=zipfile.ZIP_DEFLATED
                info.create_system=3
                info.external_attr=(0o100644 << 16)
                z.writestr(info,p.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=8)
    with zipfile.ZipFile(target) as z: assert z.testzip() is None

def run_go(src,output,work):
    env=dict(os.environ,GOOS='windows',GOARCH='amd64',CGO_ENABLED='0')
    subprocess.run(['go','build','-trimpath','-ldflags=-s -w -H windowsgui','-o',str(output),src],cwd=work,env=env,check=True)

with tempfile.TemporaryDirectory(prefix='nestrill-build-') as tmp:
    stage=Path(tmp)
    app=stage/'app'
    shutil.copytree(ROOT/'app',app)
    setup=stage/'setup'
    shutil.copytree(ROOT/'setup',setup)
    run_go('launcher.go',app/'Nestrill.exe',setup)
    # Include the very same installer script in the portable payload and setup EXE.
    shutil.copy2(setup/'installer.ps1',app/'scripts'/'Nestrill-Installer.ps1')
    manifest_path=app/'RELEASE_FILE_HASHES.json'
    files=sorted(p for p in app.rglob('*') if p.is_file() and p!=manifest_path)
    manifest={'release':'Nestrill v0.2.0','kind':'initial-public-release',
      'releasedAt':'2026-11-15',
      'builtFrom':'verified pre-release runtime; public-release metadata/document updates only',
      'defaultArticleFonts':'source=Noto Sans JP Medium/400, title=Noto Sans JP Medium/500, excerpt=Noto Sans JP/400',
      'defaultAiModel':'gemma4:e4b-it-qat (only if no stored model configuration)',
      'exclusionPlaceholder':'none',
      'privacy':'no data/, run/, logs/ or user session/credentials',
      'files':[{'path':p.relative_to(app).as_posix(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]}
    manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    portable=OUT/'Nestrill-v0.2.0-Portable.zip'
    archive(app,portable)
    shutil.copy2(portable,setup/'payload.zip')
    exe=OUT/'Nestrill-Setup-v0.2.0.exe'
    run_go('setup.go',exe,setup)
    with zipfile.ZipFile(OUT/'Nestrill-Setup-v0.2.0.zip','w',zipfile.ZIP_DEFLATED,compresslevel=8) as z:
        info=zipfile.ZipInfo(exe.name,date_time=(2026,11,15,0,0,0))
        info.compress_type=zipfile.ZIP_DEFLATED
        info.create_system=3
        info.external_attr=(0o100644 << 16)
        z.writestr(info,exe.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=8)
    files_to_hash=[exe, portable,OUT/'Nestrill-Setup-v0.2.0.zip']
    (OUT/'SHA256SUMS.txt').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in files_to_hash),encoding='utf-8')
    print('Created: '+str(OUT))
