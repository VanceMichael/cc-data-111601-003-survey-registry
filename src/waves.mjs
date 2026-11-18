import { inspect } from './reader.mjs';

const identityOf = entry => ({ agency: entry.agency, id: entry.id, version: entry.version });
const tripleKey = identity => JSON.stringify([identity.agency, identity.id, identity.version]);
const pairKey = identity => JSON.stringify([identity.agency, identity.id]);
const sameIdentity = (left, right) => Boolean(left && right) &&
  left.agency === right.agency && left.id === right.id && left.version === right.version;

function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function versionText(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes);
  } catch {
    throw new Error(code);
  }
}

export function layerFor(role) {
  const base = typeof role === 'string' && role.endsWith('Reference')
    ? role.slice(0, -'Reference'.length)
    : role;
  if (!base) return 'reference';
  return base.charAt(0).toLowerCase() + base.slice(1);
}

// The exchange subset names its references after the object kind they point
// at. A resolved object of another kind means the layer evidence is wrong,
// even when agency/id/version happen to match.
const expectedKinds = new Map([
  ['QuestionReference', 'QuestionItem'],
  ['UniverseReference', 'Universe'],
  ['CodeSchemeReference', 'CodeScheme'],
  ['VariableSchemeReference', 'VariableScheme']
]);

export function normalizeReference(reference, role = reference?.role) {
  const chosenRole = text(role) ?? 'Reference';
  const url = text(reference?.url);
  return {
    role: chosenRole,
    layer: layerFor(chosenRole),
    agency: text(reference?.agency),
    id: text(reference?.id),
    version: versionText(reference?.version),
    ...(url ? { url } : {})
  };
}

export function parseCatalog(bytes) {
  const document = parseJson(bytes, 'catalog_json');
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('catalog_document');
  if (!text(document.entry) || !text(document.registry)) throw new Error('catalog_contract');
  return { entry: document.entry, registry: document.registry };
}

export function parseRelease(bytes) {
  const document = parseJson(bytes, 'release_json');
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('release_document');
  const identity = {
    agency: text(document.agency),
    id: text(document.id),
    version: versionText(document.version)
  };
  if (!identity.agency || !identity.id || !identity.version) throw new Error('release_identity');
  if (!Array.isArray(document.references)) throw new Error('release_references');
  const references = document.references.map(reference => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
      throw new Error('release_reference');
    }
    const normalized = normalizeReference(reference, reference.role ?? 'ReleaseReference');
    if (!normalized.agency || !normalized.id) throw new Error('release_reference');
    return normalized;
  });
  return { identity, references };
}

export function parseRegistry(bytes) {
  const document = parseJson(bytes, 'registry_json');
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('registry_document');
  if (!Array.isArray(document.objects)) throw new Error('registry_objects');
  const objects = document.objects.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('registry_object');
    const normalized = {
      agency: text(entry.agency),
      id: text(entry.id),
      version: versionText(entry.version),
      url: text(entry.url)
    };
    if (!normalized.agency || !normalized.id || !normalized.version || !normalized.url) {
      throw new Error('registry_object');
    }
    return normalized;
  });
  return { objects };
}

export function indexRegistry(registry) {
  const byPair = new Map();
  for (const entry of registry.objects) {
    const key = pairKey(entry);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(entry);
  }
  return { byPair, size: registry.objects.length };
}

const candidateOf = entry => ({ ...identityOf(entry), url: entry.url });

/**
 * Resolve a reference using registry identity only, falling back to an
 * explicitly declared URL when the registry does not list the object.
 *
 * - A stated version must match exactly. A newer object is never substituted.
 * - An omitted version resolves only when the same agency and id have a single
 *   registered version, and the basis is kept for the caller.
 * - A declared URL with no registry entry is usable only for the release entry
 *   itself, and only when the reference states its full identity; nested
 *   references are resolved through the registry so an unreferenced object is
 *   never pulled into the snapshot.
 * - Equal ids at another agency are never candidates, even when labels match.
 */
export function resolveReference(index, reference, { allowDeclaredUrl = false } = {}) {
  const requested = { agency: reference.agency, id: reference.id, version: reference.version };
  if (!reference.agency || !reference.id) {
    return { requested, status: 'missing', reason: 'incomplete_reference', resolved: null, candidates: [] };
  }
  const matchingPair = index.byPair.get(pairKey(reference)) ?? [];
  const declared = allowDeclaredUrl && reference.url && reference.version
    ? { ...requested, url: reference.url }
    : null;
  if (reference.version === null) {
    const versions = [...new Set(matchingPair.map(entry => entry.version))];
    if (matchingPair.length === 0) {
      return { requested, status: 'missing', reason: 'not_in_registry', resolved: null, candidates: [] };
    }
    if (versions.length > 1) {
      return { requested, status: 'ambiguous_version', reason: 'multiple_registered_versions',
        resolved: null, candidates: matchingPair.map(candidateOf) };
    }
    if (matchingPair.length > 1) {
      return { requested, status: 'ambiguous_registry', reason: 'duplicate_registry_entries',
        resolved: null, candidates: matchingPair.map(candidateOf) };
    }
    return { requested, status: 'resolved', reason: null, basis: 'single_registry_match',
      resolved: candidateOf(matchingPair[0]), candidates: [] };
  }
  const matchingVersion = matchingPair.filter(entry => entry.version === reference.version);
  if (matchingVersion.length === 0) {
    if (declared) {
      return { requested, status: 'resolved', reason: null, basis: 'declared_url',
        resolved: declared, candidates: [] };
    }
    return { requested, status: 'missing', reason: 'not_in_registry', resolved: null, candidates: [] };
  }
  if (matchingVersion.length > 1) {
    return { requested, status: 'ambiguous_registry', reason: 'duplicate_registry_entries',
      resolved: null, candidates: matchingVersion.map(candidateOf) };
  }
  if (reference.url && reference.url !== matchingVersion[0].url) {
    // Two addresses for the same identity: keep both as evidence instead of
    // silently preferring one, since only the registry can be verified.
    return { requested, status: 'url_conflict', reason: 'declared_and_registry_urls_differ',
      resolved: null,
      candidates: [{ ...identityOf(matchingVersion[0]), url: reference.url, source: 'declared' },
        { ...candidateOf(matchingVersion[0]), source: 'registry' }] };
  }
  return { requested, status: 'resolved', reason: null, basis: 'exact_version',
    resolved: candidateOf(matchingVersion[0]), candidates: [] };
}

function gapFrom(edge, extra = {}) {
  return {
    layer: edge.layer,
    role: edge.role,
    requested: edge.requested,
    status: edge.status,
    reason: edge.reason ?? null,
    from: edge.from,
    ...(edge.candidates ? { candidates: edge.candidates } : {}),
    ...(edge.actualIdentity ? { actualIdentity: edge.actualIdentity } : {}),
    ...(edge.expectedKind ? { expectedKind: edge.expectedKind, actualKind: edge.actualKind } : {}),
    ...(edge.declaredUrl ? { declaredUrl: edge.declaredUrl } : {}),
    ...(edge.via ? { via: edge.via } : {}),
    ...extra
  };
}

/** A short human-readable statement of which layer and basis is missing. */
export function describeGap(gap) {
  const subject = `${gap.requested?.agency ?? '?'}:${gap.requested?.id ?? '?'}` +
    (gap.requested?.version ? `@${gap.requested.version}` : '');
  if (gap.status === 'ambiguous_version') {
    return `${gap.layer} 依据不唯一：${subject} 未注明版本，注册表中有多个版本`;
  }
  if (gap.status === 'ambiguous_registry') {
    return `${gap.layer} 依据不唯一：${subject} 在注册表中有多条记录`;
  }
  if (gap.status === 'url_conflict') {
    return `${gap.layer} 依据地址冲突：${subject} 的声明地址与注册表地址不一致`;
  }
  if (gap.status === 'identity_mismatch') {
    return `${gap.layer} 身份不符：请求 ${subject} 但响应为另一对象`;
  }
  if (gap.status === 'kind_mismatch') {
    return `${gap.layer} 依据类型不符：${subject} 应为 ${gap.expectedKind}，实际为 ${gap.actualKind}`;
  }
  if (gap.status === 'unavailable') {
    return `${gap.layer} 依据未取回：${subject}（${gap.reason}）`;
  }
  if (gap.status === 'unreadable') {
    return `${gap.layer} 依据不可解释：${subject}（${gap.reason}）`;
  }
  if (gap.status === 'cycle') {
    return `${gap.layer} 依据循环：${subject} 再次引用已展开的对象`;
  }
  if (gap.status === 'not_stored') {
    return `${gap.layer} 依据未保存：${subject}（${gap.reason}）`;
  }
  if (gap.reason === 'incomplete_reference') {
    return `${gap.layer} 依据不完整：引用缺少机构或标识`;
  }
  return `${gap.layer} 依据缺失：${subject}（${gap.reason ?? gap.status}）`;
}

class Collector {
  constructor({ registry, fetch, save }) {
    this.index = indexRegistry(registry);
    this.fetch = fetch;
    this.save = save;
    this.objects = [];
    this.variables = [];
    this.relationships = [];
    this.gaps = [];
    this.cache = new Map();
    this.loading = new Set();
  }

  recordGap(edge) {
    const gap = { ...gapFrom(edge), description: describeGap(edge) };
    // Several variables can depend on the same missing edge; keep one gap
    // entry per distinct basis and let variableKeys accumulate below.
    const marker = JSON.stringify([gap.from, gap.layer, gap.role, gap.requested,
      gap.status, gap.reason]);
    const existing = this.gaps.find(candidate =>
      JSON.stringify([candidate.from, candidate.layer, candidate.role, candidate.requested,
        candidate.status, candidate.reason]) === marker);
    if (existing) return existing;
    this.gaps.push(gap);
    return gap;
  }

  async resolveEdge(from, reference, { layerForNode = null, allowDeclaredUrl = false } = {}) {
    const resolution = resolveReference(this.index, reference, { allowDeclaredUrl });
    const edge = {
      from: { ...from },
      role: reference.role,
      layer: reference.layer,
      requested: {
        agency: reference.agency,
        id: reference.id,
        version: reference.version
      },
      ...(reference.url ? { declaredUrl: reference.url } : {}),
      status: resolution.status,
      basis: resolution.basis ?? null,
      resolved: resolution.resolved ? identityOf(resolution.resolved) : null,
      reason: resolution.reason ?? null,
      digest: null,
      objectComplete: null,
      ...(resolution.candidates.length > 0 ? { candidates: resolution.candidates } : {})
    };
    if (resolution.status !== 'resolved') {
      this.relationships.push(edge);
      this.recordGap(edge);
      return { edge, node: null };
    }
    const loaded = await this.loadObject(resolution.resolved);
    const node = loaded.node;
    if (layerForNode && node.kind) edge.layer = layerForNode(node);
    edge.digest = node.digest ?? null;
    const expectedKind = expectedKinds.get(reference.role);
    if (node.status === 'identity_mismatch') {
      // The identity check in readObject is stricter than the kind check and
      // must win: the bytes describe a different maintainable object.
      edge.status = node.status;
      edge.reason = node.reason ?? null;
      edge.objectComplete = false;
      if (node.actualIdentity) edge.actualIdentity = node.actualIdentity;
      this.relationships.push(edge);
      this.recordGap(edge);
      return { edge, node };
    }
    if (expectedKind && node.kind && node.kind !== expectedKind) {
      edge.status = 'kind_mismatch';
      edge.reason = 'response_kind_differs';
      edge.expectedKind = expectedKind;
      edge.actualKind = node.kind;
      edge.objectComplete = false;
      this.relationships.push(edge);
      this.recordGap(edge);
      return { edge, node };
    }
    if (node.status !== 'resolved' && node.status !== 'partial') {
      edge.status = node.status;
      edge.reason = node.reason ?? null;
      edge.objectComplete = false;
      if (node.actualIdentity) edge.actualIdentity = node.actualIdentity;
      this.relationships.push(edge);
      this.recordGap(edge);
      return { edge, node };
    }
    // A partial object resolved, but its own leaf gaps are propagated by the
    // caller; do not manufacture a duplicate gap for this edge.
    edge.objectComplete = node.complete;
    this.relationships.push(edge);
    return { edge, node };
  }

  async loadObject(entry) {
    const key = tripleKey(entry);
    if (this.loading.has(key)) {
      return {
        node: {
          identity: identityOf(entry), kind: null, label: [], url: entry.url,
          digest: null, recordId: null, status: 'cycle', reason: 'reference_cycle',
          complete: false, references: [], gaps: []
        },
        parsed: null
      };
    }
    if (this.cache.has(key)) return this.cache.get(key);
    const pending = this.readObject(entry);
    this.cache.set(key, pending);
    this.loading.add(key);
    try {
      return await pending;
    } finally {
      this.loading.delete(key);
    }
  }

  async readObject(entry) {
    const requested = identityOf(entry);
    let result;
    try {
      result = await this.fetch(entry.url);
    } catch (error) {
      return { node: {
        identity: requested, kind: null, label: [], url: entry.url, digest: null, recordId: null,
        status: 'unavailable', reason: error.message, complete: false, references: [], gaps: []
      }, parsed: null };
    }
    let parsed;
    try {
      parsed = inspect(result.bytes);
    } catch (error) {
      return { node: {
        identity: requested, kind: null, label: [], url: entry.url, digest: null, recordId: null,
        status: 'unreadable', reason: error.message, complete: false, references: [], gaps: []
      }, parsed: null };
    }
    if (!sameIdentity(parsed.identity, entry)) {
      return { node: {
        identity: requested, kind: parsed.kind, label: parsed.label ?? [], url: entry.url,
        digest: null, recordId: null, status: 'identity_mismatch',
        reason: 'response_identity_differs', actualIdentity: parsed.identity,
        complete: false, references: [], gaps: []
      }, parsed };
    }
    let stored = null;
    if (this.save) {
      try {
        stored = await this.save(result.bytes, entry.url, parsed);
      } catch (error) {
        return { node: {
          identity: identityOf(parsed.identity), kind: parsed.kind, label: parsed.label ?? [],
          url: entry.url, digest: null, recordId: null, status: 'not_stored',
          reason: error.message, complete: false, references: [], gaps: []
        }, parsed };
      }
    }
    const node = {
      identity: identityOf(parsed.identity),
      kind: parsed.kind,
      label: parsed.label ?? [],
      url: entry.url,
      digest: stored?.digest ?? null,
      recordId: stored?.recordId ?? null,
      status: 'resolved',
      complete: true,
      references: [],
      gaps: []
    };
    this.objects.push(node);
    for (const raw of parsed.references ?? []) {
      const reference = normalizeReference(raw, raw.role);
      const { edge, node: child } = await this.resolveEdge(node.identity, reference);
      node.references.push(edge);
      if (edge.status !== 'resolved') {
        node.gaps.push(gapFrom(edge));
      } else if (child && child.complete === false) {
        for (const gap of child.gaps) node.gaps.push(gapFrom(gap, { via: edge.layer }));
      }
    }
    node.complete = node.gaps.length === 0;
    node.status = node.complete ? 'resolved' : 'partial';
    if (!node.complete) {
      for (const gap of node.gaps) gap.description ??= describeGap(gap);
      node.description = node.gaps.map(gap => gap.description).join('；');
    }
    if (parsed.kind === 'VariableScheme') await this.collectVariables(node, parsed.variables ?? []);
    return { node, parsed };
  }

  async collectVariables(scheme, variables) {
    for (const [index, variable] of variables.entries()) {
      const variableId = text(variable.id);
      const key = [
        scheme.identity.agency, scheme.identity.id, scheme.identity.version,
        variableId ?? '', index
      ].join('|');
      const record = {
        key,
        variableId,
        scheme: { ...scheme.identity },
        label: Array.isArray(variable.label) ? [...variable.label] : [],
        status: 'complete',
        complete: true,
        references: [],
        gaps: []
      };
      const seen = new Set();
      const addGap = gap => {
        const marker = JSON.stringify([gap.layer, gap.role, gap.requested, gap.from]);
        if (seen.has(marker)) return;
        seen.add(marker);
        record.gaps.push(gap);
      };
      for (const raw of variable.references ?? []) {
        const reference = normalizeReference(raw, raw.role);
        const { edge, node } = await this.resolveEdge(scheme.identity, reference);
        record.references.push({
          role: edge.role,
          layer: edge.layer,
          requested: edge.requested,
          status: edge.status,
          complete: edge.status === 'resolved' && edge.objectComplete === true,
          basis: edge.basis,
          resolved: edge.resolved,
          reason: edge.reason,
          digest: edge.digest,
          kind: node?.kind ?? null,
          label: node?.label ?? null,
          ...(edge.candidates ? { candidates: edge.candidates } : {})
        });
        if (edge.status !== 'resolved') {
          addGap({ ...gapFrom(edge, { variableKey: key }), description: describeGap(edge) });
        } else if (edge.objectComplete === false && node) {
          for (const gap of node.gaps) {
            addGap({ ...gapFrom(gap, { variableKey: key, via: edge.layer }),
              description: describeGap(gap) });
          }
        }
      }
      record.complete = record.gaps.length === 0;
      record.status = record.complete ? 'complete' : 'incomplete';
      if (!record.complete) record.description = record.gaps.map(gap => gap.description).join('；');
      this.variables.push(record);
    }
  }

  annotateAffectedVariables() {
    for (const variable of this.variables) {
      for (const gap of variable.gaps) {
        const target = this.gaps.find(candidate =>
          sameIdentity(candidate.from, gap.from) &&
          candidate.layer === gap.layer &&
          candidate.role === gap.role &&
          candidate.status === gap.status &&
          candidate.reason === gap.reason &&
          candidate.requested?.agency === gap.requested?.agency &&
          candidate.requested?.id === gap.requested?.id &&
          candidate.requested?.version === gap.requested?.version);
        if (!target) continue;
        target.variableKeys ??= [];
        if (!target.variableKeys.includes(variable.key)) target.variableKeys.push(variable.key);
      }
    }
  }
}

/**
 * Collect every object actually reachable from one release entry, preserving
 * agency/id/version and the edges by which each object was reused.
 *
 * The returned snapshot is deliberately partial-tolerant: a variable whose
 * question, universe or code scheme cannot be resolved stays in `variables`
 * with `complete: false` and an item in `gaps` naming the missing layer. No
 * object is read from outside the source registry and no version is guessed.
 */
export async function collectRelease({
  release, releasePath = null, registry, catalog = null, evidence = {}, fetch, save = null
}) {
  if (typeof fetch !== 'function') throw new Error('fetch_required');
  const collector = new Collector({ registry, fetch, save });
  for (const reference of release.references) {
    // The entry reference's declared role is generic; use the resolved object's
    // kind so the release -> scheme reuse edge names the layer it carries.
    await collector.resolveEdge(release.identity, reference, {
      layerForNode: node => layerFor(`${node.kind}Reference`),
      allowDeclaredUrl: true
    });
  }
  collector.annotateAffectedVariables();
  const completeVariables = collector.variables.filter(variable => variable.complete).length;
  return {
    catalog: catalog ?? evidence.catalog ?? null,
    entry: {
      path: releasePath,
      identity: { ...release.identity },
      digest: evidence.release?.digest ?? null,
      recordId: evidence.release?.recordId ?? null
    },
    registry: {
      path: evidence.registry?.path ?? null,
      objectCount: collector.index.size,
      digest: evidence.registry?.digest ?? null,
      recordId: evidence.registry?.recordId ?? null
    },
    status: collector.gaps.length === 0 ? 'complete' : 'incomplete',
    complete: collector.gaps.length === 0,
    summary: collector.gaps.length === 0
      ? '入口引用的对象及变量依据均已取回'
      : collector.gaps.map(gap => gap.description).join('；'),
    counts: {
      objects: collector.objects.length,
      variables: collector.variables.length,
      completeVariables,
      incompleteVariables: collector.variables.length - completeVariables,
      gaps: collector.gaps.length
    },
    objects: collector.objects,
    variables: collector.variables,
    relationships: collector.relationships,
    gaps: collector.gaps
  };
}
