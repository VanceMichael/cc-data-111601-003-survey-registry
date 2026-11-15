import { parseXml, local, descendants, content } from './xml.mjs';
export function inspect(bytes) {
  const root = parseXml(bytes);
  if (!root.attrs.agencyID || !root.attrs.id || !root.attrs.version) throw new Error('maintainable_identity');
  const variables = descendants(root, 'Variable').map(variable => ({
    id: variable.attrs.id,
    label: descendants(variable, 'Label').map(content),
    references: variable.children.filter(child => local(child).endsWith('Reference')).map(reference => ({
      role: local(reference), agency: reference.attrs.agencyID, id: reference.attrs.id,
      version: reference.attrs.version ?? null
    }))
  }));
  return { kind: local(root), identity: { agency: root.attrs.agencyID, id: root.attrs.id, version: root.attrs.version }, variables };
}
