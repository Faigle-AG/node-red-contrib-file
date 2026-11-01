# @faigle/node-red-contrib-file

Improved file handling nodes for Node-RED.

This package was generated from [node-red-contrib-template](https://github.com/Faigle-AG/node-red-contrib-_template_).

It provides three storage nodes for common filesystem operations:

- **file-read** — read files, check whether a file exists, or retrieve file statistics
- **file-write** — write or append data to files
- **file-transfer** — move, rename, copy, or delete files

## Nodes

### file-read

Reads a file from the filesystem, checks whether it exists, or returns file statistics.

Supported actions:

- `read`
- `exists`
- `stat`

Dynamic input example:

```js
msg.file = {
    action: 'read',
    path: '/tmp/example.txt',
};
return msg;
```

With the default **Output To: msg.file**, `read` returns `msg.file.data`, `exists` returns `msg.file.exists`, and `stat` returns `msg.file.stats`. A custom output property receives the whole result object instead.

---

### file-write

Writes or appends data to a file.

Supported actions:

- `write`
- `append`

The node can create the target directory automatically when enabled.

Dynamic input example:

```js
msg.file = {
    action: 'write',
    path: '/tmp/example.txt',
    data: 'Hello world',
};
return msg;
```

Objects passed as data are serialized with `JSON.stringify()`.

---

### file-transfer

Moves, renames, copies, or deletes files.

Supported actions:

- `move`
- `copy`
- `delete`

For move and copy operations, the destination path must include the target filename. The node can create the destination directory automatically when enabled.

Dynamic copy example:

```js
msg.file = {
    action: 'copy',
    source: '/tmp/source.txt',
    destination: '/tmp/archive/source.txt',
};
return msg;
```

Dynamic delete example:

```js
msg.file = {
    action: 'delete',
    source: '/tmp/source.txt',
};
return msg;
```

## Storage Message Protocol (msg.file)

These nodes share the `msg.file` request vocabulary with the directory nodes and Azure Files nodes. This is a common vocabulary, not a guarantee that every provider has identical results. Existing output routes and filesystem error behavior are preserved.

### Requests and typed fields

Enable **Load from msg.file** to use the following dynamic fields. In this mode, operation fields come from the message; the file-read **Output To** configuration still applies. Otherwise, operation fields come from the editor's typed properties.

| Node          | Action                   | Required dynamic fields           | Optional fields             |
| ------------- | ------------------------ | --------------------------------- | --------------------------- |
| file-read     | `read`, `exists`, `stat` | `action`, `path`                  | Combine actions as an array |
| file-write    | `write`, `append`        | `action`, `path`, `data`          | `createDir`                 |
| file-transfer | `copy`, `move`           | `action`, `source`, `destination` | `createDir`                 |
| file-transfer | `delete`                 | `action`, `source`                | Destination is ignored      |

Use exact lowercase action names. A portable read combination is `['read', 'exists', 'stat']`; literal-boolean action objects such as `{read: true, stat: true}` are also supported. Local legacy string parsing matches substrings and can select unintended actions; use exact names or arrays in new flows. Read operations share one success/error outcome, not one output per action.

Dynamic `createDir` does not inherit the editor checkbox; send `true` explicitly when parent creation is wanted. Paths are literal resource paths, not message-property names. Transfer destinations include the target filename.

```js
// file-read, Load from msg.file enabled; Output To: msg.file
msg.file = { action: ['read', 'stat'], path: '/data/in/report.txt' };
return msg;
```

```js
// file-write, Load from msg.file enabled
msg.file = {
    action: 'write',
    path: '/data/out/report.txt',
    data: '', // Empty files are valid.
    createDir: true,
};
return msg;
```

```js
// file-transfer, Load from msg.file enabled
msg.file = {
    action: 'copy',
    source: '/data/in/report.txt',
    destination: '/data/archive/report.txt',
    createDir: true,
};
return msg;
```

Configured input paths support `msg`, `flow`, `global`, `str`, `jsonata`, and `env`; write data also offers `json` and `bin`. Read output supports `msg`, `flow`, and `global`; it defaults to `msg.file`. Write data defaults to the typed property `msg.file.data`. For the default static `file.data` setting, `msg.file = {}` resolves to an empty string and writes an empty file; omitting `msg.file` entirely instead causes a TypeError with code `DATA_MISSING` and writes nothing. Successful typed resolutions of undefined/null become an empty string. Dynamic `msg.file.data` is read directly: missing data errors, while `null` writes the text `null`. Strings and Buffers are supported; non-Buffer objects are JSON-stringified. Numeric/boolean data, whether resolved from a typed field or supplied dynamically, is rejected by the local filesystem API with `ERR_INVALID_ARG_TYPE`, unlike Azure's scalar-to-string conversion. Empty string and zero-length Buffer are valid.

#### Typed-input reference

Defaults below describe newly configured editor nodes, not migrations of older saved flows.

| Node            | Field                | Offered types                                                   | Editor default     |
| --------------- | -------------------- | --------------------------------------------------------------- | ------------------ |
| `file-read`     | `source`             | `msg`, `flow`, `global`, `str`, `jsonata`, `env`                | `str`, empty       |
| `file-read`     | `target` (Output To) | `msg`, `flow`, `global`                                         | `msg`, `file`      |
| `file-write`    | `target` (File name) | `msg`, `flow`, `global`, `str`, `jsonata`, `env`                | `str`, empty       |
| `file-write`    | `data`               | `msg`, `flow`, `global`, `str`, `json`, `bin`, `jsonata`, `env` | `msg`, `file.data` |
| `file-transfer` | `source`             | `msg`, `flow`, `global`, `str`, `jsonata`, `env`                | `str`, empty       |
| `file-transfer` | `destination`        | `msg`, `flow`, `global`, `str`, `jsonata`, `env`                | `str`, empty       |

For write data, a `json` object or array is serialized to JSON text; a JSON string literal such as `"plain"` writes the plain string. A `bin` literal such as `[0,255,104]` writes those bytes. JSON numbers and booleans are not converted to text. A successfully evaluated JSON `null` becomes an empty string through the property helper and writes an empty file; this differs from direct dynamic `msg.file.data: null`, which writes `null` as described above.

For `flow` and `global`, Node-RED's encoded key syntax can select a named context store, for example `#:(storeName)::result`. The store must be configured in Node-RED; availability and persistence depend on that backend.

**Saved-flow compatibility:** Existing field names, saved type defaults and runtime value fallbacks remain. The data widget's declared fallback now agrees with its existing `msg` saved/runtime default; an explicit saved `str` setting is not changed. Missing or empty static `data` still falls back to `file.data`.

Active fields now reject unoffered type tags before property evaluation or filesystem work. This intentionally rejects some hand-edited or imported configurations that previously worked. Static fields bypassed by **Load from msg.file** are not checked, but file-read's output routing remains active. A static delete's destination type is not checked, although the existing implementation still evaluates the configured destination value. These are type-tag checks, not a filesystem sandbox or a guarantee that a later context write succeeds.

### Outputs

Common metadata contains `filetype`, normalized `path`, `dir`, `base`, `name`, and `ext`.

- **Read:** merges metadata and requested `data` (Buffer), `exists` (boolean), or `stats` (native `fs.Stats`) into the configured output property. It does not force data into `msg.payload` or force metadata into `msg.file` when another target is selected.
- **Write/append:** merges path metadata into `msg.file`, preserving other message fields.
- **Copy/move:** merges metadata plus `action`, `source`, `destination`; `path` is the destination. When normalized source and destination are identical, the node forwards the message unchanged without checking whether the source exists.
- **Delete:** success merges source metadata, sets `destination: null`, and sets `msg.payload = true`. A missing source is an error, unlike Azure Files' delete-if-exists result.

For compatibility, file-transfer's same-path no-op occurs before checking whether a non-delete action is supported; such a no-op performs no storage operation. Other unknown mutation actions error before creating parents.

Merges preserve custom fields and can retain results from earlier operations. Only fields requested and computed by the current operation should be treated as fresh results. File stats include native methods and are not equivalent to Azure's plain metadata object.

### Errors and operational boundaries

Errors go to Node-RED's error/Catch mechanism rather than the normal output. The original message accompanies input failures. `msg.error.code` identifies missing action/path/data and invalid mutation actions; native filesystem codes are preserved, while other evaluation errors may remain uncoded. Adding validation codes does not change their existing Status-node text. A Status node observes status text separately; it is not a substitute for Catch error handling.

| Condition                                                   | Current result                                                                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exists-only request for a missing file                      | Success, `exists: false`                                                                                                                                                                                    |
| Read/stat request for a missing file                        | Error, normally `ENOENT`; no normal output                                                                                                                                                                  |
| Delete request for a missing file                           | Error, normally `ENOENT`                                                                                                                                                                                    |
| Filesystem permission failure                               | Native error such as `EACCES` or `EPERM`; exists-only can return false instead                                                                                                                              |
| Missing dynamic action/path/data or unknown mutation action | `ACTION_MISSING`, `SOURCE_PATH_MISSING`, `TARGET_PATH_MISSING`, `DESTINATION_PATH_MISSING`, `DATA_MISSING` or `INVALID_ACTION`, as applicable; unknown mutation actions are rejected before parent creation |
| Default static `file.data` with no `msg.file` object        | TypeError with `DATA_MISSING`; no file written; status remains `Configuration error`                                                                                                                        |
| Unrecognized read token                                     | Legacy parser may perform no actions and forward metadata; use documented tokens                                                                                                                            |
| Non-string file-read path                                   | `INVALID_PATH`; falsy path values are reported as missing                                                                                                                                                   |
| Unsupported active path/data type                           | `INVALID_CONFIGURATION`; no filesystem operation starts                                                                                                                                                     |
| Unsupported file-read output type                           | Uncoded `Unsupported target property type: ...` error before reading the file                                                                                                                               |
| Typed output/context failure                                | Error; a storage operation may already have happened                                                                                                                                                        |

Paths use the host operating system's `path.normalize`. Relative paths, absolute paths and dot segments are allowed; significant spaces are not trimmed. **This is not a filesystem sandbox.** Validate untrusted paths in the flow, restrict the runtime account's permissions, and avoid directing writable input at sensitive files.

Writes, appends, copies and cross-device moves are not transactional. A failed operation may have changed the destination; inspect it before retrying. Cross-device move falls back to copy followed by source deletion. Do not assume an error means nothing was written, or automatically retry an append. The nodes do not coordinate concurrent writers.

### Shutdown

When a node closes while resolving configured paths or data, it starts no filesystem operation after those reads settle. File-read also checks before starting its configured output write. Late continuations normally finish the input quietly, without a new output message, status update or error report. A blocked cross-device move fallback reports an error instead, as described below.

Already-started filesystem and context operations are not cancelled or rolled back. A write, append, copy, deletion or context update may still take effect after close even though no normal result is forwarded. Do not infer from silence that an operation did not happen, or automatically retry a write or append.

**Cross-device file move:** the `EXDEV` fallback copies the file and then deletes its source. If close is observed before starting the copy, or when the copy callback arrives before source deletion has started, the node stops the fallback and reports `NODE_CLOSING` without a status update. If that copy callback reports a filesystem error, its original error is reported instead. Source deletion does not start after this stop, but the copy may already have created, overwritten or partially changed the destination.

If source deletion had already started when close occurred, it cannot be undone; its late callback follows the ordinary quiet-completion behavior. The source-preservation guarantee applies only when deletion has not started. Inspect both paths before retrying a cross-device move; shutdown is not a transactional rollback.
