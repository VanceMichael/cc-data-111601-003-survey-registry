import { parseXml, local, descendants, content } from './xml.mjs';

function referencesOf(node) {
  return node.children.filter(child => local(child).endsWith('Reference')).map(reference => ({
    role: local(reference), agency: reference.attrs.agencyID, id: reference.attrs.id,
    version: reference.attrs.version ?? null,
    // Keep a declared address so an unresolved reference can still say where
    // the source pointed; it is never fetched without registry/identity checks.
    ...(reference.attrs.url ? { url: reference.attrs.url } : {})
  }));
}

export function inspect(bytes) {
  const root = parseXml(bytes);
  if (!root.attrs.agencyID || !root.attrs.id || !root.attrs.version) throw new Error('maintainable_identity');
  const variables = descendants(root, 'Variable').map(variable => ({
    id: variable.attrs.id,
    label: descendants(variable, 'Label').map(content),
    references: referencesOf(variable)
  }));
  return {
    kind: local(root),
    identity: { agency: root.attrs.agencyID, id: root.attrs.id, version: root.attrs.version },
    label: root.children.filter(child => local(child) === 'Label').map(content),
    // A non-variable object may carry further references. They are part of
    // that object's own definition and must be collected as a separate layer.
    references: referencesOf(root),
    variables
  };
}
