import { createHash } from 'node:crypto';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';

export const REFERENCE_LAYERS = {
  QuestionReference: 'question',
  UniverseReference: 'universe',
  CodeSchemeReference: 'codeScheme'
};
export const EXPECTED_REFERENCE_ROLES = Object.freeze([
  'QuestionReference', 'UniverseReference', 'CodeSchemeReference'
]);
const EXPECTED_LAYERS = EXPECTED_REFERENCE_ROLES.map(role => REFERENCE_LAYERS[role]);
const MAX_REFERENCE_DEPTH = 16;

const text = value => value == null || value === '' ? null : String(value);
const firstPresent = (object, keys) => {
  for (const key of keys) {
    if (object && Object.hasOwn(object, key) && object[key] != null) return object[key];
  }
  return null;
};
const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');

export function readIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const nested = value.identity && typeof value.identity === 'object' ? value.identity : value;
  const agency = text(firstPresent(nested, ['agency', 'agencyID', 'agencyId']));
  const id = text(nested.id);
  const version = text(nested.version);
  if (!agency || !id) return null;
  return { agency, id, version };
}

export function identityKey(identity) {
  return JSON.stringify([identity?.agency ?? null, identity?.id ?? null, identity?.version ?? null]);
}

// Attempting to fetch a locator without knowing its exact version would let
// unrelated bytes stand in for an unidentified object, so such references are
// left for a later, more specific collection.
export function sameIdentity(left, right) {
  if (!left || !right) return false;
  return left.agency === right.agency && left.id === right.id
    && left.version != null && right.version != null && left.version === right.version;
}

export function variableKey(scheme, variableId) {
  return JSON.stringify([scheme?.agency ?? null, scheme?.id ?? null,
    scheme?.version ?? null, variableId ?? null]);
}

export function releaseKey(origin, identity) {
  return JSON.stringify([origin, identity?.agency ?? null, identity?.id ?? null,
    identity?.version ?? null]);
}

function normalizeReference(value, index = 0) {
  const identity = readIdentity(value);
  return {
    index,
    role: text(value?.role) ?? null,
    agency: identity?.agency ?? text(firstPresent(value, ['agency', 'agencyID'])),
    id: identity?.id ?? text(value?.id),
    version: identity?.version ?? null,
    url: text(firstPresent(value, ['url', 'href', 'path'])),
    identity: identity ?? (value ? {
      agency: text(firstPresent(value, ['agency', 'agencyID'])),
      id: text(value?.id),
      version: text(value?.version)
    } : null)
  };
}

export function parseRelease(bytes) {
  let value;
  try { value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes); }
  catch { throw new Error('release_json'); }
  const identity = readIdentity(value);
  if (!identity || identity.version == null) throw new Error('release_identity');
  const raw = value.references;
  if (raw == null) return { kind: 'Release', identity, attributes: value, references: [] };
  if (!Array.isArray(raw)) throw new Error('release_references');
  return {
    kind: 'Release',
    identity,
    attributes: value,
    references: raw.map((item, index) => normalizeReference(item, index))
  };
}

export function parseRegistry(bytes) {
  let value;
  try { value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes); }
  catch { throw new Error('registry_json'); }
  const raw = Array.isArray(value) ? value : value?.objects;
  if (!Array.isArray(raw)) throw new Error('registry_objects');
  return {
    kind: 'Registry',
    identity: null,
    objects: raw.map((item, index) => {
      const identity = readIdentity(item);
      return {
        index,
        identity,
        agency: identity?.agency ?? text(firstPresent(item, ['agency', 'agencyID'])),
        id: identity?.id ?? text(item?.id),
        version: identity?.version ?? null,
        url: text(firstPresent(item, ['url', 'href', 'path']))
      };
    }).filter(item => item.agency && item.id)
  };
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = [identityKey(candidate.identity), candidate.url].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const candidateView = candidate => ({
  agency: candidate.agency,
  id: candidate.id,
  version: candidate.version ?? null,
  url: candidate.url
});

/**
 * Resolve one DDI reference against the registry.
 *
 * Explicit versions resolve only to the same agency/id/version. A reference
 * that omits version resolves only when the registry has exactly one object
 * for that same agency and id; the basis is returned so the choice can be
 * audited. The newest version is never selected implicitly, and objects from
 * another agency are never treated as interchangeable.
 */
export function resolveReference(reference, registry) {
  const role = text(reference?.role) ?? null;
  const identity = reference?.identity ?? readIdentity(reference);
  const requested = {
    agency: text(reference?.agency) ?? identity?.agency ?? null,
    id: text(reference?.id) ?? identity?.id ?? null,
    version: text(reference?.version) ?? identity?.version ?? null
  };
  const base = { role, layer: REFERENCE_LAYERS[role] ?? null, requested, candidates: [] };
  if (!requested.agency || !requested.id) {
    return { ...base, status: 'unresolved', reason: 'invalid_reference', evidence: null };
  }
  if (!registry || registry.status !== 'available') {
    return { ...base, status: 'unresolved',
      reason: registry?.reason ?? 'registry_unavailable', evidence: null };
  }
  const sameAgency = uniqueCandidates((registry.objects ?? [])
    .filter(item => item.agency === requested.agency && item.id === requested.id));
  const otherAgency = uniqueCandidates((registry.objects ?? [])
    .filter(item => item.agency !== requested.agency && item.id === requested.id));
  const evidence = {
    requestedVersion: requested.version,
    omittedVersion: requested.version == null,
    sameAgencyCount: sameAgency.length,
    availableVersions: [...new Set(sameAgency.map(item => item.version).filter(version => version != null))],
    ignoredOtherAgencyCount: otherAgency.length
  };
  const candidates = sameAgency.map(candidateView);
  const found = (candidate, basis) => ({
    ...base,
    status: candidate.url ? 'resolved' : 'unresolved',
    ...(candidate.url ? {} : { reason: 'registry_url_missing' }),
    basis: candidate.url ? basis : null,
    resolved: { agency: candidate.agency, id: candidate.id, version: candidate.version ?? null },
    url: candidate.url ?? null,
    candidates,
    evidence
  });

  if (requested.version != null) {
    const exact = sameAgency.filter(item => item.version === requested.version);
    if (exact.length === 1) return found(exact[0], 'exact_version');
    if (exact.length > 1) {
      return { ...base, status: 'unresolved', reason: 'ambiguous_registry_entry',
        candidates: exact.map(candidateView), evidence };
    }
    return { ...base, status: 'unresolved', reason: 'version_not_found', candidates, evidence };
  }
  if (sameAgency.length === 1 && sameAgency[0].version != null) {
    return found(sameAgency[0], 'unique_registry_version');
  }
  return {
    ...base,
    status: 'unresolved',
    reason: sameAgency.length === 0 ? 'not_found'
      : sameAgency.length === 1 ? 'version_unknown' : 'ambiguous_version',
    candidates,
    evidence
  };
}

/**
 * Resolve a reference, accepting its own locator only when the reference
 * states an exact version. The locator is never used to infer a version.
 */
export function resolveReferenceOrLocator(reference, registry) {
  const resolution = resolveReference(reference, registry);
  if (resolution.status === 'resolved') return resolution;
  const url = text(reference?.url);
  const requested = resolution.requested;
  if (url && requested.version != null) {
    return {
      ...resolution,
      status: 'resolved',
      reason: null,
      basis: 'reference_url',
      resolved: { ...requested },
      url,
      candidates: resolution.candidates ?? []
    };
  }
  return resolution;
}

function objectView(parsed, extra = {}) {
  return {
    identity: parsed.identity,
    kind: parsed.kind,
    label: parsed.label ?? [],
    labels: parsed.labels ?? parsed.label ?? [],
    references: parsed.references ?? [],
    nestedReferences: parsed.nestedReferences ?? [],
    ...(parsed.nested ? { nested: parsed.nested } : {}),
    ...(parsed.variables?.length ? { variables: parsed.variables } : {}),
    ...extra
  };
}

function missingEntry(level, layer, role, reason, details = {}) {
  return { level, layer, role, reason, ...details };
}

/**
 * Collect one published release.
 *
 * The release entry is the only starting point. Every variable keeps its own
 * record keyed by the maintainable scheme identity plus the variable id (never
 * by label). All three referenced layers, and the further references carried
 * by those objects, are resolved/fetched independently. An unavailable or
 * ambiguous layer leaves the variable and the wave marked incomplete, with the
 * missing layer and the evidence that was available; it is never filled from
 * another version or another agency.
 */
export async function collectWave(options) {
  const { source, store, now = () => new Date().toISOString() } = options ?? {};
  if (typeof source !== 'string' || !source) throw new Error('source_required');
  const origin = new URL(source);
  if (!origin.protocol.startsWith('http')) throw new Error('source_required');

  let catalog = null;
  let path = options.path ?? options.entry ?? null;
  if (path == null) {
    try {
      const response = await acquire(source, '/catalog');
      catalog = JSON.parse(Buffer.isBuffer(response.bytes)
        ? response.bytes.toString('utf8') : response.bytes);
    } catch (error) {
      throw new Error(error.message === 'source_status_404' ? 'entry_required' : error.message);
    }
    path = catalog?.entry ?? null;
  }
  if (typeof path !== 'string' || path === '') throw new Error('entry_required');

  const releaseResponse = await acquire(source, path);
  const releaseParsed = parseRelease(releaseResponse.bytes);
  const releaseUrl = new URL(path, origin).href;
  const collectedAt = now();

  let registry;
  try {
    const response = await acquire(source, catalog?.registry ?? '/registry');
    registry = { status: 'available', ...parseRegistry(response.bytes) };
  } catch (error) {
    registry = { status: 'unavailable', reason: error.message, objects: [] };
  }

  const missing = [];
  const objects = new Map();
  const fetchCache = new Map();
  const variables = [];
  const schemes = [];

  const addMissing = entry => { missing.push(entry); return entry; };

  const rememberObject = async (bytes, url, parsed) => {
    const objectDigest = digestOf(bytes);
    if (store?.retain) await store.retain(bytes);
    let object = objects.get(objectDigest);
    if (!object) {
      object = objectView(parsed, { digest: objectDigest, url,
        urls: [], referencedBy: [], nested: [] });
      objects.set(objectDigest, object);
    }
    if (!object.urls.includes(url)) object.urls.push(url);
    return object;
  };

  const attach = (object, referencedBy, role) => {
    const relation = { ...referencedBy, role };
    const relationKey = JSON.stringify(relation);
    if (!object.referencedBy.some(item => JSON.stringify(item) === relationKey)) {
      object.referencedBy.push(relation);
    }
  };

  // Loading is keyed by absolute URL so a DDI object reused by several
  // variables/releases is fetched once per collection; every use is kept in
  // referencedBy. The nested walk is repeated for each use because cycle
  // detection depends on the ancestry that led to the object.
  const loadObject = async (absolute, expected, ancestry) => {
    const expectedKey = identityKey(expected);
    if (ancestry.urls.has(absolute) || ancestry.identities.has(expectedKey)) {
      return { status: 'cycle', identity: expected, url: absolute, missing: [] };
    }
    if (!fetchCache.has(absolute)) {
      fetchCache.set(absolute, (async () => {
        let response;
        try { response = await acquire(source, absolute); }
        catch (error) { return { status: 'unresolved', reason: error.message, url: absolute, missing: [] }; }
        let parsed;
        try { parsed = inspect(response.bytes); }
        catch (error) { return { status: 'unresolved', reason: error.message, url: absolute, missing: [] }; }
        const object = await rememberObject(response.bytes, absolute, parsed);
        return { status: 'collected', object };
      })());
    }
    const loaded = await fetchCache.get(absolute);
    if (loaded.status !== 'collected') return loaded;
    if (!sameIdentity(loaded.object.identity, expected)) {
      return { status: 'unresolved', reason: 'identity_mismatch', url: absolute,
        expected, observed: loaded.object.identity, missing: [] };
    }
    const { nested, nestedMissing } = await walkNested(loaded.object, ancestry);
    loaded.object.nested = nested;
    return { status: 'collected', object: loaded.object, missing: nestedMissing };
  };

  const walkNested = async (object, ancestry) => {
    const nestedMissing = [];
    const nested = [];
    if (ancestry.depth >= MAX_REFERENCE_DEPTH) {
      nestedMissing.push(missingEntry('object', null, null, 'reference_depth_exceeded', {
        object: object.identity, url: object.url, digest: object.digest }));
      return { nested, nestedMissing };
    }
    for (const nestedReference of object.nestedReferences ?? []) {
      const resolution = resolveReferenceOrLocator(nestedReference, registry);
      const record = {
        role: nestedReference.role,
        layer: resolution.layer,
        status: 'unresolved',
        requested: resolution.requested,
        resolved: resolution.resolved ?? null,
        basis: resolution.basis ?? null,
        evidence: resolution.evidence ?? null,
        candidates: resolution.candidates ?? [],
        url: resolution.url ?? null,
        reason: null,
        children: []
      };
      if (resolution.status !== 'resolved') {
        record.reason = resolution.reason;
        nestedMissing.push(missingEntry('object', resolution.layer, nestedReference.role,
          resolution.reason, { object: object.identity, url: object.url,
            requested: resolution.requested, candidates: resolution.candidates,
            evidence: resolution.evidence }));
        nested.push(record);
        continue;
      }
      const next = {
        urls: new Set([...ancestry.urls, object.url]),
        identities: new Set([...ancestry.identities, identityKey(object.identity)]),
        depth: ancestry.depth + 1
      };
      const child = await loadObject(new URL(resolution.url, origin).href,
        resolution.resolved, next);
      if (child.status === 'cycle') {
        record.status = 'cycle';
        record.identity = child.identity;
        record.url = child.url;
      } else if (child.status === 'unresolved') {
        record.reason = child.reason;
        record.url = child.url;
        record.expected = child.expected ?? resolution.resolved;
        record.observed = child.observed ?? null;
        nestedMissing.push(missingEntry('object', resolution.layer, nestedReference.role,
          child.reason, { object: object.identity, url: object.url,
            requested: resolution.requested, resolved: resolution.resolved,
            childUrl: child.url, expected: child.expected, observed: child.observed }));
      } else {
        record.status = 'collected';
        record.identity = child.object.identity;
        record.digest = child.object.digest;
        record.url = child.object.url;
        record.object = child.object;
        attach(child.object, { level: 'object', object: object.identity,
          digest: object.digest }, nestedReference.role);
        record.children = child.nested ?? [];
        nestedMissing.push(...(child.missing ?? []));
      }
      nested.push(record);
    }
    return { nested, nestedMissing };
  };

  // Kept for the release entry: the scheme fetch is cached and every user is
  // attached after the fact so reuse relations stay complete.
  const fetchObject = async (url, expected, role, referencedBy) => {
    const absolute = new URL(url, origin).href;
    const result = await loadObject(absolute, expected,
      { urls: new Set(), identities: new Set(), depth: 0 });
    if (result.status === 'collected') attach(result.object, referencedBy, role);
    return result;
  };

  // Wave members are retained under their digest so they can be re-read from
  // /objects/{digest}, but they are not added to the single-object intake
  // index: /records keeps describing exactly what was accepted one by one.
  if (store?.retain) await store.retain(releaseResponse.bytes);
  const entry = {
    path,
    url: releaseUrl,
    digest: digestOf(releaseResponse.bytes),
    identity: releaseParsed.identity,
    references: releaseParsed.references,
    objects: []
  };

  if (releaseParsed.references.length === 0) {
    addMissing(missingEntry('release', 'variableScheme', 'VariableSchemeReference',
      'no_variable_scheme_references', { requested: releaseParsed.identity }));
  }

  for (const releaseReference of releaseParsed.references) {
    const role = releaseReference.role ?? 'VariableSchemeReference';
    const requested = releaseReference.identity;
    if (!requested) {
      addMissing(missingEntry('release', role, role, 'invalid_reference', {
        requested: { agency: releaseReference.agency, id: releaseReference.id,
          version: releaseReference.version } }));
      continue;
    }

    let target;
    let basis;
    if (requested.version == null) {
      // An omitted version is only resolvable from a registry with exactly one
      // same-agency candidate. A locator alone does not identify a version.
      const resolution = resolveReference({ ...releaseReference, role }, registry);
      if (resolution.status !== 'resolved') {
        addMissing(missingEntry('release', 'variableScheme', role, resolution.reason, {
          requested: resolution.requested, candidates: resolution.candidates,
          evidence: resolution.evidence }));
        continue;
      }
      target = { identity: resolution.resolved, url: resolution.url };
      basis = resolution.basis;
    } else if (releaseReference.url) {
      // The release entry itself is the one place where a locator accompanies
      // an exact identity; the fetched root is still checked against it.
      target = { identity: requested, url: releaseReference.url };
      basis = 'release_entry_url';
    } else {
      const resolution = resolveReference({ ...releaseReference, role }, registry);
      if (resolution.status !== 'resolved') {
        addMissing(missingEntry('release', 'variableScheme', role, resolution.reason, {
          requested: resolution.requested, candidates: resolution.candidates,
          evidence: resolution.evidence }));
        continue;
      }
      target = { identity: resolution.resolved, url: resolution.url };
      basis = resolution.basis;
    }

    const fetched = await fetchObject(target.url, target.identity, role,
      { level: 'release', release: releaseParsed.identity });
    if (fetched.status === 'cycle') continue;
    if (fetched.status !== 'collected') {
      addMissing(missingEntry('release', 'variableScheme', role, fetched.reason, {
        requested: target.identity, resolved: target.identity,
        url: fetched.url, expected: fetched.expected, observed: fetched.observed }));
      continue;
    }

    const object = fetched.object;
    entry.objects.push(object.digest);
    for (const item of fetched.missing ?? []) {
      addMissing({ ...item, level: object.kind === 'VariableScheme' ? 'scheme' : 'release',
        ...(object.kind === 'VariableScheme' ? { scheme: object.identity } : {}) });
    }
    if (object.kind !== 'VariableScheme') {
      // The release may also reference non-variable objects directly. They are
      // kept and audited, but do not contribute variables.
      entry.nonVariableObjects = [...(entry.nonVariableObjects ?? []), object.digest];
      continue;
    }
    const scheme = {
      identity: object.identity,
      kind: object.kind,
      label: object.label,
      digest: object.digest,
      url: object.url,
      requested: requested,
      requestedUrl: releaseReference.url ?? null,
      resolution: { status: 'resolved', basis, resolved: object.identity },
      variables: [],
      variableKeys: [],
      nested: object.nested ?? []
    };
    schemes.push(scheme);

    for (const [variableIndex, declaredVariable] of (object.variables ?? []).entries()) {
      const key = variableKey(object.identity,
        declaredVariable.id ?? `#${variableIndex}`);
      const declaredReferences = new Map();
      for (const reference of declaredVariable.references ?? []) {
        if (!declaredReferences.has(reference.role)) declaredReferences.set(reference.role, reference);
      }
      const layers = { question: null, universe: null, codeScheme: null };
      const referenceRecords = [];
      const variableMissing = [];

      if (declaredVariable.id == null) {
        // Without a variable id the record cannot be cited reliably; it keeps
        // its scheme identity and position but stays supplementable.
        variableMissing.push(addMissing(missingEntry('variable', null, null,
          'variable_identity_missing', {
            scheme: object.identity, variableKey: key, variableIndex,
            label: declaredVariable.label ?? []
          })));
      }

      for (const expectedRole of EXPECTED_REFERENCE_ROLES) {
        const layer = REFERENCE_LAYERS[expectedRole];
        const declaredReference = declaredReferences.get(expectedRole);
        if (!declaredReference) {
          const item = addMissing(missingEntry('variable', layer, expectedRole,
            'reference_not_declared', {
              scheme: object.identity, variableKey: key, variableId: declaredVariable.id ?? null,
              requested: { agency: object.identity.agency, id: null, version: null }
            }));
          variableMissing.push(item);
          referenceRecords.push({ role: expectedRole, layer, status: 'unresolved',
            reason: 'reference_not_declared', requested: item.requested,
            resolved: null, basis: null, evidence: null, candidates: [] });
          continue;
        }

        const reference = {
          role: declaredReference.role ?? expectedRole,
          agency: declaredReference.agency,
          id: declaredReference.id,
          version: declaredReference.version,
          identity: declaredReference.identity
        };
        let resolution;
        if (declaredReference.version != null) {
          const exact = resolveReference(reference, registry);
          if (exact.status === 'resolved') resolution = exact;
          else if (declaredReference.url) {
            // A locator does not invent a registry entry, but the reference's
            // own URL can still be fetched; the fetched root must carry the
            // exact declared identity or the layer stays unresolved.
            resolution = {
              role: reference.role, layer, requested: {
                agency: reference.agency, id: reference.id, version: reference.version
              },
              status: 'resolved', basis: 'reference_url', url: declaredReference.url,
              resolved: { agency: reference.agency, id: reference.id, version: reference.version },
              candidates: exact.candidates ?? [], evidence: exact.evidence ?? null
            };
          } else resolution = exact;
        } else {
          resolution = resolveReferenceOrLocator(reference, registry);
        }

        const record = {
          role: reference.role,
          layer,
          status: 'unresolved',
          requested: resolution.requested,
          resolved: resolution.resolved ?? null,
          basis: resolution.basis ?? null,
          evidence: resolution.evidence ?? null,
          candidates: resolution.candidates ?? [],
          url: resolution.url ?? null,
          reason: null,
          complete: false
        };

        if (resolution.status === 'resolved') {
          const fetched = await fetchObject(resolution.url, resolution.resolved, reference.role,
            { level: 'variable', variableKey: key, variableId: declaredVariable.id ?? null,
              scheme: object.identity });
          if (fetched.status === 'collected') {
            record.status = 'collected';
            record.digest = fetched.object.digest;
            record.url = fetched.object.url;
            record.object = objectView(fetched.object, {
              digest: fetched.object.digest,
              url: fetched.object.url
            });
            record.complete = (fetched.missing ?? []).length === 0;
            layers[layer] = record.object;
            for (const nestedItem of fetched.missing ?? []) {
              variableMissing.push(addMissing({ ...nestedItem, level: 'variable', layer,
                variableKey: key, variableId: declaredVariable.id ?? null, scheme: object.identity,
                via: reference.role }));
            }
          } else if (fetched.status === 'cycle') {
            record.status = 'cycle';
            record.identity = fetched.identity;
            record.complete = true;
          } else {
            record.reason = fetched.reason;
            record.url = fetched.url ?? resolution.url;
            if (fetched.expected) record.expected = fetched.expected;
            if (fetched.observed) record.observed = fetched.observed;
            variableMissing.push(addMissing(missingEntry('variable', layer, reference.role,
              fetched.reason, {
                scheme: object.identity, variableKey: key, variableId: declaredVariable.id ?? null,
                requested: resolution.requested, resolved: resolution.resolved,
                url: record.url, expected: fetched.expected, observed: fetched.observed
              })));
          }
        } else {
          record.reason = resolution.reason;
          variableMissing.push(addMissing(missingEntry('variable', layer, reference.role,
            resolution.reason, {
              scheme: object.identity, variableKey: key, variableId: declaredVariable.id ?? null,
              requested: resolution.requested, candidates: resolution.candidates,
              evidence: resolution.evidence
            })));
        }
        referenceRecords.push(record);
      }

      const labels = declaredVariable.label ?? declaredVariable.labels ?? [];
      const variable = {
        key,
        id: declaredVariable.id ?? null,
        index: variableIndex,
        label: labels,
        labels,
        scheme: object.identity,
        status: variableMissing.length === 0 ? 'complete' : 'incomplete',
        complete: variableMissing.length === 0,
        supplementable: variableMissing.length > 0,
        missingLayers: EXPECTED_LAYERS.filter(layer =>
          variableMissing.some(item => item.layer === layer)),
        question: layers.question,
        universe: layers.universe,
        codeScheme: layers.codeScheme,
        layers,
        references: referenceRecords,
        missing: variableMissing
      };
      variables.push(variable);
      scheme.variables.push(variable);
      scheme.variableKeys.push(key);
    }

    if ((object.variables ?? []).length === 0) {
      addMissing(missingEntry('scheme', null, null, 'no_variables', {
        scheme: object.identity, url: object.url, digest: object.digest }));
    }
  }

  if (schemes.length === 0 && missing.length === 0) {
    addMissing(missingEntry('release', 'variableScheme', 'VariableSchemeReference',
      'no_variable_scheme_collected', { requested: releaseParsed.identity }));
  }
  const complete = missing.length === 0 && variables.every(variable => variable.complete);
  return {
    key: releaseKey(origin.origin, releaseParsed.identity),
    status: complete ? 'complete' : 'incomplete',
    complete,
    supplementable: !complete,
    collectedAt,
    entry,
    release: releaseParsed.identity,
    schemes,
    variables,
    objects: [...objects.values()],
    missing,
    missingLayers: [...new Set(missing.map(item => item.layer).filter(Boolean))],
    registry: {
      status: registry.status,
      reason: registry.reason ?? null,
      objectCount: registry.objects?.length ?? 0
    }
  };
}

export const collectRelease = collectWave;
export const collectEntry = collectWave;
export const collect = collectWave;
