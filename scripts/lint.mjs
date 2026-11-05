import {spawnSync} from 'node:child_process';
import {closeSync,mkdtempSync,openSync,readFileSync,rmdirSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=mkdtempSync(join(tmpdir(),'al-rifai-eslint-'));
const outputPath=join(directory,'results.json');
const outputFd=openSync(outputPath,'w');
let result,files;
try{
 result=spawnSync(process.execPath,['node_modules/eslint/bin/eslint.js','.','--format','json'],{stdio:['ignore',outputFd,'inherit']});
 if(result.error)throw result.error;
 try{files=JSON.parse(readFileSync(outputPath,'utf8'));}catch(error){throw new Error('Unable to parse ESLint JSON output',{cause:error});}
}finally{
 closeSync(outputFd);
 unlinkSync(outputPath);
 rmdirSync(directory);
}
for(const f of files)for(const m of f.messages)console.log(`${f.filePath.replace(process.cwd()+'/', '')}:${m.line} ${m.severity===2?'error':'warning'} ${m.ruleId}: ${m.message.split('\n')[0]}`);
console.log(`Lint: ${files.reduce((n,f)=>n+f.errorCount,0)} errors, ${files.reduce((n,f)=>n+f.warningCount,0)} warnings`);
process.exit(result.status || 0);
