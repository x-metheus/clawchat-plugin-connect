import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export function syncUpdaterSkill(source,destination,receiptPath){
 if(!fs.existsSync(source))return;
 let previous=null;try{previous=JSON.parse(fs.readFileSync(receiptPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(fs.existsSync(destination)){
  if(fs.lstatSync(destination).isSymbolicLink()||!previous)return;
  for(const [relative,digest] of Object.entries(previous)){
   const target=path.join(destination,relative);
   if(!fs.existsSync(target)||!fs.lstatSync(target).isFile()||fs.lstatSync(target).isSymbolicLink()||hash(target)!==digest)return;
  }
 }
 const next={};
 function visit(directory,prefix=''){
  for(const name of fs.readdirSync(directory)){
   const input=path.join(directory,name),relative=prefix?prefix+'/'+name:name;
   if(fs.lstatSync(input).isDirectory()){if(visit(input,relative)===false)return false;}
   else{const target=path.join(destination,relative);let current=destination;for(const part of relative.split('/').slice(0,-1)){current=path.join(current,part);if(fs.existsSync(current)&&(!fs.lstatSync(current).isDirectory()||fs.lstatSync(current).isSymbolicLink()))return false;}if(fs.existsSync(target)&&!previous?.[relative])return false;next[relative]=hash(input);}
  }return true;
 }
 if(visit(source)===false)return;
 fs.cpSync(source,destination,{recursive:true});fs.mkdirSync(path.dirname(receiptPath),{recursive:true,mode:0o700});
 const temporary=receiptPath+'.'+process.pid;fs.writeFileSync(temporary,JSON.stringify(next),{mode:0o600});fs.renameSync(temporary,receiptPath);
}
