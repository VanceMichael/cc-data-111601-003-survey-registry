import { parseXml, local, descendants, content } from './xml.mjs';

const isReference = node => local(node).endsWith('Reference');

function referenceOf(node) {
  return {
    role: local(node),
    agency: node.attrs.agencyID ?? node.attrs.agency ?? null,
    id: node.attrs.id ?? null,
    version: node.attrs.version ?? null,
    url: node.attrs.url ?? node.attrs.href ?? null
  };
}

function directLabels(node) {
  return node.children.filter(child => local(child) === 'Label').map(content);
}

function nestedReferences(node) {
  const found = [];
  const visit = child => {
    if (isReference(child)) { found.push(referenceOf(child)); return; }
    // Variable references are reported on the variable record itself.
    if (local(child) === 'Variable') return;
    for (const grandchild of child.children) visit(grandchild);
  };
  for (const child of node.children) visit(child);
  return found;
}

export function inspect(bytes) {
  const root = parseXml(bytes);
  if (!root.attrs.agencyID || !root.attrs.id || !root.attrs.version) throw new Error('maintainable_identity');
  const label = directLabels(root);
  const variables = descendants(root, 'Variable').map(variable => {
    const variableLabels = directLabels(variable);
    return {
      id: variable.attrs.id ?? null,
      label: variableLabels,
      labels: variableLabels,
      references: variable.children.filter(isReference).map(referenceOf)
    };
  });
  return {
    kind: local(root),
    identity: { agency: root.attrs.agencyID, id: root.attrs.id, version: root.attrs.version },
    label,
    labels: label,
    attributes: root.attrs,
    references: root.children.filter(isReference).map(referenceOf),
    nestedReferences: nestedReferences(root),
    variables
  };
}
