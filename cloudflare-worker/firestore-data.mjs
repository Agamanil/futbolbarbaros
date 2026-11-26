// Firestore REST response decoding and complete collection pagination.
// Kept independent of Worker globals so the transport behavior can be tested in Node.

export function decodeFirestoreValue(value) {
  if (value == null || typeof value !== 'object') return null;
  if (Object.hasOwn(value, 'stringValue')) return value.stringValue;
  if (Object.hasOwn(value, 'integerValue')) return Number(value.integerValue);
  if (Object.hasOwn(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.hasOwn(value, 'booleanValue')) return value.booleanValue;
  if (Object.hasOwn(value, 'timestampValue')) return value.timestampValue;
  if (Object.hasOwn(value, 'nullValue')) return null;
  if (Object.hasOwn(value, 'arrayValue')) {
    const values = value.arrayValue?.values ?? [];
    if (!Array.isArray(values)) throw new TypeError('Firestore arrayValue.values geçersiz.');
    return values.map(decodeFirestoreValue);
  }
  if (Object.hasOwn(value, 'mapValue')) {
    const fields = value.mapValue?.fields ?? {};
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new TypeError('Firestore mapValue.fields geçersiz.');
    }
    return decodeFirestoreFields(fields);
  }
  // Match the Worker’s prior behavior for Firestore value kinds it does not use.
  return null;
}

export function decodeFirestoreFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError('Firestore document fields geçersiz.');
  }
  const output = {};
  for (const [key, value] of Object.entries(fields)) output[key] = decodeFirestoreValue(value);
  return output;
}

export function decodeFirestoreDocument(document) {
  const name = document?.name;
  if (typeof name !== 'string' || !name.includes('/')) {
    throw new TypeError('Firestore document resource name eksik veya geçersiz.');
  }
  const id = name.slice(name.lastIndexOf('/') + 1);
  if (!id) throw new TypeError('Firestore document kimliği boş.');
  // Keep the REST resource ID authoritative even if the document has an `id` field.
  return { ...decodeFirestoreFields(document.fields ?? {}), id };
}

/**
 * Fetch all pages from a Firestore list endpoint.
 * fetchPage receives { pageSize, pageToken } and returns the parsed REST JSON.
 * Any HTTP/parse/fetch failure rejects the whole operation; partial rows never return.
 */
export async function listFirestorePages(fetchPage, { pageSize = 1000 } = {}) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage fonksiyonu gerekli.');
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize pozitif tam sayı olmalı.');

  const documents = [];
  const seenTokens = new Set();
  let pageToken = '';

  while (true) {
    const page = await fetchPage({ pageSize, pageToken: pageToken || undefined });
    if (!page || typeof page !== 'object' || Array.isArray(page)) {
      throw new TypeError('Firestore liste yanıtı geçersiz.');
    }
    const pageDocuments = page.documents ?? [];
    if (!Array.isArray(pageDocuments)) throw new TypeError('Firestore documents alanı dizi değil.');
    documents.push(...pageDocuments);

    const nextPageToken = page.nextPageToken;
    if (nextPageToken === undefined || nextPageToken === null || nextPageToken === '') return documents;
    if (typeof nextPageToken !== 'string' || seenTokens.has(nextPageToken) || nextPageToken === pageToken) {
      throw new Error('Firestore sayfalama tokenı geçersiz veya tekrar ediyor.');
    }
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
}
