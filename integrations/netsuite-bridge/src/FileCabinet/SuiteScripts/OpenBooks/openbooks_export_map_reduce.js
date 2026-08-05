/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 */
define(['N/file', 'N/query', 'N/search'], (file, query, search) => {
  const SCHEMA_VERSION = 1;
  const MARKER_PATH = 'SuiteScripts/OpenBooks/Jobs/bridge-marker.json';
  const jobsFolder = () => file.load({ id: MARKER_PATH }).folder;
  const normalize = (value) => {
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === 'object') {
      const out = {};
      Object.keys(value).forEach((key) => { out[key] = normalize(value[key]); });
      return out;
    }
    return String(value);
  };

  const getInputData = () => search.create({
    type: 'file',
    filters: [['folder', 'anyof', jobsFolder()], 'AND', ['name', 'startswith', 'ob-request-']],
    columns: ['internalid', 'name'],
  });

  const saveJson = (name, body) => file.create({
    name,
    fileType: file.Type.JSON,
    contents: JSON.stringify(body),
    folder: jobsFolder(),
    isOnline: false,
  }).save();

  const map = (context) => {
    const searchResult = JSON.parse(context.value);
    const requestFile = file.load({ id: searchResult.id });
    const request = JSON.parse(requestFile.getContents());
    const jobId = String(request.jobId);
    const partId = String(request.partId);
    try {
      const queryOptions = {
        query: String(request.sql),
        pageSize: Math.max(50, Math.min(1000, Number(request.pageSize || 1000))),
      };
      if (Array.isArray(request.params)) queryOptions.params = request.params;
      const paged = query.runSuiteQLPaged(queryOptions);
      let rows = 0;
      const chunks = [];
      let buffered = [];
      let chunkIndex = 0;
      const flush = () => {
        if (buffered.length === 0) return;
        const name = `ob-chunk-${jobId}-${partId}-${String(chunkIndex).padStart(6, '0')}.json`;
        const id = saveJson(name, {
          schemaVersion: SCHEMA_VERSION,
          jobId,
          partId,
          pageIndex: chunkIndex,
          rows: buffered,
        });
        chunks.push({ id: String(id), name, rows: buffered.length });
        chunkIndex += 1;
        buffered = [];
      };
      paged.pageRanges.forEach((range) => {
        const values = paged.fetch({ index: range.index }).data.asMappedResults().map(normalize);
        rows += values.length;
        const candidate = buffered.concat(values);
        const candidateBytes = JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          jobId,
          partId,
          pageIndex: chunkIndex,
          rows: candidate,
        }).length;
        // Consolidate SuiteQL pages to reduce RESTlet round-trips, while
        // staying comfortably below the 9 MB authenticated read limit.
        if (buffered.length > 0 && (candidate.length > 5000 || candidateBytes > 3 * 1024 * 1024)) flush();
        buffered.push(...values);
        if (buffered.length >= 5000) flush();
      });
      flush();
      requestFile.name = `ob-complete-${jobId}-${partId}.json`;
      requestFile.save();
      context.write({ key: jobId, value: JSON.stringify({ partId, status: 'complete', rows, chunks }) });
    } catch (error) {
      saveJson(`ob-error-${jobId}-${partId}.json`, {
        schemaVersion: SCHEMA_VERSION,
        jobId,
        partId,
        error: error && error.message ? error.message : String(error),
      });
      requestFile.name = `ob-failed-${jobId}-${partId}.json`;
      requestFile.save();
      context.write({ key: jobId, value: JSON.stringify({ partId, status: 'failed', rows: 0, chunks: [] }) });
    }
  };

  const reduce = (context) => {
    const parts = context.values.map(JSON.parse).sort((a, b) => a.partId.localeCompare(b.partId));
    saveJson(`ob-summary-${context.key}.json`, {
      schemaVersion: SCHEMA_VERSION,
      jobId: context.key,
      status: parts.every((part) => part.status === 'complete') ? 'complete' : 'failed',
      rows: parts.reduce((sum, part) => sum + part.rows, 0),
      parts,
      finishedAt: new Date().toISOString(),
    });
  };

  return { getInputData, map, reduce };
});
