#!/usr/bin/env python3
"""Stage the separately versioned DSH integration; never builds a runtime image."""
import argparse,pathlib,shutil,json,subprocess,os
p=argparse.ArgumentParser();p.add_argument('--updater-source',required=True);p.add_argument('--output',required=True);a=p.parse_args();root=pathlib.Path(__file__).resolve().parents[1];out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=False)
for source,target in [(root/'dist/clawchat-connect',out/'clawchat-connect')]:shutil.copy2(source,target);target.chmod(0o755)
shutil.copytree(root/'dist/official-plugins',out/'official-plugins');shutil.copytree(root/'skills',out/'skills');shutil.copytree(root/'platform/deepseek-harness',out/'runtime');shutil.copytree(pathlib.Path(a.updater_source),out/'updater-skill')
for name in ['runtime/cli.mjs','runtime/dsh-bridge.sh']:(out/name).chmod(0o755)
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip();(out/'source.json').write_text(json.dumps({'connect_commit':commit,'package_unit':'clawchat-dsh-integration'},indent=2)+'\n');print(json.dumps({'staged':str(out),'connect_commit':commit}))
