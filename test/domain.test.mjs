import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from '../src/reader.mjs';
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
