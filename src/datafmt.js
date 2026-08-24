'use strict';

// Shared data-file format helpers.
//
// Snapshot file (vigil-data.json) versions:
//   v1: { v:1, savedAt, targets: { id: { raw:[{t,v}], min1:[bucketObj], hour1:[bucketObj] } } }
//       bucketObj = { t, min, max, sum, count, lost }
//   v2: { v:2, savedAt, targets: { id: { raw:[[t,v]], min1:[bucketArr], hour1:[bucketArr] } } }
//       bucketArr = [t, min, max, sum, count, lost]  (position-encoded, ~45% smaller)
//
// Everything that reads the file goes through normalizeDataFile(), which
// accepts either version and returns v1-shaped objects, so the app and the
// report tools never need to know which version is on disk. An unknown
// (future) version returns null: callers must refuse to touch the file
// rather than misread or overwrite it.

const r2 = (x) => Math.round(x * 100) / 100;

// min/max are Infinity/-Infinity in an all-lost bucket; JSON turns those into
// null, which is also what v1 files contain, and readers already guard with
// count > 0 before using them.
function packBucket(b) {
  return [b.t, Number.isFinite(b.min) ? r2(b.min) : null, Number.isFinite(b.max) ? r2(b.max) : null, r2(b.sum), b.count, b.lost];
}

function unpackBucket(a) {
  return { t: a[0], min: a[1], max: a[2], sum: a[3] || 0, count: a[4] || 0, lost: a[5] || 0 };
}

const validSampleObj = (s) => s && Number.isFinite(s.t) && (s.v === null || Number.isFinite(s.v));
const validSampleArr = (a) => Array.isArray(a) && Number.isFinite(a[0]) && (a[1] === null || Number.isFinite(a[1]));
const validBucketArr = (a) => Array.isArray(a) && a.length >= 6 && Number.isFinite(a[0]);
const validBucketObj = (b) => b && Number.isFinite(b.t);

function normalizeDataFile(data) {
  if (!data || !data.targets) return null;
  const targets = {};
  if (data.v === 1) {
    for (const [id, t] of Object.entries(data.targets)) {
      targets[id] = {
        raw: Array.isArray(t.raw) ? t.raw.filter(validSampleObj) : [],
        min1: Array.isArray(t.min1) ? t.min1.filter(validBucketObj) : [],
        hour1: Array.isArray(t.hour1) ? t.hour1.filter(validBucketObj) : [],
      };
    }
    return { v: 1, savedAt: data.savedAt, targets };
  }
  if (data.v === 2) {
    for (const [id, t] of Object.entries(data.targets)) {
      targets[id] = {
        raw: (Array.isArray(t.raw) ? t.raw : []).filter(validSampleArr).map((a) => ({ t: a[0], v: a[1] })),
        min1: (Array.isArray(t.min1) ? t.min1 : []).filter(validBucketArr).map(unpackBucket),
        hour1: (Array.isArray(t.hour1) ? t.hour1 : []).filter(validBucketArr).map(unpackBucket),
      };
    }
    return { v: 2, savedAt: data.savedAt, targets };
  }
  return null; // unknown future version
}

module.exports = { packBucket, unpackBucket, normalizeDataFile, r2 };
