import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from '../src/reader.mjs';
import { parseRelease, parseRegistry, indexRegistry, resolveReference, collectRelease } from '../src/waves.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('变量身份与三个依据引用原样保留',()=>{
  const result=inspect(primary);assert.equal(result.identity.version,'2024');
  assert.equal(result.variables[0].references.length,3);
  assert.equal(result.variables[0].references.find(item=>item.role==='UniverseReference').version,'2');
});
test('注册表同名不同机构与不同版本并存',async()=>{
  const registry=JSON.parse(await resource('/registry'));
  assert.equal(registry.objects.filter(item=>item.id==='codes').length,3);
  assert.notEqual(inspect(await resource('/objects/codes-1')).identity.version,inspect(await resource('/objects/codes-2')).identity.version);
});
test('缺身份与不闭合 XML 拒绝登记',()=>{
  assert.throws(()=>inspect(Buffer.from('<VariableScheme id="x"/>')));
  assert.throws(()=>inspect(Buffer.from('<a agencyID="a" id="x" version="1"><b></a>')));
});

test('非变量对象保留自身 Label 与进一步引用',()=>{
  const parsed=inspect(Buffer.from('<d:Universe xmlns:d="ddi:reusable:3_3" agencyID="a" id="u" version="1">'+
    '<d:Label>仅全职人员</d:Label><d:QuestionReference agencyID="a" id="q" version="1"/></d:Universe>'));
  assert.deepEqual(parsed.label,['仅全职人员']);
  assert.deepEqual(parsed.references.map(item=>[item.role,item.id,item.version]),[['QuestionReference','q','1']]);
});

test('版本必须精确匹配，不按注册表最新版本顶替',async()=>{
  const index=indexRegistry(parseRegistry(await resource('/registry')));
  const exact=resolveReference(index,{agency:'school-a',id:'codes',version:'1'});
  assert.equal(exact.status,'resolved');
  assert.equal(exact.basis,'exact_version');
  assert.equal(exact.resolved.url,'/objects/codes-1');
  const older=resolveReference(index,{agency:'school-a',id:'codes',version:'0'});
  assert.equal(older.status,'missing');
  assert.equal(older.resolved,null);
});
test('省略版本只在唯一匹配时解析并保留依据，多版本则留缺',async()=>{
  const index=indexRegistry(parseRegistry(await resource('/registry')));
  const ambiguous=resolveReference(index,{agency:'school-a',id:'codes',version:null});
  assert.equal(ambiguous.status,'ambiguous_version');
  assert.equal(ambiguous.resolved,null);
  assert.equal(ambiguous.candidates.length,2);
  const single=resolveReference(index,{agency:'school-a',id:'q1',version:null});
  assert.equal(single.status,'resolved');
  assert.equal(single.basis,'single_registry_match');
  assert.equal(single.resolved.version,'1');
});
test('同标签同号不同机构不互补',async()=>{
  const index=indexRegistry(parseRegistry(await resource('/registry')));
  const foreign=resolveReference(index,{agency:'school-a',id:'other',version:'1'});
  assert.equal(foreign.status,'missing');
  const own=resolveReference(index,{agency:'school-b',id:'codes',version:'1'});
  assert.deepEqual([own.status,own.resolved.url],['resolved','/objects/other']);
});
test('入口收集覆盖实际引用对象并保留复用关系',async()=>{
  const registry=parseRegistry(await resource('/registry'));
  const release=parseRelease(await resource('/release'));
  const objects=new Map([['/primary','/primary']].concat(registry.objects.map(entry=>[entry.url,entry.url])));
  const fetched=[];
  const fetch=async path=>{
    fetched.push(path);
    const item=manifest.resources[path];
    if(!item) throw new Error(`unexpected_path_${path}`);
    return {bytes:await resource(path),url:`http://source.invalid${path}`};
  };
  const snapshot=await collectRelease({release,releasePath:'/release',registry,fetch});
  assert.equal(snapshot.complete,true);
  assert.equal(snapshot.status,'complete');
  assert.deepEqual(snapshot.objects.map(item=>`${item.identity.agency}:${item.identity.id}@${item.identity.version}`).sort(),
    ['school-a:codes@1','school-a:q1@1','school-a:u1@2','school-a:vars@2024']);
  const variable=snapshot.variables[0];
  assert.equal(variable.complete,true);
  assert.deepEqual(variable.references.map(item=>item.layer),['question','universe','codeScheme']);
  assert.equal(variable.references.find(item=>item.layer==='codeScheme').resolved.version,'1');
  assert.equal(variable.references.find(item=>item.layer==='universe').label[0],'仅全职人员');
  assert.ok(objects.has('/objects/codes-1'));
  assert.ok(!fetched.includes('/objects/codes-2'));
  assert.ok(!fetched.includes('/objects/other'));
  const reuse=snapshot.relationships.filter(item=>item.role==='ReleaseReference')[0];
  assert.equal(reuse.layer,'variableScheme');
  assert.equal(reuse.basis,'declared_url');
});

test('依据缺失时变量留成可继续补采的记录并说明所基层次',async()=>{
  const registry=parseRegistry(await resource('/registry'));
  const release=parseRelease(await resource('/release'));
  const fetch=async path=>{
    if(path==='/objects/u1') throw new Error('source_status_404');
    const item=manifest.resources[path];
    if(!item) throw new Error(`unexpected_path_${path}`);
    return {bytes:await resource(path),url:`http://source.invalid${path}`};
  };
  const snapshot=await collectRelease({release,releasePath:'/release',registry,fetch});
  assert.equal(snapshot.complete,false);
  assert.equal(snapshot.counts.incompleteVariables,1);
  const variable=snapshot.variables[0];
  assert.equal(variable.complete,false);
  assert.equal(variable.gaps[0].layer,'universe');
  assert.equal(variable.gaps[0].requested.version,'2');
  assert.match(variable.description,/universe/);
  assert.deepEqual(snapshot.gaps[0].variableKeys,[variable.key]);
  assert.equal(snapshot.gaps[0].status,'unavailable');
});

test('含糊版本不选中任一候选，变量带候选列表留缺',async()=>{
  const registry=parseRegistry(await resource('/registry'));
  const scheme='<d:VariableScheme xmlns:d="ddi:logicalproduct:3_3" agencyID="school-a" id="vars" version="2024">'+
    '<d:Variable id="v1"><d:Label>就业状态</d:Label><d:CodeSchemeReference agencyID="school-a" id="codes"/>'+
    '<d:UniverseReference agencyID="school-a" id="u1" version="2"/></d:Variable></d:VariableScheme>';
  const fetch=async path=>{
    if(path==='/primary') return {bytes:Buffer.from(scheme),url:'http://source.invalid/primary'};
    const item=manifest.resources[path];
    if(!item) throw new Error(`unexpected_path_${path}`);
    return {bytes:await resource(path),url:`http://source.invalid${path}`};
  };
  const release={identity:{agency:'school-a',id:'survey',version:'2024'},
    references:[{role:'ReleaseReference',layer:'variableScheme',agency:'school-a',id:'vars',version:'2024',url:'/primary'}]};
  const snapshot=await collectRelease({release,releasePath:'/release',registry,fetch});
  const gap=snapshot.variables[0].gaps[0];
  assert.equal(gap.layer,'codeScheme');
  assert.equal(gap.status,'ambiguous_version');
  assert.deepEqual(gap.candidates.map(item=>item.version).sort(),['1','2']);
  assert.equal(snapshot.variables[0].references.find(item=>item.layer==='codeScheme').resolved,null);
  assert.equal(snapshot.variables[0].complete,false);
});

test('响应身份与请求身份不符时不登记为已解析',async()=>{
  const registry=parseRegistry(await resource('/registry'));
  const fetch=async path=>{
    if(path==='/objects/u1') return {bytes:await resource('/objects/other'),url:'http://source.invalid/objects/u1'};
    const item=manifest.resources[path];
    if(!item) throw new Error(`unexpected_path_${path}`);
    return {bytes:await resource(path),url:`http://source.invalid${path}`};
  };
  const release=parseRelease(await resource('/release'));
  const snapshot=await collectRelease({release,releasePath:'/release',registry,fetch});
  const gap=snapshot.gaps.find(item=>item.layer==='universe');
  assert.equal(gap.status,'identity_mismatch');
  assert.deepEqual(gap.actualIdentity,{agency:'school-b',id:'codes',version:'1'});
  assert.equal(snapshot.objects.some(item=>item.identity.id==='u1'),false);
  assert.equal(snapshot.variables[0].complete,false);
});

test('同标签不同变量、同号不同版本各自保留，不合并',async()=>{
  const registry=parseRegistry(await resource('/registry'));
  const scheme=version=>'<d:VariableScheme xmlns:d="ddi:logicalproduct:3_3" agencyID="school-a" id="vars" version="'+version+'">'+
    '<d:Variable id="v1"><d:Label>就业状态</d:Label><d:CodeSchemeReference agencyID="school-a" id="codes" version="1"/></d:Variable>'+
    '<d:Variable id="v2"><d:Label>就业状态</d:Label><d:CodeSchemeReference agencyID="school-a" id="codes" version="1"/></d:Variable></d:VariableScheme>';
  const fetch=async path=>{
    if(path==='/s/2023') return {bytes:Buffer.from(scheme('2023')),url:'http://source.invalid/s/2023'};
    if(path==='/s/2024') return {bytes:Buffer.from(scheme('2024')),url:'http://source.invalid/s/2024'};
    const item=manifest.resources[path];
    if(!item) throw new Error(`unexpected_path_${path}`);
    return {bytes:await resource(path),url:`http://source.invalid${path}`};
  };
  const release={identity:{agency:'school-a',id:'survey',version:'2024'},references:[
    {role:'ReleaseReference',layer:'variableScheme',agency:'school-a',id:'vars',version:'2023',url:'/s/2023'},
    {role:'ReleaseReference',layer:'variableScheme',agency:'school-a',id:'vars',version:'2024',url:'/s/2024'}]};
  const snapshot=await collectRelease({release,releasePath:'/release',registry,fetch});
  assert.equal(snapshot.variables.length,4);
  assert.deepEqual(snapshot.variables.map(item=>`${item.scheme.version}:${item.variableId}`),
    ['2023:v1','2023:v2','2024:v1','2024:v2']);
  assert.equal(new Set(snapshot.variables.map(item=>item.key)).size,4);
  assert.equal(snapshot.variables.every(item=>item.complete),true);
});

test('非变量对象的进一步引用会继续展开并保留复用边',async()=>{
  const registry=parseRegistry(await resource('/registry'));
  const question='<d:QuestionItem xmlns:d="ddi:reusable:3_3" agencyID="school-a" id="q1" version="1">'+
    '<d:Label>当前的就业状态？</d:Label><d:UniverseReference agencyID="school-a" id="u1" version="2"/></d:QuestionItem>';
  const fetch=async path=>{
    if(path==='/objects/q1') return {bytes:Buffer.from(question),url:'http://source.invalid/objects/q1'};
    const item=manifest.resources[path];
    if(!item) throw new Error(`unexpected_path_${path}`);
    return {bytes:await resource(path),url:`http://source.invalid${path}`};
  };
  const release=parseRelease(await resource('/release'));
  const snapshot=await collectRelease({release,releasePath:'/release',registry,fetch});
  assert.equal(snapshot.complete,true);
  const reuse=snapshot.relationships.find(item=>item.from.id==='q1'&&item.layer==='universe');
  assert.equal(reuse.requested.id,'u1');
  assert.equal(reuse.basis,'exact_version');
  assert.ok(snapshot.objects.some(item=>item.identity.id==='u1'));
});

test('引用指向的对象类型不符时留缺，不当作该层依据',async()=>{
  const registry=parseRegistry(await resource('/registry'));
  const universe='<d:QuestionItem xmlns:d="ddi:reusable:3_3" agencyID="school-a" id="u1" version="2">'+
    '<d:Label>仅全职人员</d:Label></d:QuestionItem>';
  const fetch=async path=>{
    if(path==='/objects/u1') return {bytes:Buffer.from(universe),url:'http://source.invalid/objects/u1'};
    const item=manifest.resources[path];
    if(!item) throw new Error(`unexpected_path_${path}`);
    return {bytes:await resource(path),url:`http://source.invalid${path}`};
  };
  const release=parseRelease(await resource('/release'));
  const snapshot=await collectRelease({release,releasePath:'/release',registry,fetch});
  const gap=snapshot.gaps.find(item=>item.layer==='universe');
  assert.equal(gap.status,'kind_mismatch');
  assert.equal(gap.expectedKind,'Universe');
  assert.equal(gap.actualKind,'QuestionItem');
  assert.equal(snapshot.variables[0].complete,false);
});

test('嵌套引用缺依据时只按注册表解析，不额外拉取未登记对象',async()=>{
  const registry=parseRegistry(await resource('/registry'));
  const question='<d:QuestionItem xmlns:d="ddi:reusable:3_3" agencyID="school-a" id="q1" version="1">'+
    '<d:Label>当前的就业状态？</d:Label><d:UniverseReference agencyID="school-a" id="missing" version="1" url="/objects/other"/></d:QuestionItem>';
  const fetched=[];
  const fetch=async path=>{
    fetched.push(path);
    if(path==='/objects/q1') return {bytes:Buffer.from(question),url:'http://source.invalid/objects/q1'};
    const item=manifest.resources[path];
    if(!item) throw new Error(`unexpected_path_${path}`);
    return {bytes:await resource(path),url:`http://source.invalid${path}`};
  };
  const release=parseRelease(await resource('/release'));
  const snapshot=await collectRelease({release,releasePath:'/release',registry,fetch});
  assert.equal(snapshot.complete,false);
  assert.equal(fetched.includes('/objects/other'),false);
  const gap=snapshot.gaps.find(item=>item.layer==='universe');
  assert.equal(gap.status,'missing');
  assert.equal(gap.requested.id,'missing');
  assert.equal(gap.declaredUrl,'/objects/other');
});

test('声明地址与注册表地址不一致时保留双方证据而不擅自取一',async()=>{
  const index=indexRegistry(parseRegistry(await resource('/registry')));
  const conflict=resolveReference(index,{agency:'school-a',id:'q1',version:'1',url:'/objects/other'});
  assert.equal(conflict.status,'url_conflict');
  assert.equal(conflict.resolved,null);
  assert.deepEqual(conflict.candidates.map(item=>item.source).sort(),['declared','registry']);
  const same=resolveReference(index,{agency:'school-a',id:'q1',version:'1',url:'/objects/q1'});
  assert.equal(same.status,'resolved');
  assert.equal(same.basis,'exact_version');
});
