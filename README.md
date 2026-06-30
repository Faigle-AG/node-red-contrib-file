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

For `read`, the file content is returned as `msg.file.data`.

For `exists`, the result is returned as `msg.file.exists`.

For `stat`, the result is returned as `msg.file.stats`.

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

## Dynamic Mode

All nodes support **Load from `msg.file`** mode.

When enabled, the node ignores the configured editor fields and reads the operation details from `msg.file`. This allows flows to decide file operations at runtime.

## Output

Each node writes normalized file metadata to `msg.file`, including:

- `filetype`
- `path`
- `dir`
- `base`
- `name`
- `ext`

Additional fields depend on the node and action:

- `file-read`: `data`, `exists`, or `stats`
- `file-write`: written file metadata
- `file-transfer`: `action`, `source`, and `destination`
