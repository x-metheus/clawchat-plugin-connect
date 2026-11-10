import {it,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {syncUpdaterSkill} from '../platform/deepseek-harness/update-skill.mjs';
it('installs and updates managed references while preserving user-customized updater instructions',()=>{
 const root=mkdtempSync(join(tmpdir(),'dsh-updater-skill-')),source=join(root,'source'),destination=join(root,'skill'),receipt=join(root,'managed.json');mkdirSync(source);writeFileSync(join(source,'SKILL.md'),'first');syncUpdaterSkill(source,destination,receipt);expect(readFileSync(join(destination,'SKILL.md'),'utf8')).toBe('first');
 writeFileSync(join(source,'SKILL.md'),'second');syncUpdaterSkill(source,destination,receipt);expect(readFileSync(join(destination,'SKILL.md'),'utf8')).toBe('second');
 writeFileSync(join(destination,'SKILL.md'),'my instructions');writeFileSync(join(source,'SKILL.md'),'third');syncUpdaterSkill(source,destination,receipt);expect(readFileSync(join(destination,'SKILL.md'),'utf8')).toBe('my instructions');
});
