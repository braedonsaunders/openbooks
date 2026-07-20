/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(['N/file', 'N/format', 'N/query', 'N/record', 'N/runtime', 'N/search', 'N/task'],
  (file, format, query, record, runtime, search, task) => {
    const BRIDGE_VERSION = '1.0.0';
    const SCHEMA_VERSION = 1;
    const MARKER_PATH = 'SuiteScripts/OpenBooks/Jobs/bridge-marker.json';
    const EXPORT_SCRIPT_ID = 'customscript_openbooks_export_mr';
    const EXPORT_DEPLOYMENT_ID = 'customdeploy_openbooks_export_mr';
    const MAX_PAGE_SIZE = 500;
    const MAX_PARTITIONS = 250;

    const text = (value) => value == null ? '' : String(value);
    const assert = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const safeId = (value, label) => {
      const id = text(value);
      assert(/^[A-Za-z0-9_.:-]{1,160}$/.test(id), `${label} is invalid`);
      return id;
    };
    const safeSelect = (value) => {
      const sql = text(value).trim();
      assert(sql.length > 0 && sql.length <= 150000, 'sql is required and must be at most 150000 characters');
      assert(/^(select|with)\b/i.test(sql), 'only SELECT queries are supported');
      assert(!/;|--|\/\*/.test(sql), 'sql comments and statement separators are not supported');
      return sql;
    };
    const jobsFolder = () => file.load({ id: MARKER_PATH }).folder;
    const normalize = (value) => {
      if (value instanceof Date) return value.toISOString();
      if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
      if (typeof value === 'number') return String(value);
      if (Array.isArray(value)) return value.map(normalize);
      if (typeof value === 'object') {
        const out = {};
        Object.keys(value).forEach((key) => { out[key] = normalize(value[key]); });
        return out;
      }
      return text(value);
    };

    const health = () => {
      const script = runtime.getCurrentScript();
      const user = runtime.getCurrentUser();
      const featureIds = ['SUBSIDIARIES', 'MULTIBOOK', 'MULTICURRENCY', 'SUITETAX', 'DEPARTMENTS', 'CLASSES', 'LOCATIONS'];
      const features = {};
      featureIds.forEach((id) => {
        try { features[id.toLowerCase()] = runtime.isFeatureInEffect({ feature: id }); }
        catch (_) { features[id.toLowerCase()] = null; }
      });
      const now = query.runSuiteQL({ query: "SELECT TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') AS now FROM DUAL" })
        .asMappedResults()[0].now;
      return {
        ok: true,
        bridgeVersion: BRIDGE_VERSION,
        schemaVersion: SCHEMA_VERSION,
        accountId: runtime.accountId,
        environment: runtime.envType,
        role: { id: text(user.role), name: text(user.roleId) },
        serverTime: now,
        features,
        remainingUsage: script.getRemainingUsage(),
      };
    };

    const suiteql = (input) => {
      const sql = safeSelect(input.sql);
      const pageSize = Math.max(5, Math.min(MAX_PAGE_SIZE, Number(input.pageSize || MAX_PAGE_SIZE)));
      const pageIndex = Math.max(0, Number(input.pageIndex || 0));
      const params = Array.isArray(input.params) ? input.params : undefined;
      const paged = query.runSuiteQLPaged({
        query: sql,
        pageSize,
        ...(params ? { params } : {}),
      });
      if (pageIndex >= paged.pageRanges.length) {
        return { schemaVersion: SCHEMA_VERSION, pageIndex, pageSize, totalRows: paged.count, hasMore: false, rows: [] };
      }
      const rows = paged.fetch({ index: pageIndex }).data.asMappedResults().map(normalize);
      return {
        schemaVersion: SCHEMA_VERSION,
        pageIndex,
        pageSize,
        totalRows: paged.count,
        hasMore: pageIndex + 1 < paged.pageRanges.length,
        rows,
      };
    };

    const recordSnapshot = (input) => {
      const recordType = safeId(input.recordType, 'recordType');
      const internalId = safeId(input.internalId, 'internalId');
      const loaded = record.load({ type: recordType, id: internalId, isDynamic: false });
      const fields = {};
      loaded.getFields().forEach((fieldId) => {
        try { fields[fieldId] = normalize(loaded.getValue({ fieldId })); }
        catch (_) { fields[fieldId] = null; }
      });
      const sublists = {};
      loaded.getSublists().forEach((sublistId) => {
        const lineCount = loaded.getLineCount({ sublistId });
        const fieldIds = loaded.getSublistFields({ sublistId });
        const lines = [];
        for (let line = 0; line < lineCount; line += 1) {
          const values = {};
          fieldIds.forEach((fieldId) => {
            try { values[fieldId] = normalize(loaded.getSublistValue({ sublistId, fieldId, line })); }
            catch (_) { values[fieldId] = null; }
          });
          lines.push(values);
        }
        sublists[sublistId] = lines;
      });
      return { schemaVersion: SCHEMA_VERSION, recordType, internalId, fields, sublists };
    };

    const deletedRecords = (input) => {
      const since = text(input.since);
      assert(/^\d{4}-\d{2}-\d{2}/.test(since), 'since must be an ISO date or timestamp');
      const sinceDate = new Date(`${since.slice(0, 10)}T00:00:00Z`);
      const localDate = format.format({ value: sinceDate, type: format.Type.DATE });
      const filters = [['deleteddate', 'onorafter', localDate]];
      if (input.recordType) filters.push('AND', ['recordtype', 'is', text(input.recordType)]);
      const deleted = search.create({
        type: 'deletedrecord',
        filters,
        columns: ['deleteddate', 'recordtype', 'name'],
      });
      const rows = [];
      deleted.runPaged({ pageSize: 1000 }).pageRanges.forEach((range) => {
        deleted.runPaged({ pageSize: 1000 }).fetch({ index: range.index }).data.forEach((result) => {
          rows.push({
            internalId: text(result.id),
            deletedAt: text(result.getValue({ name: 'deleteddate' })),
            recordType: text(result.getValue({ name: 'recordtype' })),
            name: text(result.getValue({ name: 'name' })),
            externalId: '',
          });
        });
      });
      return { schemaVersion: SCHEMA_VERSION, rows };
    };

    const paymentTerms = () => {
      const termSearch = search.create({
        type: search.Type.TERM || 'term',
        columns: ['internalid', 'name', 'daysuntilnetdue', 'discountpercent', 'daysuntilexpiry'],
      });
      const rows = [];
      termSearch.run().each((result) => {
        rows.push({
          id: text(result.getValue({ name: 'internalid' }) || result.id),
          name: text(result.getValue({ name: 'name' })),
          netDays: Number(result.getValue({ name: 'daysuntilnetdue' }) || 0),
          discountPercent: text(result.getValue({ name: 'discountpercent' })) || null,
          discountDays: Number(result.getValue({ name: 'daysuntilexpiry' }) || 0) || null,
        });
        return true;
      });
      return { schemaVersion: SCHEMA_VERSION, rows };
    };

    const startExport = (input) => {
      const jobId = safeId(input.jobId, 'jobId');
      assert(Array.isArray(input.partitions) && input.partitions.length > 0, 'partitions are required');
      assert(input.partitions.length <= MAX_PARTITIONS, `at most ${MAX_PARTITIONS} partitions are supported per job`);
      const folder = jobsFolder();
      input.partitions.forEach((partition, index) => {
        const partId = safeId(partition.id || String(index + 1), 'partition id');
        const request = {
          schemaVersion: SCHEMA_VERSION,
          jobId,
          partId,
          sql: safeSelect(partition.sql),
          params: Array.isArray(partition.params) ? partition.params : undefined,
          pageSize: Math.max(50, Math.min(1000, Number(partition.pageSize || 1000))),
          createdAt: new Date().toISOString(),
        };
        file.create({
          name: `ob-request-${jobId}-${partId}.json`,
          fileType: file.Type.JSON,
          contents: JSON.stringify(request),
          folder,
          isOnline: false,
        }).save();
      });
      const exportTask = task.create({ taskType: task.TaskType.MAP_REDUCE });
      exportTask.scriptId = EXPORT_SCRIPT_ID;
      exportTask.deploymentId = EXPORT_DEPLOYMENT_ID;
      return { schemaVersion: SCHEMA_VERSION, jobId, taskId: exportTask.submit(), partitions: input.partitions.length };
    };

    const exportFiles = (input) => {
      const jobId = safeId(input.jobId, 'jobId');
      const folder = jobsFolder();
      const rows = [];
      search.create({
        type: 'file',
        filters: [['folder', 'anyof', folder], 'AND', ['name', 'contains', jobId]],
        columns: ['name', 'documentsize', 'created', 'modified'],
      }).run().each((result) => {
        rows.push({
          id: text(result.id),
          name: text(result.getValue({ name: 'name' })),
          size: Number(result.getValue({ name: 'documentsize' }) || 0),
          createdAt: text(result.getValue({ name: 'created' })),
          modifiedAt: text(result.getValue({ name: 'modified' })),
        });
        return true;
      });
      rows.sort((a, b) => a.name.localeCompare(b.name));
      const failed = rows.some((row) => row.name.includes('-error'));
      const pending = rows.some((row) => row.name.startsWith('ob-request-'));
      return { schemaVersion: SCHEMA_VERSION, jobId, status: failed ? 'failed' : pending ? 'running' : 'complete', files: rows };
    };

    const readChunk = (input) => {
      const fileId = safeId(input.fileId, 'fileId');
      const loaded = file.load({ id: fileId });
      assert(Number(loaded.folder) === Number(jobsFolder()), 'file is outside the OpenBooks export workspace');
      assert(loaded.size <= 9 * 1024 * 1024, 'file exceeds the RESTlet response limit');
      return { schemaVersion: SCHEMA_VERSION, fileId, name: loaded.name, contents: loaded.getContents() };
    };

    const deleteExport = (input) => {
      const state = exportFiles(input);
      state.files.forEach((item) => file.delete({ id: item.id }));
      return { schemaVersion: SCHEMA_VERSION, jobId: state.jobId, deleted: state.files.length };
    };

    const dispatch = (input) => {
      try {
        const action = text(input && input.action || 'health');
        if (action === 'health') return health();
        if (action === 'query') return suiteql(input);
        if (action === 'record') return recordSnapshot(input);
        if (action === 'paymentTerms') return paymentTerms();
        if (action === 'deleted') return deletedRecords(input);
        if (action === 'startExport') return startExport(input);
        if (action === 'exportStatus') return exportFiles(input);
        if (action === 'readChunk') return readChunk(input);
        if (action === 'deleteExport') return deleteExport(input);
        throw new Error(`unsupported action ${action}`);
      } catch (error) {
        return {
          ok: false,
          schemaVersion: SCHEMA_VERSION,
          error: error && error.message ? error.message : String(error),
          name: error && error.name ? error.name : 'Error',
        };
      }
    };

    return { get: dispatch, post: dispatch };
  });
