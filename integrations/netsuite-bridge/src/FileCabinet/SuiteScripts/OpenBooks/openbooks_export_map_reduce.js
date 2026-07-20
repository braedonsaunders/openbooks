/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 */
define(['N/file', 'N/query', 'N/search'], (file, query, search) => {
  const SCHEMA_VERSION = 1;
  const MARKER_PATH = 'SuiteScripts/OpenBooks/Jobs/bridge-marker.json';
  const jobsFolder = () => file.load({ id: MARKER_PATH }).folder;

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
      paged.pageRanges.forEach((range) => {
        const values = paged.fetch({ index: range.index }).data.asMappedResults();
        rows += values.length;
        const name = `ob-chunk-${jobId}-${partId}-${String(range.index).padStart(6, '0')}.json`;
        const id = saveJson(name, {
          schemaVersion: SCHEMA_VERSION,
          jobId,
          partId,
          pageIndex: range.index,
          rows: values,
        });
        chunks.push({ id: String(id), name, rows: values.length });
      });
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
